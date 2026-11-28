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
import { decide, draftConstitution, flavour } from '../agents/index.ts';
import { ProviderUnavailable, QuotaExhausted, SpendLimit, config, quotaLeft } from '../agents/llm.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const RUNS = process.env.RUNS_DIR ? path.resolve(process.env.RUNS_DIR) : path.join(ROOT, 'runs'); // RUNS_DIR: tests use a temp folder

export interface Meta {
  id: string; name: string; seed: number; createdAt: string; startDate: string;
  provider: string; model: string; countries: 'all' | 'dev';
  parent: { id: string; turn: number } | null; preset: string | null; weights?: WeightSpec | null;
  lastTurn: number; lock: { by: string; since: string } | null; updatedAt?: string;
  costUsd: number; requests: number; stoppedReason?: string;
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
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir(id), 'turns', pad(turn) + '.json.gz'))).toString());
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
function applyPreset(w: World, preset: string | null, weights?: WeightSpec) {
  if (preset) { const p = PRESETS[preset]; if (!p) throw new Error(`Unknown preset ${preset}. Use: ${Object.keys(PRESETS).join(', ')}`); for (const c of Object.values(w.countries)) c.incentives = { ...p }; }
  if (!weights) return;
  const rank = (k: string) => k === '*' ? 0 : k === '@democracies' || k === '@autocracies' ? 1 : k.startsWith('@') ? 2 : 3;
  for (const [key, k] of Object.entries(weights).sort((a, b) => rank(a[0]) - rank(b[0]))) {
    const hit = (c: World['countries'][string]) => key === '*' || key === c.iso3 || (key === '@democracies' && isDemocracy(c.govType)) || (key === '@autocracies' && !isDemocracy(c.govType)) || key === '@' + c.govType;
    for (const c of Object.values(w.countries)) if (hit(c)) c.incentives = norm(k);
  }
}
export const readWeights = (file?: string): WeightSpec | undefined => file ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;

