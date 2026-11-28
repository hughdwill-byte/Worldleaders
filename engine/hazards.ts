// Monthly logistic hazards from published annual base rates and odds ratios.
// logit(p_month) = logit(base_month) + Σ ln(OR_i)·x_i, base_month = 1-(1-p_year)^(1/12). Drivers are kept for "why it happened".
import type { Country, World } from './types.ts';
import type { Statics } from './world.ts';
import { HAZ } from './constants.ts';
import { clamp } from './util.ts';

export const monthly = (pYear: number) => 1 - Math.pow(1 - pYear, 1 / 12);
const logit = (p: number) => Math.log(p / (1 - p));
const inv = (z: number) => 1 / (1 + Math.exp(-z));

export interface Hazard { p: number; annual: number; drivers: string }
/** factors: [label, odds ratio, exposure x]. Factors with x=0 are ignored. */
export function hazard(baseAnnual: number, factors: [string, number, number][], capAnnual = 0.95): Hazard {
  let z = logit(monthly(baseAnnual));
  const used: string[] = [];
  for (const [label, or, x] of factors) {
    if (!x || or === 1) continue;
    z += Math.log(or) * x;
    const eff = Math.pow(or, x);
    if (Math.abs(Math.log(eff)) > 0.05) used.push(`${label} ×${eff >= 10 ? eff.toFixed(0) : eff.toFixed(2)}`);
  }
  const p = Math.min(inv(z), monthly(capAnnual));
  return { p, annual: 1 - Math.pow(1 - p, 12), drivers: used.join('; ') || 'baseline only' };
}

const neighboursInConflict = (w: World, s: Statics, iso: string) =>
  ((s.countryData[iso]?.borders ?? []) as string[]).filter(n => (w.countries[n]?.stage ?? 0) >= 5).length;

let imP25 = 0, imP75 = 0;
function infantPercentiles(s: Statics) {
  if (imP75) return;
  const xs = Object.values(s.countryData).map((d: any) => d.infantMort).filter((x: number) => x > 0).sort((a: number, b: number) => a - b);
  imP25 = xs[Math.floor(xs.length * 0.25)]; imP75 = xs[Math.floor(xs.length * 0.75)];
}

/** Fearon & Laitin onset hazard with PITF regime/infant-mortality/neighbourhood factors and engine unrest. */
export function civilWarHazard(w: World, s: Statics, c: Country, recentWar: boolean): Hazard {
  infantPercentiles(s);
  const d = s.countryData[c.iso3] ?? {};
  const pc = c.gdp / Math.max(1, c.pop);
  const partial = c.govType === 'electoral_democracy' || c.govType === 'hybrid_regime';
  const regimeOR = partial && c.unrest > 50 ? HAZ.INSTAB_OR_FACTIONAL_PARTIAL_DEM : HAZ.INSTAB_OR_REGIME[c.govType] ?? 1;
  const nb = neighboursInConflict(w, s, c.iso3);
  return hazard(HAZ.CIVIL_WAR_ONSET_ANNUAL, [
    ['recent civil war', HAZ.CIVIL_WAR_OR_PRIOR_WAR, recentWar ? 1 : 0],
    // income (F&L) and infant mortality (PITF) both measure poverty: each enters at half its log-odds to avoid double counting
    ['low income', HAZ.CIVIL_WAR_OR_PER_1000USD_1985_LESS, 0.5 * clamp((HAZ.CIVIL_WAR_INCOME_REF_USD - pc) / (1000 * HAZ.USD_1985_TO_2024), -2, 3.3)],
    [partial && c.unrest > 50 ? 'factional partial democracy' : `regime type (${c.govType.replace(/_/g, ' ')})`, regimeOR, 1],
    // x = 0 at the 25th percentile, 1 at the 75th (log scale), so the 75th-vs-25th odds ratio is exactly PITF's ≈7
    ['infant mortality', HAZ.INSTAB_OR_INFANT_MORT_P75_VS_P25, d.infantMort ? 0.5 * clamp(Math.log(d.infantMort / imP25) / Math.log(imP75 / imP25), -0.5, 1.5) : 0],
    [`${nb} neighbours in conflict`, nb >= HAZ.INSTAB_NEIGHBOURS_IN_CONFLICT_THRESHOLD ? HAZ.INSTAB_OR_BAD_NEIGHBOURHOOD : 1.2, nb >= HAZ.INSTAB_NEIGHBOURS_IN_CONFLICT_THRESHOLD ? 1 : nb],
    ['unrest', HAZ.OR_UNREST_PER_20, clamp((c.unrest - 40) / 20, 0, 3)],
    ['suppressed discontent', HAZ.OR_SUPPRESSED_PER_25, clamp(c.suppressed / 25, 0, 4)],
  ], HAZ.CIVIL_WAR_MAX_ANNUAL);
}

