// Rule-based stand-in leaders (free). Plausible choices shaped by the incentive weights, including occasional
// invasions, crackdowns and annexations, so every engine system gets exercised during development.
import type { AgentResponse, Directive, World } from '../engine/types.ts';
import type { Statics } from '../engine/world.ts';
import { strength } from '../engine/world.ts';
import { enemies, regionsOf, warsOf } from '../engine/ops.ts';
import { borrowLimit, debtRatio } from '../engine/directives.ts';
import { isDemocracy } from '../engine/regime.ts';
import { Rng, hash } from '../engine/util.ts';

export function mockDecide(w: World, s: Statics, iso: string): AgentResponse {
  const rng = new Rng(hash(`${w.seed}:${w.turn}:${iso}`));
  const c = w.countries[iso], k = c.incentives, dem = isDemocracy(c.govType);
  const D: Directive[] = [], cables: AgentResponse['cables'] = [];
  const notes: string[] = [];
  // fiscal
  if (c.budgetBalance < -5 || (c.budgetBalance < -1 && debtRatio(c) > borrowLimit(c) * 0.9)) {
    if (dem && rng.chance(0.5)) D.push({ type: 'set_tax', amount: +(c.taxRate + 1).toFixed(1), order: 'Raise revenue to stabilise public finances.' });
    else D.push({ type: 'set_spending', sub: 'infrastructure', amount: Math.max(0.5, c.spending.infrastructure - 0.5), order: 'Defer capital projects.' });
    if (debtRatio(c) > borrowLimit(c) * 0.95 && !(c.austerityUntil && c.austerityUntil > w.turn)) D.push({ type: 'imf_loan_request', order: 'Open talks with the IMF.' });
    notes.push('fiscal consolidation');
  } else if (c.budgetBalance > -2) {
    const area = rng.weighted({ health: k.welfare, welfare: k.welfare + k.approval, education: k.welfare * 0.7, military: k.power + k.survival * 0.5, security: k.survival * 0.6, infrastructure: 0.3, research: k.power * 0.3 });
    D.push({ type: 'set_spending', sub: area, amount: +(c.spending[area as keyof typeof c.spending] + 0.3).toFixed(2), order: `Increase ${area} spending.` });
    notes.push(`more ${area} spending`);
  }
  if (c.inflation > 8) D.push({ type: 'monetary_policy', amount: 1, order: 'Tighten monetary policy.' });
  else if (c.growth < 0 && c.inflation < 4) D.push({ type: 'monetary_policy', amount: -0.5, order: 'Ease monetary policy.' });
  // domestic unrest
  if (c.stage >= 2) {
    if (dem || k.approval > 0.22) { D.push({ type: rng.chance(0.5) ? 'concessions' : 'reforms', order: 'Address protesters’ demands.' }); notes.push('concessions'); }
    else {
      D.push({ type: 'repression_level', amount: Math.min(1, c.repression + 0.15), order: 'Restore order.' });
      D.push({ type: 'media_control', sub: 'propaganda', order: 'Counter hostile narratives.' });
      if (c.stage >= 4) { D.push({ type: 'curfew', amount: 1 }); if (rng.chance(0.3)) D.push({ type: 'media_control', sub: 'internet_shutdown' }); }
      notes.push('crackdown');
    }
  } else if (c.curfew) D.push({ type: 'curfew', amount: 0 });
  if (c.coupRisk > 0.004 && !dem) { D.push({ type: 'purge', sub: 'military', order: 'Remove disloyal officers.' }); notes.push('purge'); }
  const sepRegions = regionsOf(w, iso, 'owner').filter(i => s.regions[i].group && w.regions[i].unrest > 55 && !w.regions[i].autonomy);
  if (sepRegions.length && (dem || rng.chance(0.2))) D.push({ type: 'grant_autonomy', regions: sepRegions.slice(0, 3).map(i => s.regions[i].name) });
  if (c.refugeesHosted / c.pop > 0.01 && c.refugeePolicy !== 'closed') D.push({ type: 'refugee_policy', sub: dem ? 'restricted' : 'closed' });
  // wars in progress
  for (const war of warsOf(w, iso)) {
    if (war.civil) { if (!dem) D.push({ type: 'military_mobilize', amount: 0.5 }); continue; }
    const other = (war.attackers.includes(iso) ? war.defenders : war.attackers)[0];
    if ((war.exhaustion[iso] ?? 0) > 55 && rng.chance(0.4)) { D.push({ type: 'ceasefire_propose', target: other, order: 'Seek an end to hostilities.' }); notes.push('ceasefire offer'); }
  }
  for (const p of w.pendingProposals.filter(p => p.to === iso && p.turn === w.turn - 1)) {
    const a = w.attitudes[iso][p.from] ?? 0;
    if (p.type === 'ceasefire_propose' || p.type === 'peace_treaty') {
      const war = warsOf(w, iso).find(v => v.attackers.includes(p.from) || v.defenders.includes(p.from));
      if (war && ((war.exhaustion[iso] ?? 0) > 35 || rng.chance(0.3))) D.push({ type: 'ceasefire_accept', target: p.from });
    }
    if (p.type === 'trade_deal_propose' && a > 0) D.push({ type: 'trade_deal_accept', target: p.from });
    if (p.type === 'alliance_propose' && a > 35) D.push({ type: 'alliance_accept', target: p.from });
    if (p.type === 'aid_request' && a > 40 && c.incomeGroup === 'high') D.push({ type: 'aid_give', target: p.from, amount: Math.round(c.gdp * 0.0002 / 1e6) });
  }
  // occupied territory: power-seekers annex once the war is over or the region is consolidated
  const occupied = regionsOf(w, iso).filter(i => w.regions[i].owner !== iso && (w.turn - (w.regions[i].occupiedSince ?? w.turn)) >= 3);
  if (occupied.length && rng.chance(k.power * 0.4)) { D.push({ type: 'annex_region', regions: occupied.slice(0, 4).map(i => s.regions[i].name), order: 'Formalise the reunification of these territories.' }); notes.push('annexation'); }
  // opportunistic aggression against weaker rivals with a claim or a border
  if (!warsOf(w, iso).length && rng.chance(0.004 + 0.03 * k.power * (dem ? 0.2 : 1))) {
    const rivals = Object.entries(w.attitudes[iso]).filter(([o, v]) => v < -35 && w.countries[o]?.alive).map(([o]) => o);
    const claims = new Set<string>(s.relations.disputes.filter((d: any) => d.claimants.includes(iso)).flatMap((d: any) => d.claimants));
    const target = rivals
      .filter(o => strength(c) > strength(w.countries[o]) * 1.8 && !w.countries[o].nuclear && regionsOf(w, iso).some(i => s.regions[i].nb.some(n => w.regions[n].controller === o)))
      .sort((a, b) => (claims.has(b) ? 1 : 0) - (claims.has(a) ? 1 : 0))[0];
    if (target) { D.push({ type: 'invade', target, order: 'Secure our national interests across the border.' }); D.push({ type: 'military_mobilize', amount: 0.6 }); notes.push(`invasion of ${target}`); }
  }
  // diplomacy
  const ranked = Object.entries(w.attitudes[iso]).filter(([o]) => w.countries[o]?.alive).sort((a, b) => b[1] - a[1]);
  const friend = ranked[rng.int(0, 4)]?.[0], foe = ranked.at(-1 - rng.int(0, 3))?.[0];
  if (friend && rng.chance(0.3)) {
    const t = w.treaties.some(q => q.kind === 'trade' && [q.a, q.b].includes(iso) && [q.a, q.b].includes(friend)) ? 'alliance_propose' : 'trade_deal_propose';
    const allied = w.treaties.some(q => q.kind === 'alliance' && [q.a, q.b].includes(iso) && [q.a, q.b].includes(friend));
    if ((t === 'trade_deal_propose' && rng.chance(0.12)) || (t === 'alliance_propose' && !allied && w.attitudes[iso][friend] > 60 && rng.chance(0.2))) D.push({ type: t, target: friend });
    cables.push({ to: friend, private: true, text: `We value our partnership and propose deeper cooperation on trade and security.` });
  }
  if (foe && w.attitudes[iso][foe] < -50) {
    if (rng.chance(0.15) && !w.sanctions.some(q => q.by === iso && q.target === foe)) D.push({ type: 'sanction', target: foe, amount: 0.3 });
    if (rng.chance(0.2)) cables.push({ to: foe, private: false, text: `We warn against further hostile actions; there will be consequences.` });
    if (!dem && k.power > 0.27 && rng.chance(0.1)) D.push({ type: 'covert_op', target: foe, sub: rng.pick(['fund_opposition', 'cyber', 'fund_rebels']) });
  }
  for (const e of enemies(w, iso)) if (!e.startsWith('rebel:') && !w.sanctions.some(q => q.by === iso && q.target === e) && rng.chance(0.3)) D.push({ type: 'sanction', target: e, amount: 0.6 });
  if (w.countries[iso].pendingDraft == null && !dem && c.constitution.emergencyPowers === 'broad' && c.stage >= 4 && rng.chance(0.1))
    D.push({ type: 'constitutional_change', sub: 'emergency powers', order: 'Extend emergency powers to restore order.' });
  return {
    assessment: `Mock leader: ${['calm', 'discontent', 'protests', 'strikes', 'riots', 'insurgency', 'civil war'][c.stage]} at home, growth ${c.growth.toFixed(1)}%. Priorities: ${notes.join(', ') || 'continuity'}.`,
    directives: D, cables,
    public_statement: c.stage >= 4 ? 'Order will be restored and those responsible held accountable.' : `Our government remains focused on the prosperity and security of ${c.name}.`,
  };
}
