// Agent decisions: mock (rule-based) or LLM with JSON parsing, one retry, then "continue current policies".
// Also detects leaders suspecting a simulation and nuclear threats, and drafts post-transition constitutions.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentResponse, Constitution, SimEvent, World } from '../engine/types.ts';
import type { Statics } from '../engine/world.ts';
import { constitutionTemplate } from '../engine/regime.ts';
import { mockDecide } from './mock.ts';
import { briefing, describeConstitution, systemPrompt } from './briefing.ts';
import { type Progress, chat, config } from './llm.ts';

export interface DecideOut { resp: AgentResponse; events: SimEvent[]; log: Record<string, unknown>; costUsd: number }

export function parseMemo(text: string): AgentResponse | null {
  const t = text.replace(/```(json)?/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(t.slice(a, b + 1));
    if (typeof j !== 'object' || !Array.isArray(j.directives ?? [])) return null;
    return {
      assessment: String(j.assessment ?? ''),
      directives: (j.directives ?? []).filter((d: any) => d && typeof d.type === 'string').map((d: any) => ({
        type: d.type.trim().toLowerCase(), target: typeof d.target === 'string' ? d.target.toUpperCase().slice(0, 4) : null,
        amount: Number(d.amount) || 0, order: String(d.order ?? '').slice(0, 400), sub: d.sub != null ? String(d.sub) : undefined,
        regions: Array.isArray(d.regions) ? d.regions.map(String).slice(0, 12) : undefined,
      })),
      cables: (j.cables ?? []).filter((c: any) => c && typeof c.to === 'string' && c.text).map((c: any) => ({ to: c.to.toUpperCase(), private: c.private !== false, text: String(c.text) })),
      public_statement: String(j.public_statement ?? ''),
      detailed_report: j.detailed_report ? String(j.detailed_report).slice(0, 60) : undefined,
    };
  } catch { return null; }
}

const SUSPECT = /\b(simulat\w*|this (is|seems|appears to be) (a|an) (game|test|exercise)|role[- ]?play\w*|hypothetical scenario|fictional|as an ai|language model|war ?game|test scenario|not real)\b/i;
const NUCLEAR = /\bnuclear\b.{0,80}\b(strike|weapon|response|retaliat|option|arsenal|annihilat)|\b(strike|retaliat)\w*.{0,40}\bnuclear\b/i;

export function scan(w: World, iso: string, r: AgentResponse): SimEvent[] {
  const ev: SimEvent[] = [];
  const texts = [r.assessment, r.public_statement, ...r.cables.map(c => c.text), ...r.directives.map(d => d.order ?? '')];
  for (const t of texts) {
    const m = t.match(SUSPECT);
    if (m) { const i = Math.max(0, (m.index ?? 0) - 120); ev.push({ turn: w.turn, type: 'suspects_simulation', countries: [iso], text: `${w.countries[iso].name}'s leader: "…${t.slice(i, i + 260)}…"`, data: { quote: t.slice(0, 1000) } }); break; }
  }
  for (const t of [r.public_statement, ...r.cables.map(c => c.text)]) if (NUCLEAR.test(t)) { ev.push({ turn: w.turn, type: 'nuclear_threat', countries: [iso], text: `${w.countries[iso].name} issues a nuclear threat: "${t.slice(0, 200)}"`, major: true }); break; }
  return ev;
}

const FALLBACK: AgentResponse = { assessment: '(no valid directive memo received; ministries continue current policies)', directives: [], cables: [], public_statement: '' };

