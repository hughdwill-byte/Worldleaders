// Countries not reviewed by the AI this month run on autopilot: they execute the standing orders (≤5 conditional
// rules) their own AI leader wrote at its last review. Conditions are a small fixed vocabulary, checked against the world.
import type { AgentResponse, Country, World } from '../engine/types.ts';
import type { Statics } from '../engine/world.ts';
import { LADDER } from '../engine/constants.ts';

export function conditionHolds(w: World, s: Statics, c: Country, when: string): boolean {
  const [k, v] = when.split(':'); const n = Number(v);
  switch (k) {
    case 'always': return true;
    case 'at_war': return w.wars.some(x => x.active && (x.attackers.includes(c.iso3) || x.defenders.includes(c.iso3)));
    case 'under_sanctions': return w.sanctions.some(x => x.target === c.iso3);
    case 'coup_risk_high': return c.coupRisk > 0.004;
    case 'neighbour_mobilised': return ((s.countryData[c.iso3]?.borders ?? []) as string[]).some(b => (w.countries[b]?.mobilized ?? 0) > 0.3);
    case 'unrest_at_least': return c.stage >= LADDER.indexOf(v as typeof LADDER[number]);
    case 'inflation_above': return c.inflation > n;
    case 'deficit_above': return -c.budgetBalance > n;
    case 'unemployment_above': return c.unemployment > n;
    case 'growth_below': return c.growth < n;
    default: return false;
  }
}

export function autopilot(w: World, s: Statics, iso: string): AgentResponse | null {
  const c = w.countries[iso];
  const orders = (c.standingOrders ?? []).filter(o => conditionHolds(w, s, c, o.when));
  if (!c.standingOrders?.length) return null;
  return {
    assessment: `(standing orders from the last review: ${c.standingOrders.map(o => `if ${o.when} → ${o.do.type}`).join('; ')})`,
    directives: orders.map(o => ({ ...o.do, order: `[standing order: ${o.when}] ${o.do.order ?? ''}`.trim() })), cables: [], public_statement: '', source: 'standing',
  };
}