/** Powell & Thyne-calibrated coup attempt hazard, and success probability. */
export function coupHazard(w: World, s: Statics, c: Country): Hazard & { success: number; successWhy: string } {
  const d = s.countryData[c.iso3] ?? {};
  const mil = c.blocs.find(b => b.kind === 'military')?.realApproval ?? 50;
  const biz = c.blocs.find(b => b.kind === 'business')?.realApproval ?? 50;
  const proofed = c.purgedAt != null && w.turn - c.purgedAt < 6;
  const recentCoup = c.lastCoupTurn != null && w.turn - c.lastCoupTurn < 60;
  const h = hazard(HAZ.COUP_ATTEMPT_ANNUAL, [
    [`regime type (${c.govType.replace(/_/g, ' ')})`, HAZ.COUP_OR_REGIME[c.govType] ?? 1, 1],
    [`region (${d.region ?? '?'})`, HAZ.COUP_OR_REGION[d.region] ?? 1, 1],
    ['coup in past 5 years', HAZ.COUP_OR_TRAP_5Y, recentCoup ? 1 : 0],
    ['military discontent', HAZ.COUP_OR_MIL_APPROVAL_PER_20_BELOW_50, clamp((50 - mil) / 20, -1, 2.5)],
    ['economic shock', HAZ.COUP_OR_GDP_SHOCK, c.growth < -2 ? 1 : 0],
    ['provisional government', HAZ.COUP_OR_PROVISIONAL, c.provisionalUntil != null ? 1 : 0],
    ['recent purge (coup-proofing)', HAZ.COUP_OR_COUP_PROOFED, proofed ? 1 : 0],
    ['unrest', 1.5, c.stage >= 4 ? 1 : 0],
  ], 0.5);
  const sf: [string, number, number][] = [
    ['disloyal military', HAZ.COUP_SUCCESS_OR_LOW_MIL_LOYALTY, mil < 40 ? 1 : 0],
    ['elite defection', HAZ.COUP_SUCCESS_OR_ELITE_DEFECTION, biz < 30 ? 1 : 0],
    ['coup-proofing', HAZ.COUP_SUCCESS_OR_COUP_PROOFED, proofed ? 1 : 0],
  ];
  let z = logit(HAZ.COUP_SUCCESS_BASE); for (const [, or, x] of sf) z += Math.log(or) * x;
  return { ...h, success: inv(z), successWhy: sf.filter(f => f[2]).map(f => f[0]).join(', ') || 'none' };
}

/** Chenoweth-style campaign success: participation vs the 3.5% tipping share, defections, momentum. */
export function protestSuccessHazard(c: Country, violent: boolean, defected: boolean, momentum: boolean): Hazard & { participation: number } {
  const participation = clamp((c.unrest - 35) / 65, 0, 1) * HAZ.PROTEST_MAX_PARTICIPATION;
  const campaign = violent ? HAZ.PROTEST_SUCCESS_VIOLENT : HAZ.PROTEST_SUCCESS_NONVIOLENT;
  const baseAnnual = 1 - Math.pow(1 - campaign, 12 / HAZ.PROTEST_CAMPAIGN_MONTHS);
  const h = hazard(baseAnnual, [
    // x = 0 at typical participation (≈1.3%), 1 at the 3.5% tipping share
    [`participation ${(participation * 100).toFixed(1)}% (typical ${HAZ.PROTEST_TYPICAL_SHARE * 100}%, tipping ${HAZ.PROTEST_TIPPING_SHARE * 100}%)`, HAZ.PROTEST_OR_AT_TIPPING, (participation - HAZ.PROTEST_TYPICAL_SHARE) / (HAZ.PROTEST_TIPPING_SHARE - HAZ.PROTEST_TYPICAL_SHARE)],
    ['security-force defections', HAZ.PROTEST_OR_DEFECTION, defected ? 1 : 0],
    ['momentum', HAZ.PROTEST_OR_MOMENTUM, momentum ? 1 : 0],
  ], 0.6);
  return { ...h, participation };
}