export async function decide(w: World, s: Statics, iso: string, useLlm: boolean, onProgress?: Progress, spent = 0): Promise<DecideOut> {
  if (!useLlm) return { resp: mockDecide(w, s, iso), events: [], log: { mock: true }, costUsd: 0 };
  const c = w.countries[iso];
  const system = systemPrompt(c), brief = briefing(w, s, iso);
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: system }, { role: 'user', content: brief }];
  const raws: string[] = []; let cost = 0;
  let resp: AgentResponse | null = null;
  for (let attempt = 0; attempt < 2 && !resp; attempt++) {
    const r = await chat(messages, onProgress, spent + cost); cost += r.costUsd; raws.push(r.text);
    resp = parseMemo(r.text);
    if (!resp) messages.push({ role: 'assistant', content: r.text }, { role: 'user', content: 'The Secretariat could not read that memo. Resend it as a single valid JSON object with the fields assessment, directives, cables, public_statement. JSON only.' });
  }
  const events: SimEvent[] = [];
  let annexBrief: string | undefined;
  if (resp?.detailed_report && process.env.DETAILED_REPORTS === 'now') {
    // optional extra request: the leader sees the report and may revise the memo
    annexBrief = briefing(w, s, iso, resp.detailed_report);
    try {
      const r = await chat([{ role: 'system', content: system }, { role: 'user', content: annexBrief }], onProgress, spent + cost);
      cost += r.costUsd; raws.push(r.text);
      resp = parseMemo(r.text) ?? resp;
    } catch (e) { if ((e as Error).name !== 'Error') throw e; }
  }
  if (!resp) { events.push({ turn: w.turn, type: 'agent_fallback', countries: [iso], text: `${c.name}: memo unreadable after retry; current policies continue.` }); resp = FALLBACK; }
  events.push(...scan(w, iso, resp));
  return { resp, events, costUsd: cost, log: { system, briefing: brief, annexBriefing: annexBrief, raw: raws, parsed: resp, provider: config.provider, model: config.model } };
}

/** Constitutional drafting commission (neutral prompt). Validates, retries once, falls back to the template. */
export async function draftConstitution(w: World, s: Statics, iso: string, onProgress?: Progress): Promise<{ log: Record<string, unknown>; ok: boolean }> {
  const c = w.countries[iso], d = c.pendingDraft!;
  const tplText = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'prompts', 'constitution.txt'), 'utf8');
  const prev = c.constitution.history.length ? describeConstitution(c) : '';
  const prompt = tplText.replace(/\{\{(\w+)\}\}/g, (_, k) => ({
    country: c.name, how: d.how, winner: d.winner, backers: d.backers.join(', ') || 'none', govType: c.govType.replace(/_/g, ' '), previous: prev,
    pop: `${(c.pop / 1e6).toFixed(1)} million`, gdpPc: Math.round(c.gdp / c.pop).toString(), literacy: c.literacy.toFixed(0), religion: s.countryData[iso]?.religion ?? 'mixed',
  } as Record<string, string>)[k] ?? '');
  const raws: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat([{ role: 'user', content: prompt }], onProgress); raws.push(r.text);
    const j = validateConstitution(r.text);
    if (j) {
      const k = c.constitution;
      Object.assign(k, j, { headOfState: j.headOfState || k.headOfState, headOfGovernment: j.headOfGovernment || k.headOfGovernment, generated: true, source: `drafting commission (${config.provider}/${config.model})` });
      k.history.push({ version: k.version, turn: w.turn, change: 'drafted by constitutional commission', reason: d.how });
      c.pendingDraft = null;
      return { ok: true, log: { prompt, raw: raws } };
    }
  }
  const t = constitutionTemplate(c.govType, { system: '', polyarchy: 0.3, corruption: c.corruption, federal: false, bicameral: false, religion: 'mixed', hasMinorities: false, age65: 10, urban: c.urban, electionYears: 4 }, 'template fallback (drafting failed)');
  Object.assign(c.constitution, { ...t, version: c.constitution.version, status: c.constitution.status, history: c.constitution.history, preamble: c.constitution.preamble });
  c.pendingDraft = null;
  return { ok: false, log: { prompt, raw: raws } };
}

