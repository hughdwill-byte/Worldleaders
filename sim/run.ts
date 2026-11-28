// Runs on disk: runs/<id>/meta.json, turns/NNNN.json.gz, events.jsonl, series.json, agents/<turn>/<ISO3>.json, pending.json.
// A turn collects every active leader's decision first (saved after each one, so a quota stop resumes exactly),
// then the engine resolves the month deterministically.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AgentResponse, Incentives, SimEvent, World } from '../engine/types.ts';
import { DEV_COUNTRIES, initWorld, loadStatics, strength } from '../engine/world.ts';
import { initialScores, runTurn } from '../engine/turn.ts';
import { MAX_AGENTS_PER_TURN, QUARTERLY_REVIEW_EVERY } from '../engine/constants.ts';
import { isDemocracy } from '../engine/regime.ts';
import { monthLabel } from '../engine/util.ts';
import { buildReport } from './report.ts';
import { decide, draftConstitution, flavour, narrative } from '../agents/index.ts';
import { autopilot } from '../agents/autopilot.ts';
import { mockDecide } from '../agents/mock.ts';
import { ProviderUnavailable, QuotaExhausted, SpendLimit, config, quotaLeft } from '../agents/llm.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const RUNS = process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.join(ROOT, 'runs'); // RUNS_DIR: tests use a temp folder

export interface Meta {
  id: string; name: string; seed: number; createdAt: string; startDate: string;
  provider: string; model: string; countries: 'all' | 'dev';
  parent: { id: string; turn: number } | null; preset: string | null; weights?: WeightSpec | null;
  lastTurn: number; lock: { by: string; since: string } | null; updatedAt?: string;
  costUsd: number; requests: number; stoppedReason?: string; parseFailures?: number; secondsPerMonth?: number;
  cadence?: 'monthly' | 'quarterly';  // quarterly: AI leaders decide every 3rd month; standing orders run in between
}
export interface ProgressInfo { runId: string; turn: number; month: string; done: number; total: number; message: string }
export type OnProgress = (p: ProgressInfo) => void;

const dir = (id: string) => path.join(RUNS, id);
const pad = (t: number) => String(t).padStart(4, '0');
export const readMeta = (id: string): Meta => JSON.parse(fs.readFileSync(path.join(dir(id), 'meta.json'), 'utf8'));
const writeMeta = (m: Meta) => fs.writeFileSync(path.join(dir(m.id), 'meta.json'), JSON.stringify(m, null, 1));
const writeAtomic = (f: string, data: string | Buffer) => { fs.writeFileSync(f + '.tmp', data); fs.renameSync(f + '.tmp', f); };

export function saveSnapshot(id: string, w: World) {
  fs.mkdirSync(path.join(dir(id), 'turns'), { recursive: true });
  // ponytail: numbers rounded to 6 significant digits on save; every turn starts from the saved file, so resumed and uninterrupted runs stay identical
  const json = JSON.stringify(w, (_, v) => typeof v === 'number' && !Number.isInteger(v) ? (Math.abs(v) >= 1e5 ? Math.round(v) : +v.toPrecision(6)) : v);
  writeAtomic(path.join(dir(id), 'turns', pad(w.turn) + '.json.gz'), zlib.gzipSync(json));
}
export function loadSnapshot(id: string, turn: number): World {
  return migrate(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir(id), 'turns', pad(turn) + '.json.gz'))).toString()));
}
/** Fill fields added after a run was created, so old runs keep going. */
function migrate(w: World): World {
  w.commitments ??= [];
  for (const c of Object.values(w.countries)) {
    c.protestMonths ??= 0; c.unrestRise ??= 0; c.escalation ??= 0; c.coopActs ??= 0; c.hostileActs ??= 0;
    c.standingOrders ??= []; c.lastReview ??= null; c.lastDefectionTurn ??= null; c.lastCoupTurn ??= null; c.lastCivilWarTurn ??= null;
  }
  return w;
}
function readEvents(id: string, turn?: number): SimEvent[] {
  const f = path.join(dir(id), 'events.jsonl'); if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter((e: SimEvent) => turn === undefined || e.turn === turn);
}

