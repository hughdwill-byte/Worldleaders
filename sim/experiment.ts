// npm run experiment -- --conditions experiments/example.json --seeds 5 --months 24 [--name my-exp]
// Repeats each condition over the same seeds (common random numbers) and reports means with 95% bootstrap CIs,
// plus the difference from a rule-based control. Single runs of chaotic systems are anecdotes; use ≥5 seeds.
import fs from 'node:fs';
import path from 'node:path';
import type { SimEvent, World } from '../engine/types.ts';
import { initWorld, loadStatics } from '../engine/world.ts';
import { initialScores, runTurn } from '../engine/turn.ts';
import { mockDecide } from '../agents/mock.ts';
import { isDemocracy } from '../engine/regime.ts';
import { Rng } from '../engine/util.ts';
import { ROOT, type WeightSpec, applyPreset, createRun, listRuns, loadSnapshot, selectActive, step } from './run.ts';
import { liberty } from './run.ts';
import { toCsv } from './export.ts';

interface Condition { name: string; leaders?: 'mock' | 'ai'; preset?: string; weights?: WeightSpec; countries?: 'dev' | 'all' }
const METRICS = ['welfare', 'liberty', 'democracies', 'interstate_wars', 'civil_war_onsets', 'coups', 'escalation', 'coop_ratio', 'world_gdp_growth_pct', 'regime_changes'] as const;
type Row = Record<typeof METRICS[number], number> & { condition: string; seed: number };

function metrics(w0: World, w: World, events: SimEvent[], cond: string, seed: number, escalation: number, coop: number, hostile: number): Row {
  const live = Object.values(w.countries).filter(c => c.alive), pop = live.reduce((a, c) => a + c.pop, 0);
  const gdp = (x: World) => Object.values(x.countries).filter(c => c.alive).reduce((a, c) => a + c.gdp, 0);
  const n = (t: string | RegExp) => events.filter(e => typeof t === 'string' ? e.type === t : t.test(e.type)).length;
  return { condition: cond, seed,
    welfare: +(live.reduce((a, c) => a + c.scores.welfare * c.pop, 0) / pop).toFixed(2), liberty: +(live.reduce((a, c) => a + liberty(c) * c.pop, 0) / pop).toFixed(2),
    democracies: live.filter(c => isDemocracy(c.govType)).length, interstate_wars: n('war_declared'), civil_war_onsets: n(/^(insurgency|separatism)$/),
    coups: n('coup'), escalation, coop_ratio: +(coop / Math.max(1, hostile)).toFixed(3), world_gdp_growth_pct: +((gdp(w) / gdp(w0) - 1) * 100).toFixed(2), regime_changes: n('regime_change') };
}

function runMock(c: Condition, seed: number, months: number): Row {
  const s = loadStatics(), w = initWorld({ seed, startDate: '2026-11' });
  applyPreset(w, c.preset ?? null, c.weights); initialScores(w, s);
  const w0 = structuredClone(w); const evs: SimEvent[] = []; let esc = 0, co = 0, ho = 0;
  for (let t = 0; t < months; t++) {
    const act = selectActive(w, evs.filter(e => e.turn === t - 1));
    const ev = runTurn(w, s, Object.fromEntries(act.map(i => [i, mockDecide(w, s, i)])));
    for (const x of Object.values(w.countries)) { esc += x.escalation ?? 0; co += x.coopActs ?? 0; ho += x.hostileActs ?? 0; }
    evs.push(...ev);
  }
  return metrics(w0, w, evs, c.name, seed, esc, co, ho);
}

async function runAi(c: Condition, seed: number, months: number, exp: string): Promise<Row> {
  const name = `${exp} ${c.name} s${seed}`;
  const m = listRuns().find(r => r.name === name) ?? createRun({ name, seed, preset: c.preset ?? null, weights: c.weights, countries: c.countries ?? 'dev', startDate: '2026-11' });
  if (m.lastTurn < months) await step(m.id, { turns: months - m.lastTurn });
  const dir = path.join(ROOT, 'runs', m.id);
  const evs: SimEvent[] = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const se = JSON.parse(fs.readFileSync(path.join(dir, 'series.json'), 'utf8'));
  const sumC = (k: string) => Object.values<any>(se.countries).reduce((a, o) => a + (o[k] ?? []).reduce((p: number, v: number | null) => p + (v ?? 0), 0), 0);
  const last = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).lastTurn;
  return metrics(loadSnapshot(m.id, 0), loadSnapshot(m.id, last), evs, c.name, seed, sumC('escalation'), sumC('coop'), sumC('hostile'));
}

function ci(xs: number[], rng: Rng): [number, number, number] {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length < 2) return [mean, mean, mean];
  const boots = Array.from({ length: 2000 }, () => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rng.next() * xs.length)]; return s / xs.length; }).sort((a, b) => a - b);
  return [mean, boots[50], boots[1949]];
}

if (process.argv[1]?.endsWith('experiment.ts')) {
  const arg = (k: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
  const file = arg('conditions') ?? 'experiments/example.json', seeds = Number(arg('seeds') ?? 5), months = Number(arg('months') ?? 24);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const exp = arg('name') ?? path.basename(file, '.json');
  const conds: Condition[] = [{ name: 'control (rule-based, realistic)', leaders: 'mock' }, ...spec.conditions];
  const rows: Row[] = [];
  const t0 = Date.now();
  for (const c of conds) for (let k = 1; k <= seeds; k++) {
    const seed = 1000 + k; // same seeds in every condition
    rows.push(c.leaders === 'ai' ? await runAi(c, seed, months, exp) : runMock(c, seed, months));
    process.stdout.write(`\r${rows.length}/${conds.length * seeds} runs (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  const rng = new Rng(42);
  const ctrl = (k: string) => rows.filter(r => r.condition === conds[0].name).map(r => (r as any)[k] as number);
  const L = [`# Experiment: ${exp}`, '', `${conds.length} conditions × ${seeds} seeds × ${months} months, same seeds in every condition. Values are means with 95% bootstrap confidence intervals; Δ = difference from the rule-based control (★ when its 95% CI excludes 0).`, ''];
  for (const k of METRICS) {
    L.push(`## ${k.replace(/_/g, ' ')}`, '', '| Condition | Leaders | Mean [95% CI] | Δ vs control [95% CI] |', '|---|---|---|---|');
    for (const c of conds) {
      const xs = rows.filter(r => r.condition === c.name).map(r => (r as any)[k] as number);
      const [m, lo, hi] = ci(xs, rng);
      const d = xs.map((x, i) => x - ctrl(k)[i]); const [dm, dlo, dhi] = ci(d, rng);
      L.push(`| ${c.name} | ${c.leaders ?? 'mock'} | ${m.toFixed(2)} [${lo.toFixed(2)}, ${hi.toFixed(2)}] | ${c === conds[0] ? '—' : `${dm >= 0 ? '+' : ''}${dm.toFixed(2)} [${dlo.toFixed(2)}, ${dhi.toFixed(2)}]${dlo > 0 || dhi < 0 ? ' ★' : ''}`} |`);
    }
    L.push('');
  }
  const out = path.join(ROOT, 'experiments', `${exp}-${new Date().toISOString().slice(0, 10)}`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'summary.md'), L.join('\n'));
  fs.writeFileSync(path.join(out, 'results.csv'), toCsv(rows));
  console.log(`\nwrote ${out}/summary.md and results.csv`);
}
