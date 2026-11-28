// npm test — one self-check: determinism through the real run pipeline, invariants over a 24-month mock run
// with all countries, and proof that border changes, civil war and regime collapse can occur.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { initWorld, loadStatics } from '../engine/world.ts';
import { runTurn } from '../engine/turn.ts';
import { mockDecide } from '../agents/mock.ts';
import type { SimEvent, World } from '../engine/types.ts';

process.env.PROVIDER = 'mock';
// test runs live in a temp folder, never in runs/
import os from 'node:os';
process.env.RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-selfcheck-'));
const { RUNS, createRun, step } = await import('../sim/run.ts');
const s = loadStatics();
const t0 = Date.now();

// 1. same seed + same (mock) decisions -> byte-identical snapshots
const a = createRun({ name: 'selfcheck-a', seed: 42, startDate: '2026-11' }), b = createRun({ name: 'selfcheck-b', seed: 42, startDate: '2026-11' });
await step(a.id, { turns: 3 }); await step(b.id, { turns: 3 });
for (let t = 0; t <= 3; t++) {
  const f = (id: string) => zlib.gunzipSync(fs.readFileSync(path.join(RUNS, id, 'turns', String(t).padStart(4, '0') + '.json.gz'))).toString();
  assert.equal(f(a.id), f(b.id), `snapshot ${t} differs between identical runs`);
}
fs.rmSync(RUNS, { recursive: true, force: true });
console.log('✓ deterministic snapshots');

// 2. budget identity: with no new orders, debt changes exactly by the monthly deficit
{
  const w = initWorld({ seed: 3, startDate: '2026-11' });
  const before = Object.fromEntries(w.order.map(i => [i, w.countries[i].debt]));
  runTurn(w, s, {});
  let checked = 0;
  for (const i of w.order) {
    const c = w.countries[i]; if (!c.alive) continue;
    const expect = Math.max(0, before[i] - c.budgetBalance / 100 * c.gdp / 12);
    if (expect === 0) continue;
    assert.ok(Math.abs(c.debt - expect) / expect < 1e-6, `${i}: debt ${c.debt} != ${expect}`);
    checked++;
  }
  console.log(`✓ budgets balance with debt (${checked} countries)`);
}

// 3. 24 mock months, all countries: invariants + every major system fires
const seen: Record<string, number> = {};
let w: World = initWorld({ seed: 1, startDate: '2026-11' });
const startOwners = w.regions.map(r => r.owner);
for (let t = 0; t < 24; t++) {
  const dec = Object.fromEntries(w.order.filter(i => w.countries[i].alive).map(i => [i, mockDecide(w, s, i)]));
  const ev: SimEvent[] = runTurn(w, s, dec);
  for (const e of ev) seen[e.type] = (seen[e.type] ?? 0) + 1;
  for (const c of Object.values(w.countries)) {
    for (const k of ['pop', 'gdp', 'debt', 'growth', 'inflation', 'unemployment', 'unrest', 'stability'] as const) assert.ok(Number.isFinite(c[k]), `${c.iso3}.${k} is ${c[k]} at month ${t}`);
    assert.ok(c.pop >= 0 && c.debt >= 0, `${c.iso3} negative pop/debt`);
    for (const bl of c.blocs) assert.ok(bl.approval >= 0 && bl.approval <= 100 && bl.share >= 0, `${c.iso3} bloc out of range`);
  }
  for (const r of w.regions) assert.ok(r.pop >= 0 && Number.isFinite(r.gdp), 'region invariant');
}
const borderChanges = w.regions.filter((r, i) => r.owner !== startOwners[i]).length;
console.log(`  24 months: ${borderChanges} regions changed owner, ${seen.region_captured ?? 0} captures, ${seen.civil_war ?? 0} new civil wars, ${seen.regime_change ?? 0} regime changes, ${seen.coup ?? 0} coups`);
assert.ok(borderChanges > 0, 'no border changes in 24 months');
assert.ok(w.wars.some(v => v.civil && v.active) || seen.civil_war, 'no civil war');
assert.ok(seen.regime_change || seen.regime_collapse || seen.coup, 'no regime change in 24 months');
console.log('✓ 24 mock months with all countries: invariants hold; border changes, civil war and regime change occur');

// 4. regime collapse path: strengthen Yemen's Houthis until they take the seat of government
{
  const w = initWorld({ seed: 5, startDate: '2026-11' });
  const f = Object.values(w.factions).find(f => f.country === 'YEM')!;
  let collapsed = false;
  for (let t = 0; t < 36 && !collapsed; t++) {
    f.strength = Math.max(f.strength, 50);
    const ev = runTurn(w, s, {});
    collapsed = ev.some(e => e.type === 'regime_collapse' && e.countries.includes('YEM'));
  }
  assert.ok(collapsed, 'a dominant rebel movement never toppled the government');
  assert.notEqual(w.countries.YEM.leader.id, 1, 'new leader expected');
  assert.equal(w.countries.YEM.constitution.status, 'provisional');
  console.log(`✓ regime collapse → new government (${w.countries.YEM.govType}), provisional constitution v${w.countries.YEM.constitution.version}`);
}
// 5. AI review planner: within budget, every country reviewed within MAX_MONTHS_WITHOUT_REVIEW, deterministic
{
  const { planMonth } = await import('../sim/run.ts');
  const { config } = await import('../agents/llm.ts');
  const prov = process.env.PROVIDER; process.env.PROVIDER = 'gemini';
  const w = initWorld({ seed: 9, startDate: '2026-11' });
  const meta: any = { countries: 'all', cadence: 'monthly' };
  const budget = 50; process.env.LLM_CALLS_PER_MONTH = String(budget);
  const lastSeen: Record<string, number> = {}; let maxGap = 0;
  for (let t = 0; t < 30; t++) {
    const p1 = planMonth(w, meta, []), p2 = planMonth(w, meta, []);
    assert.deepEqual(p1, p2, 'planner not deterministic');
    assert.ok(p1.llm.length <= budget, `planner over budget: ${p1.llm.length}`);
    for (const i of p1.llm) { w.countries[i].lastReview = t; lastSeen[i] = t; }
    w.turn = t + 1;
  }
  for (const i of w.order) maxGap = Math.max(maxGap, 30 - (lastSeen[i] ?? -1));
  assert.ok(maxGap <= 13, `a country went ${maxGap} months without an AI review`);
  process.env.PROVIDER = prov; void config;
  console.log(`✓ AI review planner: ≤${budget} calls/month, every country reviewed within ${maxGap - 1} months, deterministic`);
}
console.log(`all checks passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