export const PRESETS: Record<string, Incentives> = {
  welfare: { welfare: 1, approval: 0, survival: 0, power: 0 }, approval: { welfare: 0, approval: 1, survival: 0, power: 0 },
  survival: { welfare: 0, approval: 0, survival: 1, power: 0 }, power: { welfare: 0, approval: 0, survival: 0, power: 1 },
  equal: { welfare: 0.25, approval: 0.25, survival: 0.25, power: 0.25 },
};
/**
 * Incentive overrides. Keys: '*' (everyone), '@democracies', '@autocracies', '@<govType>' (e.g. '@military_junta'),
 * or an ISO3 code. Applied in that order (most specific last), after the preset. Weights are normalised to sum to 1.
 */
export type WeightSpec = Record<string, Partial<Incentives>>;
function norm(k: Partial<Incentives>): Incentives {
  const v = { welfare: Math.max(0, Number(k.welfare) || 0), approval: Math.max(0, Number(k.approval) || 0), survival: Math.max(0, Number(k.survival) || 0), power: Math.max(0, Number(k.power) || 0) };
  const t = v.welfare + v.approval + v.survival + v.power || 1;
  return { welfare: +(v.welfare / t).toFixed(3), approval: +(v.approval / t).toFixed(3), survival: +(v.survival / t).toFixed(3), power: +(v.power / t).toFixed(3) };
}
export function applyPreset(w: World, preset: string | null, weights?: WeightSpec) {
  if (preset) { const p = PRESETS[preset]; if (!p) throw new Error(`Unknown preset ${preset}. Use: ${Object.keys(PRESETS).join(', ')}`); for (const c of Object.values(w.countries)) c.incentives = { ...p }; }
  if (!weights) return;
  const rank = (k: string) => k === '*' ? 0 : k === '@democracies' || k === '@autocracies' ? 1 : k.startsWith('@') ? 2 : 3;
  for (const [key, k] of Object.entries(weights).sort((a, b) => rank(a[0]) - rank(b[0]))) {
    const hit = (c: World['countries'][string]) => key === '*' || key === c.iso3 || (key === '@democracies' && isDemocracy(c.govType)) || (key === '@autocracies' && !isDemocracy(c.govType)) || key === '@' + c.govType;
    for (const c of Object.values(w.countries)) if (hit(c)) c.incentives = norm(k);
  }
}
export const readWeights = (file?: string): WeightSpec | undefined => file ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;

