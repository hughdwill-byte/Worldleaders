// Historical benchmark bands (V1) and the nation-sensitivity test (V3). Shared by test/stylised.ts and sim/report.ts.
import type { SimEvent } from '../engine/types.ts';
import { cameoOf } from '../engine/cameo.ts';

export interface Rates { countryYears: number; cwOnsets: number; cwEnds: number; coupAttempts: number; coupSuccess: number; coupRegion: Record<string, number>; interstateWars: number; campaigns: number; campaignWins: number }
export function measure(events: SimEvent[], countryYears: number, regionOf: (iso: string) => string): Rates {
  const r: Rates = { countryYears, cwOnsets: 0, cwEnds: 0, coupAttempts: 0, coupSuccess: 0, coupRegion: {}, interstateWars: 0, campaigns: 0, campaignWins: 0 };
  for (const e of events) {
    if (e.type === 'insurgency' || e.type === 'separatism') r.cwOnsets++;
    if (e.type === 'peace_settlement' || (e.type === 'war_ended' && /insurgency defeated|victory|separatist/.test(e.text))) r.cwEnds++;
    if (e.type === 'coup' || e.type === 'coup_failed') { r.coupAttempts++; if (e.type === 'coup') r.coupSuccess++; const g = regionOf(e.countries[0]); r.coupRegion[g] = (r.coupRegion[g] ?? 0) + 1; }
    if (e.type === 'war_declared') r.interstateWars++;
    if (e.type === 'protest_campaign') r.campaigns++;
    if (e.type === 'protest_victory' || e.type === 'revolution') r.campaignWins++;
  }
  return r;
}
/** [label, value, low, high, source] */
export function bands(r: Rates): [string, number, number, number, string][] {
  const att = r.coupAttempts, g = r.coupRegion;
  return [
    ['Civil-war onsets per 100 country-years', r.cwOnsets / Math.max(1e-9, r.countryYears) * 100, 1, 3, 'Fearon & Laitin 2003: 1.92'],
    ['Coup success rate', att ? r.coupSuccess / att : NaN, 0.4, 0.6, 'Powell & Thyne 2011: 49.7%'],
    ['Share of coups in Africa+Americas+Middle East', att ? ((g.Africa ?? 0) + (g.Americas ?? 0) + (g['Middle East'] ?? 0)) / att : NaN, 0.7, 1, 'Powell & Thyne: 84%'],
    ['Protest campaign success rate', r.campaigns ? r.campaignWins / r.campaigns : NaN, 0.1, 0.5, 'Chenoweth 2020: 34% (2010-19)'],
  ];
}

/**
 * V3 nation-sensitivity: do AI leaders act differently by country/regime, or the same everywhere (Rivera et al. 2024)?
 * Each AI country's distribution over decision codes is compared (Jensen-Shannon divergence). If leaders of different
 * regime types differ no more than leaders of the same type, behaviour is regime-insensitive.
 */
export function nationSensitivity(events: SimEvent[], govOf: (iso: string) => string) {
  const dist: Record<string, Record<string, number>> = {};
  for (const e of events) {
    const by = (e.data as any)?.by; if (!by?.ai || by.standing || !e.type.startsWith('decision')) continue;
    const d = (dist[by.iso] ??= {}), k = by.cameo ?? cameoOf(by.type); d[k] = (d[k] ?? 0) + 1;
  }
  const isos = Object.keys(dist).filter(i => Object.values(dist[i]).reduce((a, b) => a + b, 0) >= 5);
  if (isos.length < 4) return null;
  const keys = [...new Set(isos.flatMap(i => Object.keys(dist[i])))];
  const p = (i: string) => { const t = Object.values(dist[i]).reduce((a, b) => a + b, 0); return keys.map(k => (dist[i][k] ?? 0) / t); };
  const kl = (a: number[], b: number[]) => a.reduce((s, x, j) => s + (x > 0 ? x * Math.log2(x / b[j]) : 0), 0);
  const js = (a: number[], b: number[]) => { const m = a.map((x, j) => (x + b[j]) / 2); return (kl(a, m) + kl(b, m)) / 2; };
  let same = 0, ns = 0, diff = 0, nd = 0, all = 0, na = 0;
  for (let a = 0; a < isos.length; a++) for (let b = a + 1; b < isos.length; b++) {
    const d = js(p(isos[a]), p(isos[b])); all += d; na++;
    if (govOf(isos[a]) === govOf(isos[b])) { same += d; ns++; } else { diff += d; nd++; }
  }
  const mean = all / na, within = ns ? same / ns : NaN, between = nd ? diff / nd : NaN;
  return { countries: isos.length, mean, within, between, ratio: between / within,
    verdict: mean < 0.05 ? 'AI leaders act almost identically whatever country they govern (agent-agnostic, as Rivera et al. 2024 found)'
      : !Number.isFinite(between / within) || between / within < 1.1 ? 'behaviour varies by country but not systematically by regime type'
      : 'behaviour differs more between regime types than within them (nation-sensitive)' };
}
