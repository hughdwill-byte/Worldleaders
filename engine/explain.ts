// Plain-language "why did this happen?" for engine-driven events, built from the state that drove them.
// Events caused by a leader's order carry data.by (the order + the leader's reasoning) instead.
import type { Country, SimEvent, World } from './types.ts';
import { type Ctx } from './ops.ts';
import { strength } from './world.ts';
import { debtRatio } from './directives.ts';
import { avgApproval } from './turn.ts';

const pct = (x: number) => `${Math.round(x)}`;
function domestic(c: Country) {
  const worst = [...c.blocs].sort((a, b) => a.realApproval - b.realApproval)[0];
  const mil = c.blocs.find(b => b.kind === 'military');
  const griev = [...new Set(c.blocs.flatMap(b => b.grievances))];
  return [
    `government approval ${pct(avgApproval(c))}/100 (lowest: ${worst.name} ${pct(worst.realApproval)})`,
    `unrest ${pct(c.unrest)}/100, stability ${pct(c.stability)}/100`,
    griev.length ? `grievances: ${griev.join(', ')}` : '',
    `inflation ${c.inflation.toFixed(1)}%, unemployment ${c.unemployment.toFixed(1)}%, growth ${c.growth.toFixed(1)}%`,
    c.repression > 0.5 ? `repression high (${c.repression.toFixed(2)})` : '',
    c.suppressed > 20 ? `suppressed discontent ${pct(c.suppressed)}/100 (hidden by media control)` : '',
    mil ? `military approval ${pct(mil.realApproval)}` : '',
  ].filter(Boolean).join('; ');
}

export function explain(x: Ctx, e: SimEvent): string | null {
  const w: World = x.w, c = w.countries[e.countries[0]];
  const t = e.type;
  if (/^(unrest_|insurgency|discontent_erupts|terror_attack|resistance)/.test(t) && c) return `Domestic pressures in ${c.name}: ${domestic(c)}.`;
  if (/^(coup|defection)/.test(t) && c) return `Coups become likely when the military is alienated and the state is unstable. ${c.name}: monthly coup risk was ${(c.coupRisk * 100).toFixed(2)}%; ${domestic(c)}.`;
  if (/^(civil_war|regime_collapse|separatism|insurgency_defeated)/.test(t) && c) {
    const fs = Object.values(w.factions).filter(f => f.country === c.iso3);
    return `Armed opposition in ${c.name}: ${fs.map(f => `${f.name} (${f.ideology}${f.group ? ', ' + f.group : ''}) strength ${(f.strength / Math.max(1e-6, strength(c))).toFixed(2)}× the government's, holding ${f.regions.length} regions${f.backers.length ? `, backed by ${f.backers.join(', ')}` : ''}`).join('; ') || 'none left'}. ${domestic(c)}.`;
  }
  if (t === 'region_captured' || t === 'capital_fallen') {
    const war = w.wars.find(v => v.id === (e.data as any)?.war);
    if (!war) return null;
    const side = (m: string[]) => m.map(i => i.startsWith('rebel:') ? (w.factions[i.slice(6)]?.name ?? 'rebels') : w.countries[i]?.name).join(', ');
    const st = (m: string[]) => m.reduce((a, i) => a + (i.startsWith('rebel:') ? (w.factions[i.slice(6)]?.strength ?? 0) : w.countries[i]?.alive ? strength(w.countries[i]) : 0), 0);
    const r = (e.data as any)?.region; const reg = r != null ? x.s.regions[r] : null;
    return `${war.name}: ${side(war.attackers)} (force ${st(war.attackers).toFixed(0)}) vs ${side(war.defenders)} (force ${st(war.defenders).toFixed(0)}). Captures need about a 3:1 local advantage after terrain${reg ? ` (${reg.name}: ${reg.terrain})` : ''}, supply distance and morale; war-weariness ${Object.entries(war.exhaustion).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ') || 'low'}.`;
  }
  if (/^(financial_crisis|debt_crisis|imf_loan)/.test(t) && c) return `${c.name}: public debt ${Math.round(debtRatio(c) * 100)}% of GDP, budget balance ${c.budgetBalance.toFixed(1)}% of GDP, borrowing cost ${(c.interestRate * 100).toFixed(1)}%. High debt raises the chance of a crisis each month.`;
  if (t === 'election' && c) return `Seats follow how influential groups view the government: approval ${pct(avgApproval(c, false))}/100${['liberal_democracy', 'electoral_democracy'].includes(c.govType) ? '' : '; elections are only partly fair in this system'}.`;
  if (t === 'scandal' && c) return `Corruption level ${(c.corruption * 100).toFixed(0)}/100; a free press (${(c.info.pressFreedom * 100).toFixed(0)}/100) made it public.`;
  if (/^(disaster|crop_failure|pandemic|oil_shock)/.test(t)) return `Random world event (seeded). Global scarcity index ${(w.global.scarcity * 100).toFixed(1)}, food price index ${(w.global.foodPrice * 100).toFixed(0)}, oil ${(w.global.oilPrice * 100).toFixed(0)}.${c ? ` ${c.name} welfare + health spending ${(c.spending.welfare + c.spending.health).toFixed(1)}% of GDP shapes how the public judges the response.` : ''}`;
  if (t === 'refugees' && c) return `Fighting or collapse in ${c.name} (stage: ${['calm', 'discontent', 'protests', 'strikes', 'riots', 'insurgency', 'civil war'][c.stage]}) drives people to neighbours; open borders attract more of them.`;
  if (t === 'ally_joins_war' || t === 'org_suspension' || t === 'recognition') return `Rule-based: treaty obligations, bloc rules and attitudes between governments.`;
  return null;
}

/** Attach data.why to every event that has neither an explanation nor a causing order. */
export function explainAll(x: Ctx, evs: SimEvent[]) {
  for (const e of evs) {
    const d = (e.data ??= {}) as Record<string, unknown>;
    if (d.why || d.by) continue;
    const why = explain(x, e);
    if (why) d.why = why; else if (!Object.keys(d).length) delete e.data;
  }
}