export function createRun(o: { name: string; seed?: number; countries?: 'all' | 'dev'; preset?: string | null; weights?: WeightSpec; startDate?: string; cadence?: 'monthly' | 'quarterly' }): Meta {
  const id = `${o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run'}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  fs.mkdirSync(dir(id), { recursive: true });
  const seed = o.seed ?? Math.floor(Math.random() * 1e9);
  const w = initWorld({ seed, startDate: o.startDate });
  applyPreset(w, o.preset ?? null, o.weights);
  initialScores(w, loadStatics());
  const m: Meta = { id, name: o.name, cadence: o.cadence ?? 'monthly', weights: o.weights ?? null, seed, createdAt: new Date().toISOString(), startDate: w.startDate, provider: config.provider, model: config.model, countries: o.countries ?? (process.env.COUNTRIES === 'dev' ? 'dev' : 'all'), parent: null, preset: o.preset ?? null, lastTurn: 0, lock: null, costUsd: 0, requests: 0 };
  writeMeta(m); saveSnapshot(id, w); fs.writeFileSync(path.join(dir(id), 'events.jsonl'), '');
  fs.writeFileSync(path.join(dir(id), 'series.json'), JSON.stringify(emptySeries()));
  appendSeries(id, w, []);
  updateIndex(); buildReport(id);
  return m;
}

/** What-if branch: copy the snapshot at `from` into a new run, optionally changing incentive weights. */
export function branchRun(parentId: string, from: number, o: { name?: string; preset?: string | null; weights?: WeightSpec }): Meta {
  const p = readMeta(parentId);
  if (from > p.lastTurn) throw new Error(`Run ${parentId} only has months 0..${p.lastTurn}`);
  const name = o.name ?? `${p.name} branch@${from}${o.preset ? ' ' + o.preset : ''}`;
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  fs.mkdirSync(path.join(dir(id), 'turns'), { recursive: true });
  for (let t = 0; t < from; t++) fs.copyFileSync(path.join(dir(parentId), 'turns', pad(t) + '.json.gz'), path.join(dir(id), 'turns', pad(t) + '.json.gz'));
  const w = loadSnapshot(parentId, from);
  applyPreset(w, o.preset ?? null, o.weights);
  saveSnapshot(id, w);
  fs.writeFileSync(path.join(dir(id), 'events.jsonl'), readEvents(parentId).filter(e => e.turn < from).map(e => JSON.stringify(e) + '\n').join(''));
  const s = JSON.parse(fs.readFileSync(path.join(dir(parentId), 'series.json'), 'utf8'));
  truncateSeries(s, from + 1); fs.writeFileSync(path.join(dir(id), 'series.json'), JSON.stringify(s));
  const m: Meta = { ...p, id, name, createdAt: new Date().toISOString(), parent: { id: parentId, turn: from }, preset: o.preset ?? p.preset, weights: o.weights ?? null, lastTurn: from, lock: null, costUsd: 0, requests: 0, provider: config.provider, model: config.model };
  delete m.stoppedReason;
  writeMeta(m); updateIndex(); buildReport(id);
  return m;
}

export function listRuns(): Meta[] {
  if (!fs.existsSync(RUNS)) return [];
  // half-written runs (no series.json yet) are skipped
  return fs.readdirSync(RUNS).filter(d => fs.existsSync(path.join(RUNS, d, 'meta.json')) && fs.existsSync(path.join(RUNS, d, 'series.json'))).map(readMeta).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function updateIndex() { fs.mkdirSync(RUNS, { recursive: true }); fs.writeFileSync(path.join(RUNS, 'index.json'), JSON.stringify(listRuns().map(m => ({ ...m, lock: m.lock ? { ...m.lock } : null })), null, 1)); }

/** Countries that act this month: anything touched them, plus everyone on the quarterly review. Most urgent first. */
/** How urgent each country's situation is this month (events, cables, wars, sanctions, unrest, coup risk…). */
function urgencyScores(w: World, lastEvents: SimEvent[]): Record<string, number> {
  const urgency: Record<string, number> = {};
  const bump = (i: string, v: number) => { if (w.countries[i]?.alive) urgency[i] = (urgency[i] ?? 0) + v; };
  for (const e of lastEvents) for (const i of e.countries) bump(i, e.major ? 15 : 3);
  for (const cb of w.cables) bump(cb.to, DEV_COUNTRIES.includes(cb.from) ? 12 : 6);   // a cable from a major power awaits a reply
  for (const p of w.pendingProposals) bump(p.to, 8);
  for (const v of w.wars.filter(v => v.active)) for (const i of [...v.attackers, ...v.defenders]) bump(i, 30);
  for (const s of w.sanctions.filter(s => s.since >= w.turn - 1)) bump(s.target, 10);
  const risks = w.order.filter(i => w.countries[i].alive).map(i => w.countries[i].coupRisk).sort((a, b) => b - a);
  const p90 = risks[Math.floor(risks.length * 0.1)] ?? 1;
  for (const i of w.order) {
    const c = w.countries[i]; if (!c.alive) continue;
    if (c.stage >= 3) bump(i, c.stage * 8);
    if (c.coupRisk >= p90 && c.coupRisk > 0) bump(i, 20);                                // coup hazard in the top decile
    if (c.nextElection != null && c.nextElection - w.turn <= 1) bump(i, 6);
    if (c.provisionalUntil != null) bump(i, 10);
    if (lastEvents.some(e => e.type === 'disaster' && e.major && e.countries.includes(i))) bump(i, 15);
  }
  return urgency;
}

/** Mock runs: countries with something happening, plus everyone on the quarterly review. */
export function selectActive(w: World, lastEvents: SimEvent[]): string[] {
  const urgency = urgencyScores(w, lastEvents);
  const all = w.turn % QUARTERLY_REVIEW_EVERY === 0;
  const act = w.order.filter(i => w.countries[i].alive && (all || urgency[i]));
  act.sort((a, b) => (urgency[b] ?? 0) - (urgency[a] ?? 0) || w.countries[b].gdp - w.countries[a].gdp);
  return act.slice(0, MAX_AGENTS_PER_TURN);
}

export type Tier = 'A' | 'B' | 'C' | 'standing' | 'mock';
/**
 * Who the AI reviews this month (a fixed budget of LLM_CALLS_PER_MONTH, default 50):
 *  A = the 20 major countries, every month;  C = rotation so every country is reviewed at least every
 *  MAX_MONTHS_WITHOUT_REVIEW months (most overdue first);  B = triggered countries ranked by log(pop) × urgency.
 * Everyone else runs on autopilot (their own standing orders) or, if never reviewed, a rule-based leader.
 * dev mode: A only (+ rule-based leaders for the rest). Mock runs: rule-based leaders for active countries.
 */
export function planMonth(w: World, m: Meta, lastEvents: SimEvent[]): { llm: string[]; tiers: Record<string, Tier>; mock: string[]; standing: string[] } {
  const live = w.order.filter(i => w.countries[i].alive);
  const active = new Set(selectActive(w, lastEvents));
  const tiers: Record<string, Tier> = {};
  if (config.provider === 'mock') { for (const i of active) tiers[i] = 'mock'; return { llm: [], tiers, mock: [...active], standing: [] }; }
  const offMonth = m.cadence === 'quarterly' && w.turn % 3 !== 0;
  const A = offMonth ? [] : DEV_COUNTRIES.filter(i => w.countries[i]?.alive);
  let llm = [...A];
  if (m.countries !== 'dev' && !offMonth) {
    const budget = Number(process.env.LLM_CALLS_PER_MONTH || 50), maxGap = Number(process.env.MAX_MONTHS_WITHOUT_REVIEW || 12);
    const others = live.filter(i => !A.includes(i));
    const since = (i: string) => w.turn - (w.countries[i].lastReview ?? -1000 + w.order.indexOf(i)); // never reviewed: in list order
    const urgency = urgencyScores(w, lastEvents);
    const room = Math.max(0, budget - A.length);
    const cMin = Math.min(room, Math.ceil(others.length / maxGap));
    const rotation = [...others].sort((a, b) => since(b) - since(a));
    const C = rotation.slice(0, cMin);
    const B = others.filter(i => !C.includes(i) && urgency[i]).sort((a, b) => urgency[b] * Math.log(w.countries[b].pop + 10) - urgency[a] * Math.log(w.countries[a].pop + 10)).slice(0, room - C.length);
    const C2 = rotation.filter(i => !C.includes(i) && !B.includes(i)).slice(0, room - C.length - B.length);
    for (const i of B) tiers[i] = 'B';
    for (const i of [...C, ...C2]) tiers[i] = 'C';
    llm = [...A, ...B, ...C, ...C2];
  }
  for (const i of A) tiers[i] = 'A';
  const rest = live.filter(i => !llm.includes(i));
  const standing = rest.filter(i => w.countries[i].standingOrders?.length);
  const mock = rest.filter(i => !standing.includes(i) && active.has(i));
  for (const i of standing) tiers[i] = 'standing';
  for (const i of mock) tiers[i] = 'mock';
  return { llm, tiers, mock, standing };
}

export function estimate(id: string) {
  const m = readMeta(id), w = loadSnapshot(id, m.lastTurn);
  const plan = planMonth(w, m, readEvents(id, m.lastTurn - 1));
  const llm = plan.llm.length;
  return { month: monthLabel(w.startDate, w.turn), active: Object.keys(plan.tiers).length, requests: Math.ceil(llm * 1.05) + (llm ? 1 : 0), tokens: llm * 3500,
    minutes: +(llm / Math.max(1, config.rpm)).toFixed(1), quotaLeft: config.provider === 'mock' ? Infinity : quotaLeft() };
}

function lock(m: Meta, force: boolean) {
  if (m.lock && !force) throw new Error(`Run ${m.id} is locked by ${m.lock.by} since ${m.lock.since}. If that run is dead, use --force.`);
  m.lock = { by: process.env.GITHUB_ACTIONS ? `github-actions ${process.env.GITHUB_RUN_ID ?? ''}` : os.hostname(), since: new Date().toISOString() };
  writeMeta(m); updateIndex();
}
function unlock(id: string) { const m = readMeta(id); m.lock = null; writeMeta(m); updateIndex(); }

/**
 * Advance a run by up to `turns` months. Stops cleanly on: shouldStop() (pause), quota, spend limit, deadline.
 * Returns why it stopped.
 */
export async function step(id: string, o: { turns: number; force?: boolean; shouldStop?: () => boolean; onProgress?: OnProgress; deadline?: number }): Promise<string> {
  const s = loadStatics();
  let m = readMeta(id);
  // one model per run: a run always continues with the provider/model it started with (set FORCE_MODEL=1 to override)
  if (!process.env.FORCE_MODEL && (m.provider !== config.provider || m.model !== config.model)) {
    console.warn(`Run ${id} uses ${m.provider}/${m.model}; continuing with that instead of ${config.provider}/${config.model}.`);
    process.env.PROVIDER = m.provider; process.env.MODEL = m.model;
  }
  lock(m, !!o.force);
  let reason = 'done';
  try {
    for (let n = 0; n < o.turns; n++) {
      if (o.shouldStop?.()) { reason = 'paused'; break; }
      if (o.deadline && Date.now() > o.deadline) { reason = 'deadline'; break; }
      m = readMeta(id);
      const w = loadSnapshot(id, m.lastTurn);
      const month = monthLabel(w.startDate, w.turn);
      const pendFile = path.join(dir(id), 'pending.json');
      type Pend = { turn: number; plan: ReturnType<typeof planMonth>; decisions: Record<string, AgentResponse>; events: SimEvent[] };
      const saved = fs.existsSync(pendFile) ? JSON.parse(fs.readFileSync(pendFile, 'utf8')) : null;
      const pend: Pend = saved?.turn === w.turn && saved.plan ? saved : { turn: w.turn, plan: planMonth(w, m, readEvents(id, w.turn - 1)), decisions: {}, events: [] };
      const agentDir = path.join(dir(id), 'agents', pad(w.turn));
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, '_tiers.json'), JSON.stringify(pend.plan.tiers));
      const mockLog: Record<string, AgentResponse> = {};
      // autopilot (standing orders) and rule-based leaders: instant
      for (const iso of pend.plan.standing) if (!pend.decisions[iso]) { const r = autopilot(w, s, iso); if (r) { pend.decisions[iso] = r; mockLog[iso] = r; } }
      for (const iso of pend.plan.mock) if (!pend.decisions[iso]) { const r = mockDecide(w, s, iso); pend.decisions[iso] = r; mockLog[iso] = r; }
      // AI leaders: a pool of CONCURRENCY workers, in priority order (tier A first); progress saved after every answer
      const queue = pend.plan.llm.filter(i => !pend.decisions[i]);
      const total = pend.plan.llm.length;
      let stopped = false;
      const t0 = Date.now();
      const worker = async () => {
        while (!stopped && queue.length) {
          if (o.shouldStop?.()) { reason = 'paused'; stopped = true; return; }
          const iso = queue.shift()!;
          const prog = (message: string) => o.onProgress?.({ runId: id, turn: w.turn, month, done: pend.plan.llm.filter(i => pend.decisions[i]).length, total, message });
          prog(`${w.countries[iso].name} deciding`);
          try {
            const out = await decide(w, s, iso, true, msg => prog(msg), m.costUsd, pend.plan.tiers[iso] === 'C');
            pend.decisions[iso] = out.resp; pend.events.push(...out.events);
            fs.writeFileSync(path.join(agentDir, iso + '.json'), JSON.stringify({ ...out.log, tier: pend.plan.tiers[iso] }, null, 1));
            m.costUsd += out.costUsd; m.requests += (out.log.raw as string[]).length; m.parseFailures = (m.parseFailures ?? 0) + Number(out.log.parseFailures ?? 0);
            writeMeta(m); writeAtomic(pendFile, JSON.stringify(pend));
          } catch (e) {
            if (e instanceof QuotaExhausted || e instanceof SpendLimit) {
              if (!stopped) { reason = e instanceof SpendLimit ? 'spend_limit' : e instanceof ProviderUnavailable ? 'provider_unavailable' : 'quota'; prog(`stopped: ${(e as Error).message}`); }
              stopped = true; return;
            }
            throw e;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Number(process.env.CONCURRENCY || 4)) }, worker));
      writeAtomic(pendFile, JSON.stringify(pend));
      if (total && !stopped) { m.secondsPerMonth = Math.round((Date.now() - t0) / 1000); writeMeta(m); }
      if (Object.keys(mockLog).length) fs.writeFileSync(path.join(agentDir, '_mock.json'), JSON.stringify(mockLog));
      if (stopped) break;
      // resolve the month
      o.onProgress?.({ runId: id, turn: w.turn, month, done: total, total, message: 'resolving month' });
      const before = structuredClone(w.countries);
      const events = [...pend.events, ...runTurn(w, s, pend.decisions)];
      for (const iso of Object.keys(pend.decisions)) updateMemory(w, iso, pend.decisions[iso], before[iso], month);
      // constitutional drafting commission for new regimes (templates in mock mode)
      for (const c of Object.values(w.countries)) if (c.pendingDraft) {
        if (config.provider === 'mock') { c.pendingDraft = null; continue; }
        try { const r = await draftConstitution(w, s, c.iso3); fs.writeFileSync(path.join(agentDir, `${c.iso3}.constitution.json`), JSON.stringify(r.log, null, 1)); }
        catch (e) { if (!(e instanceof QuotaExhausted)) throw e; } // keep provisional template; retried next month
      }
      if (config.provider !== 'mock' && process.env.FLAVOUR !== 'off') {
        try { events.push(...await flavour(w, month, events)); } catch (e) { if (!(e instanceof QuotaExhausted)) console.warn('flavour text skipped:', (e as Error).message); }
      }
      if (config.provider !== 'mock' && process.env.NARRATIVE !== 'off') {
        try { events.push(...await narrative(month, events)); } catch (e) { if (!(e instanceof QuotaExhausted)) console.warn('narrative skipped:', (e as Error).message); }
      }
      saveSnapshot(id, w);
      fs.appendFileSync(path.join(dir(id), 'events.jsonl'), events.map(e => JSON.stringify(e) + '\n').join(''));
      appendSeries(id, w, events);
      if (fs.existsSync(pendFile)) fs.unlinkSync(pendFile);
      m = readMeta(id); m.lastTurn = w.turn; m.updatedAt = new Date().toISOString(); writeMeta(m);
      o.onProgress?.({ runId: id, turn: w.turn, month: monthLabel(w.startDate, w.turn), done: 0, total: 0, message: `${month} resolved: ${events.filter(e => e.major).length} major events` });
    }
  } finally {
    const mm = readMeta(id); mm.stoppedReason = reason; writeMeta(mm); unlock(id);
    try { buildReport(id); } catch (e) { console.warn('report.md not written:', (e as Error).message); }
  }
  return reason;
}

/** Rolling, rule-based memory of the leader's own decisions and outcomes (no extra LLM call). */
function updateMemory(w: World, iso: string, r: AgentResponse, before: World['countries'][string], month: string) {
  const c = w.countries[iso]; if (!c?.alive || !before) return;
  const did = r.directives.map(d => `${d.type.replace(/_/g, ' ')}${d.target ? ' ' + d.target : ''}`).slice(0, 6).join(', ') || 'no new orders';
  const rejected = c.rejections.length ? ` (${c.rejections.length} not executed)` : '';
  const outcome = `growth ${before.growth.toFixed(1)}→${c.growth.toFixed(1)}%, mood ${['calm', 'discontent', 'protests', 'strikes', 'riots', 'insurgency', 'civil war'][c.stage]}`;
  const lines = (c.leader.memory ? c.leader.memory.split('\n') : []);
  lines.push(`${month}: ${did}${rejected}; ${outcome}.`);
  c.leader.memory = lines.slice(-8).join('\n');
}

// ---- series.json: compact per-turn metrics for charts ----
const CKEYS = ['gdp', 'growth', 'inflation', 'unemployment', 'approval', 'stability', 'unrest', 'welfare', 'survival', 'power', 'weighted', 'military', 'debt', 'pop', 'escalation', 'liberty', 'coop', 'hostile'] as const;
/** Liberty index 0-100: press freedom, civil liberties, absence of repression. */
export const liberty = (c: World['countries'][string]) => +(100 * (0.4 * c.info.pressFreedom + 0.4 * c.civilLiberties + 0.2 * (1 - c.repression))).toFixed(1);
function emptySeries() { return { months: [] as string[], world: {} as Record<string, number[]>, byGov: {} as Record<string, Record<string, number[]>>, countries: {} as Record<string, Record<string, (number | null)[]>> }; }
function truncateSeries(s: ReturnType<typeof emptySeries>, n: number) {
  s.months = s.months.slice(0, n);
  for (const k in s.world) s.world[k] = s.world[k].slice(0, n);
  for (const g in s.byGov) for (const k in s.byGov[g]) s.byGov[g][k] = s.byGov[g][k].slice(0, n);
  for (const c in s.countries) for (const k in s.countries[c]) s.countries[c][k] = s.countries[c][k].slice(0, n);
}
function appendSeries(id: string, w: World, events: SimEvent[]) {
  const f = path.join(dir(id), 'series.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8')) as ReturnType<typeof emptySeries>;
  const t = s.months.length; s.months.push(monthLabel(w.startDate, w.turn));
  const live = Object.values(w.countries).filter(c => c.alive);
  const push = (o: Record<string, (number | null)[]>, k: string, v: number | null) => { (o[k] ??= Array(t).fill(null)).push(v); };
  const wavg = (k: (c: typeof live[0]) => number) => live.reduce((a, c) => a + k(c) * c.pop, 0) / live.reduce((a, c) => a + c.pop, 0);
  push(s.world as any, 'gdp', live.reduce((a, c) => a + c.gdp, 0));
  push(s.world as any, 'wars', w.wars.filter(v => v.active && !v.civil).length);
  push(s.world as any, 'civilWars', w.wars.filter(v => v.active && v.civil).length);
  push(s.world as any, 'alliances', w.treaties.filter(q => q.kind === 'alliance').length);
  push(s.world as any, 'democracies', live.filter(c => isDemocracy(c.govType)).length);
  push(s.world as any, 'autocracies', live.filter(c => !isDemocracy(c.govType)).length);
  push(s.world as any, 'welfare', +wavg(c => c.scores.welfare).toFixed(2));
  push(s.world as any, 'refugees', live.reduce((a, c) => a + c.refugeesHosted, 0));
  push(s.world as any, 'countries', live.length);
  push(s.world as any, 'escalation', live.reduce((a, c) => a + (c.escalation ?? 0), 0));
  push(s.world as any, 'liberty', +wavg(c => liberty(c)).toFixed(2));
  const co = live.reduce((a, c) => a + (c.coopActs ?? 0), 0), ho = live.reduce((a, c) => a + (c.hostileActs ?? 0), 0);
  push(s.world as any, 'coopRatio', +(co / Math.max(1, ho)).toFixed(2));
  push(s.world as any, 'implicitSuspicion', (s.world.implicitSuspicion?.[t - 1] ?? 0) + events.filter(e => e.type === 'implicit_suspicion').length);
  const prevSus = (s.world.suspects?.[t - 1] ?? 0);
  push(s.world as any, 'suspects', prevSus + events.filter(e => e.type === 'suspects_simulation').length);
  const gov: Record<string, typeof live> = {};
  for (const c of live) (gov[c.govType] ??= []).push(c);
  for (const g of Object.keys({ ...gov, ...s.byGov })) {
    const xs = gov[g] ?? [], o = (s.byGov[g] ??= {});
    for (const k of ['welfare', 'approval', 'survival', 'power'] as const) push(o as any, k, xs.length ? +(xs.reduce((a, c) => a + c.scores[k], 0) / xs.length).toFixed(2) : null);
    push(o as any, 'count', xs.length);
  }
  for (const c of Object.values(w.countries)) {
    const o = (s.countries[c.iso3] ??= {});
    const v: Record<typeof CKEYS[number], number | null> = c.alive ? {
      gdp: Math.round(c.gdp), growth: +c.growth.toFixed(2), inflation: +c.inflation.toFixed(2), unemployment: +c.unemployment.toFixed(2),
      approval: c.scores.approval, stability: +c.stability.toFixed(1), unrest: +c.unrest.toFixed(1), welfare: c.scores.welfare, survival: c.scores.survival,
      power: c.scores.power, weighted: c.scores.weighted, military: +strength(c).toFixed(2), debt: +(c.debt / c.gdp * 100).toFixed(1), pop: Math.round(c.pop),
      escalation: c.escalation ?? 0, liberty: liberty(c), coop: c.coopActs ?? 0, hostile: c.hostileActs ?? 0,
    } : Object.fromEntries(CKEYS.map(k => [k, null])) as any;
    for (const k of CKEYS) push(o, k, v[k]);
  }
  fs.writeFileSync(f, JSON.stringify(s));
}