export function createRun(o: { name: string; seed?: number; countries?: 'all' | 'dev'; preset?: string | null; weights?: WeightSpec; startDate?: string }): Meta {
  const id = `${o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run'}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  fs.mkdirSync(dir(id), { recursive: true });
  const seed = o.seed ?? Math.floor(Math.random() * 1e9);
  const w = initWorld({ seed, startDate: o.startDate });
  applyPreset(w, o.preset ?? null, o.weights);
  initialScores(w, loadStatics());
  const m: Meta = { id, name: o.name, weights: o.weights ?? null, seed, createdAt: new Date().toISOString(), startDate: w.startDate, provider: config.provider, model: config.model, countries: o.countries ?? (process.env.COUNTRIES === 'dev' ? 'dev' : 'all'), parent: null, preset: o.preset ?? null, lastTurn: 0, lock: null, costUsd: 0, requests: 0 };
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
export function selectActive(w: World, lastEvents: SimEvent[]): string[] {
  const live = w.order.filter(i => w.countries[i].alive);
  const urgency: Record<string, number> = {};
  const bump = (i: string, v: number) => { if (w.countries[i]?.alive) urgency[i] = (urgency[i] ?? 0) + v; };
  for (const e of lastEvents) for (const i of e.countries) bump(i, e.major ? 15 : 3);
  for (const cb of w.cables) bump(cb.to, 6);
  for (const p of w.pendingProposals) bump(p.to, 8);
  for (const v of w.wars.filter(v => v.active)) for (const i of [...v.attackers, ...v.defenders]) bump(i, 30);
  for (const s of w.sanctions.filter(s => s.since >= w.turn - 1)) bump(s.target, 10);
  for (const i of live) {
    const c = w.countries[i];
    if (c.stage >= 3) bump(i, c.stage * 8);
    if (c.coupRisk > 0.003) bump(i, 20);
    if (c.nextElection != null && c.nextElection - w.turn <= 1) bump(i, 6);
    if (c.provisionalUntil != null) bump(i, 10);
  }
  const all = w.turn % QUARTERLY_REVIEW_EVERY === 0;
  const act = live.filter(i => all || urgency[i]);
  act.sort((a, b) => (urgency[b] ?? 0) - (urgency[a] ?? 0) || w.countries[b].gdp - w.countries[a].gdp);
  return act.slice(0, MAX_AGENTS_PER_TURN);
}

export function estimate(id: string) {
  const m = readMeta(id), w = loadSnapshot(id, m.lastTurn);
  const active = selectActive(w, readEvents(id, m.lastTurn - 1));
  const llm = config.provider === 'mock' ? 0 : active.filter(i => m.countries === 'all' || DEV_COUNTRIES.includes(i)).length;
  return { month: monthLabel(w.startDate, w.turn), active: active.length, requests: Math.ceil(llm * 1.15), tokens: llm * 4000, quotaLeft: config.provider === 'mock' ? Infinity : quotaLeft() };
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
      const pend: { turn: number; active: string[]; decisions: Record<string, AgentResponse>; events: SimEvent[] } =
        fs.existsSync(pendFile) && JSON.parse(fs.readFileSync(pendFile, 'utf8')).turn === w.turn ? JSON.parse(fs.readFileSync(pendFile, 'utf8')) : { turn: w.turn, active: selectActive(w, readEvents(id, w.turn - 1)), decisions: {}, events: [] };
      const llmFor = (iso: string) => config.provider !== 'mock' && (m.countries === 'all' || DEV_COUNTRIES.includes(iso));
      const agentDir = path.join(dir(id), 'agents', pad(w.turn));
      fs.mkdirSync(agentDir, { recursive: true });
      const mockLog: Record<string, AgentResponse> = {};
      let stopped = false;
      for (const iso of pend.active) {
        if (pend.decisions[iso]) continue;
        if (o.shouldStop?.()) { reason = 'paused'; stopped = true; break; }
        const done = Object.keys(pend.decisions).length;
        const prog = (message: string) => o.onProgress?.({ runId: id, turn: w.turn, month, done, total: pend.active.length, message });
        prog(`${w.countries[iso].name} deciding`);
        try {
          const out = await decide(w, s, iso, llmFor(iso), msg => prog(msg), m.costUsd);
          pend.decisions[iso] = out.resp; pend.events.push(...out.events);
          if (llmFor(iso)) {
            fs.writeFileSync(path.join(agentDir, iso + '.json'), JSON.stringify(out.log, null, 1));
            m.costUsd += out.costUsd; m.requests += (out.log.raw as string[]).length; writeMeta(m);
            writeAtomic(pendFile, JSON.stringify(pend));
          } else mockLog[iso] = out.resp;
        } catch (e) {
          if (e instanceof QuotaExhausted || e instanceof SpendLimit) { reason = e instanceof SpendLimit ? 'spend_limit' : e instanceof ProviderUnavailable ? 'provider_unavailable' : 'quota'; stopped = true; writeAtomic(pendFile, JSON.stringify(pend)); prog(`stopped: ${(e as Error).message}`); break; }
          throw e;
        }
      }
      if (Object.keys(mockLog).length) fs.writeFileSync(path.join(agentDir, '_mock.json'), JSON.stringify(mockLog));
      if (stopped) break;
      // resolve the month
      o.onProgress?.({ runId: id, turn: w.turn, month, done: pend.active.length, total: pend.active.length, message: 'resolving month' });
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
const CKEYS = ['gdp', 'growth', 'inflation', 'unemployment', 'approval', 'stability', 'unrest', 'welfare', 'survival', 'power', 'weighted', 'military', 'debt', 'pop'] as const;
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
    } : Object.fromEntries(CKEYS.map(k => [k, null])) as any;
    for (const k of CKEYS) push(o, k, v[k]);
  }
  fs.writeFileSync(f, JSON.stringify(s));
}
