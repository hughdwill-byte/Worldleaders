// npm run stylised [-- --seeds 10 --months 120]
// Runs mock-leader worlds and checks the engine against historical "stylised facts". Fails (exit 1) outside the bands.
import { initWorld, loadStatics } from '../engine/world.ts';
import { runTurn } from '../engine/turn.ts';
import { mockDecide } from '../agents/mock.ts';
import { isDemocracy } from '../engine/regime.ts';
import type { SimEvent } from '../engine/types.ts';
import { type Rates, bands, measure } from '../sim/benchmarks.ts';

process.env.PROVIDER = 'mock';
const arg = (k: string, d: number) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const SEEDS = arg('seeds', 10), MONTHS = arg('months', 120);
const s = loadStatics();

export interface Stylised extends Rates { demDemWars: number }
export function measureSeed(events: SimEvent[], countryYears: number, demDem: number): Stylised {
  return { ...measure(events, countryYears, i => s.countryData[i]?.region ?? '?'), demDemWars: demDem };
}

if (process.argv[1]?.endsWith('stylised.ts')) {
  const all: Stylised[] = [];
  const t0 = Date.now();
  for (let seed = 1; seed <= SEEDS; seed++) {
    const w = initWorld({ seed: seed * 7919, startDate: '2026-11' });
    const evs: SimEvent[] = []; let cy = 0; const demPairs: SimEvent[] = [];
    for (let t = 0; t < MONTHS; t++) {
      const dec = Object.fromEntries(w.order.filter(i => w.countries[i].alive).map(i => [i, mockDecide(w, s, i)]));
      const ev = runTurn(w, s, dec);
      for (const e of ev) if (e.type === 'war_declared' && e.countries.length >= 2 && isDemocracy(w.countries[e.countries[0]].govType) && isDemocracy(w.countries[e.countries[1]].govType)) demPairs.push(e);
      evs.push(...ev); cy += w.order.filter(i => w.countries[i].alive).length / 12;
    }
    const m = measureSeed(evs, cy, demPairs.length);
    all.push(m);
    console.log(`seed ${seed}: civil-war onsets ${(m.cwOnsets / cy * 100).toFixed(2)}/100cy, ends ${m.cwEnds}, coups ${m.coupSuccess}/${m.coupAttempts}, interstate wars ${m.interstateWars} (dem-dem ${m.demDemWars}), campaigns ${m.campaignWins}/${m.campaigns}`);
  }
  const sum = (k: keyof Stylised) => all.reduce((a, m) => a + (m[k] as number), 0);
  const cy = sum('countryYears');
  const region: Record<string, number> = {}; for (const m of all) for (const [k, v] of Object.entries(m.coupRegion)) region[k] = (region[k] ?? 0) + v;
  const att = sum('coupAttempts');
  const total: Rates = { countryYears: cy, cwOnsets: sum('cwOnsets'), cwEnds: sum('cwEnds'), coupAttempts: att, coupSuccess: sum('coupSuccess'), coupRegion: region, interstateWars: sum('interstateWars'), campaigns: sum('campaigns'), campaignWins: sum('campaignWins') };
  const checks: [string, number, number, number, string][] = [
    ...bands(total),
    ['Seeds with zero democracy-vs-democracy wars', all.filter(m => m.demDemWars === 0).length / all.length, 0.5, 1, 'democratic peace'],
    ['Civil-war onsets minus terminations (accumulation)', sum('cwOnsets') - sum('cwEnds'), 0, Infinity, 'F&L: onsets exceed terminations'],
  ];
  console.log(`\n${SEEDS} seeds × ${MONTHS} months (${cy.toFixed(0)} country-years) in ${((Date.now() - t0) / 1000).toFixed(0)}s; coup attempts ${(att / (cy / 197)).toFixed(1)}/year worldwide; regions ${JSON.stringify(region)}\n`);
  let fail = 0;
  for (const [name, v, lo, hi, src] of checks) {
    const ok = Number.isFinite(v) && v >= lo && v <= hi;
    if (!ok) fail++;
    console.log(`${ok ? '✓' : '✗'} ${name}: ${Number.isFinite(v) ? (Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2)) : 'n/a'} (band ${lo}–${hi === Infinity ? '∞' : hi}; ${src})`);
  }
  if (fail) { console.log(`\n${fail} stylised fact(s) outside the historical band.`); process.exit(1); }
}