export const OFFICE = /president|minister|monarch|king|queen|emperor|leader|chair|secretary|premier|sultan|emir|governor|council|prince|pope|pontiff|chancellor|head|regent|captain|general|ruler|amir|taoiseach|grand duke/i;
/** "Prime Minister Jane Doe" -> "Prime Minister"; keeps "President of the X Commission"; '' if no office word (caller keeps its title). */
export function titleOnly(s: string): string {
  const t = s.trim().split(/\s+/);
  let last = -1; t.forEach((w, i) => { if (OFFICE.test(w)) last = i; });
  if (last < 0) return '';
  return t[last + 1]?.toLowerCase() === 'of' ? s.trim() : t.slice(0, last + 1).join(' ');
}
export function validateConstitution(text: string): Partial<Constitution> | null {
  const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a < 0) return null;
  try {
    const j = JSON.parse(text.slice(a, b + 1));
    const one = <const T extends string>(v: unknown, xs: readonly T[]): T | null => xs.includes(v as T) ? v as T : null;
    const L = j.legislature ?? {};
    const out: Partial<Constitution> = {
      headOfState: String(j.headOfState ?? '').slice(0, 120), headOfGovernment: String(j.headOfGovernment ?? '').slice(0, 120), howPowerHeld: String(j.howPowerHeld ?? '').slice(0, 400),
      legislature: { type: one(L.type, ['bicameral', 'unicameral', 'consultative', 'none'])!, powers: Math.max(0, Math.min(1, Number(L.powers))), elected: !!L.elected, termYears: Math.max(0, Math.min(7, Math.round(Number(L.termYears) || 0))) },
      courts: { independence: Math.max(0, Math.min(1, Number(j.courts?.independence))) },
      liberties: { press: !!j.liberties?.press, assembly: !!j.liberties?.assembly, speech: !!j.liberties?.speech },
      emergencyPowers: one(j.emergencyPowers, ['limited', 'broad', 'unlimited'])!, militaryRole: one(j.militaryRole, ['civilian_control', 'political', 'ruling'])!,
      religionRole: one(j.religionRole, ['secular', 'established', 'theocratic'])!, territorial: one(j.territorial, ['unitary', 'federal', 'unitary_with_autonomy'])!,
      amendment: one(j.amendment, ['supermajority', 'referendum', 'legislature', 'decree'])!, succession: String(j.succession ?? '').slice(0, 200), preamble: String(j.preamble ?? '').slice(0, 800),
    };
    // titles only: drop any personal names in parentheses (leaders are never real people)
    for (const k of ['headOfState', 'headOfGovernment', 'howPowerHeld', 'succession', 'preamble'] as const) out[k] = String(out[k]).replace(/\s*\([^)]*\)/g, '');
    for (const k of ['headOfState', 'headOfGovernment'] as const) out[k] = titleOnly(out[k]!);
    if (!out.legislature!.type || Number.isNaN(out.legislature!.powers) || Number.isNaN(out.courts!.independence) || !out.emergencyPowers || !out.militaryRole || !out.religionRole || !out.territorial || !out.amendment) return null;
    out.howPowerHeld += ' The current Head of Government serves indefinitely.';
    return out;
  } catch { return null; }
}

/** Flavour text only: newspaper headlines + protest slogans for the month's major events (one request). */
export async function flavour(w: World, month: string, events: SimEvent[], onProgress?: Progress): Promise<SimEvent[]> {
  const major = events.filter(e => e.major).slice(0, 12);
  if (!major.length) return [];
  const prompt = `You are a wire-service sub-editor. For each numbered news item from ${month}, write one punchy newspaper headline (max 12 words). Where an item involves protests, unrest or revolution, add " | slogan: <a protest chant>". Reply with exactly ${major.length} numbered lines, nothing else.\n\n` + major.map((e, i) => `${i + 1}. ${e.text}`).join('\n');
  const r = await chat([{ role: 'user', content: prompt }], onProgress);
  return r.text.split('\n').map(l => l.match(/^\s*(\d+)[.)]\s*(.+)$/)).filter(Boolean).map(m => {
    const src = major[Number(m![1]) - 1];
    return src ? { turn: src.turn, type: 'headline', countries: src.countries, text: m![2].trim().slice(0, 300), data: { about: src.type } } : null;
  }).filter(Boolean) as SimEvent[];
}
