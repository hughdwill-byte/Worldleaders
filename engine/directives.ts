// Validates and applies leaders' directives. Invalid/unaffordable orders are rejected with a reason
// that appears in the next monthly briefing.
import type { AgentResponse, Country, Directive } from './types.ts';
import { ATT, ECON, INFO } from './constants.ts';
import { type Ctx, addSanction, alive, allied, annex, atWar, declareWar, endWar, enemies, log, regimeChange, regionsOf, setController, shift, transferRegion, warsOf, worldReact } from './ops.ts';
import { isDemocracy } from './regime.ts';
import { clamp } from './util.ts';

export const DIRECTIVE_TYPES = [
  'set_tax', 'set_spending', 'monetary_policy', 'trade_deal_propose', 'trade_deal_accept', 'trade_deal_cancel', 'tariff', 'sanction', 'lift_sanction',
  'aid_give', 'aid_request', 'alliance_propose', 'alliance_accept', 'alliance_leave', 'military_mobilize', 'military_demobilize', 'military_deploy',
  'declare_war', 'invade', 'occupy', 'ceasefire_propose', 'ceasefire_accept', 'peace_treaty', 'annex_region', 'withdraw', 'install_puppet_government',
  'demand_concessions', 'blockade', 'grant_autonomy', 'cede_region', 'recognize_state', 'repression_level', 'concessions', 'reforms', 'curfew', 'purge',
  'civil_liberties', 'media_control', 'foreign_influence_op', 'constitutional_change', 'covert_op', 'arms_sale', 'arms_embargo', 'refugee_policy',
  'join_organisation', 'leave_organisation', 'un_resolution', 'imf_loan_request', 'invest_infrastructure', 'invest_research', 'resource_policy',
] as const;
const SPEND_KEYS = ['health', 'education', 'welfare', 'infrastructure', 'military', 'security', 'research'] as const;

export function totalSpending(c: Country) { return SPEND_KEYS.reduce((a, k) => a + c.spending[k], 0); }
export function borrowLimit(c: Country) { return c.incomeGroup === 'high' ? ECON.borrowLimitRich : ECON.borrowLimitPoor; }
export const debtRatio = (c: Country) => Math.min(5, c.debt / Math.max(1, c.gdp)); // capped so a collapsed economy can't explode the maths

function reject(c: Country, d: Directive, why: string) { c.rejections.push(`${d.type}${d.target ? ' (' + d.target + ')' : ''}: ${why}`); }

/** Legislature can block fiscal/war measures when it is hostile; returns true if blocked. */
function legislatureBlocks(x: Ctx, c: Country, d: Directive) {
  const L = c.constitution.legislature;
  const p = L.powers * Math.max(0, 0.5 - c.legislatureSupport) * 2;
  if (p > 0 && x.rng.chance(p)) { reject(c, d, 'The legislature voted the measure down.'); log(x, 'legislature_blocks', [c.iso3], `The legislature of ${c.name} blocks the government's ${d.type.replace(/_/g, ' ')}.`); return true; }
  return false;
}
/** Courts can strike down rights-restricting measures depending on independence. */
function courtsStrike(x: Ctx, c: Country, d: Directive, severity = 1) {
  const p = c.constitution.courts.independence * 0.6 * severity;
  if (x.rng.chance(p)) { reject(c, d, 'The courts struck the measure down as unconstitutional.'); log(x, 'court_strikes', [c.iso3], `Courts in ${c.name} strike down the government's ${d.type.replace(/_/g, ' ')}.`); return true; }
  return false;
}

function regionIds(x: Ctx, names: string[] | undefined, pred: (id: number) => boolean): number[] {
  if (!names?.length) return [];
  const want = new Set(names.map(n => n.toLowerCase().trim()));
  return x.s.regions.filter(r => want.has(r.name.toLowerCase()) && pred(r.id)).map(r => r.id);
}

/** Border regions of target adjacent to territory controlled by iso; disputed ones first. */
export function borderTargets(x: Ctx, iso: string, target: string): number[] {
  const mine = new Set(regionsOf(x.w, iso));
  const disputed = new Set<number>(x.s.relations.disputes.filter((dp: any) => dp.claimants.includes(iso)).flatMap((dp: any) => dp.regions));
  const out = new Set<number>();
  for (const id of mine) for (const n of x.s.regions[id].nb) if (x.w.regions[n].controller === target) out.add(n);
  return [...out].sort((a, b) => (disputed.has(b) ? 1 : 0) - (disputed.has(a) ? 1 : 0));
}

export function applyDecisions(x: Ctx, decisions: Record<string, AgentResponse>) {
  const w = x.w;
  for (const iso of Object.keys(decisions).sort()) {
    const c = w.countries[iso]; if (!c?.alive) continue;
    const resp = decisions[iso];
    c.leader.lastAssessment = resp.assessment; c.leader.lastStatement = resp.public_statement;
    for (const d of (resp.directives ?? []).slice(0, 12)) {
      try { apply(x, c, d); } catch (e) { reject(c, d, 'The Secretariat could not execute this order (' + (e as Error).message + ').'); }
    }
    for (const cb of (resp.cables ?? []).slice(0, 8)) {
      if (!w.countries[cb.to]?.alive || cb.to === iso) continue;
      const cable = { from: iso, to: cb.to, private: cb.private !== false, text: String(cb.text).slice(0, 1500), turn: w.turn, intercepted: [] as string[] };
      if (cable.private) for (const o of alive(w)) if (o !== iso && o !== cb.to && w.countries[o].info.surveillance > 0.6 && w.countries[o].tech > 1.3 && x.rng.chance(INFO.interceptChance)) cable.intercepted.push(o);
      w.cables.push(cable);
      const tone = /\b(threat|warn|consequences|ultimatum|demand|hostile|aggression)\w*/i.test(cable.text) ? -ATT.cableTone : /\b(friend|partner|cooperat|welcome|thank|support)\w*/i.test(cable.text) ? ATT.cableTone : 0;
      shift(w, iso, cb.to, tone);
    }
  }
}

function apply(x: Ctx, c: Country, d: Directive) {
  const w = x.w, iso = c.iso3, rng = x.rng;
  const t = d.target && w.countries[d.target]?.alive ? w.countries[d.target] : null;
  const amt = Number(d.amount ?? 0) || 0;
  const needT = () => { if (!t || t.iso3 === iso) throw new Error('no valid target country'); return t; };
  const sub = (d.sub ?? (d.target && !w.countries[d.target] ? d.target : '') ?? '').toString().toLowerCase();
  switch (d.type) {
    case 'set_tax': {
      const v = clamp(amt, 3, 60);
      if (Math.abs(v - c.taxRate) > 0.01 && !legislatureBlocks(x, c, d)) {
        const up = v - c.taxRate; c.taxRate = v;
        for (const b of c.blocs) if (b.kind === 'business' || b.kind === 'workers') b.realApproval = clamp(b.realApproval - up * 1.5);
        c.policyNotes.push(`tax set to ${v.toFixed(1)}% of GDP`);
      }
      return;
    }
    case 'set_spending': case 'invest_infrastructure': case 'invest_research': {
      const key = (d.type === 'invest_infrastructure' ? 'infrastructure' : d.type === 'invest_research' ? 'research' : SPEND_KEYS.find(k => sub.includes(k) || (d.order ?? '').toLowerCase().includes(k))) as typeof SPEND_KEYS[number] | undefined;
      if (!key) return reject(c, d, 'Specify a spending area: health, education, welfare, infrastructure, military, security or research.');
      const v = d.type === 'set_spending' ? clamp(amt, 0, 30) : clamp(c.spending[key] + clamp(amt || 0.5, 0, 5), 0, 30);
      const extra = v - c.spending[key];
      if (extra > 0 && debtRatio(c) > borrowLimit(c) && c.taxRate < totalSpending(c) + extra) return reject(c, d, 'The Treasury advises this exceeds available funds: debt is at the borrowing limit.');
      if (extra > 0 && c.austerityUntil && w.turn < c.austerityUntil) return reject(c, d, 'IMF programme conditions prohibit new spending increases.');
      if (Math.abs(extra) > 0.01 && !legislatureBlocks(x, c, d)) { c.spending[key] = v; c.policyNotes.push(`${key} spending ${v.toFixed(1)}% of GDP`); }
      return;
    }
    case 'monetary_policy': c.policyRate = clamp(c.policyRate + clamp(amt, -5, 5), -5, 15); return;
    case 'trade_deal_propose': case 'alliance_propose': case 'aid_request': case 'ceasefire_propose': case 'peace_treaty': case 'demand_concessions': {
      const tt = needT();
      w.pendingProposals.push({ from: iso, to: tt.iso3, type: d.type, amount: amt, turn: w.turn, regions: d.regions });
      if (d.type === 'demand_concessions') shift(w, iso, tt.iso3, -10);
      return;
    }
    case 'trade_deal_accept': case 'alliance_accept': case 'ceasefire_accept': {
      const tt = needT(); const want = d.type.replace('_accept', '');
      const p = w.pendingProposals.find(p => p.to === iso && p.from === tt.iso3 && (p.type.startsWith(want) || (want === 'ceasefire' && p.type === 'peace_treaty')));
      if (!p) return reject(c, d, `There is no outstanding ${want.replace('_', ' ')} proposal from ${tt.name}.`);
      w.pendingProposals = w.pendingProposals.filter(q => q !== p);
      const exists = w.treaties.some(q => q.kind === (want === 'trade_deal' ? 'trade' : 'alliance') && [q.a, q.b].includes(iso) && [q.a, q.b].includes(tt.iso3));
      if (exists && want !== 'ceasefire') return;
      if (want === 'trade_deal') { w.treaties.push({ a: iso, b: tt.iso3, kind: 'trade', since: w.turn }); shift(w, iso, tt.iso3, 8); shift(w, tt.iso3, iso, 8); log(x, 'trade_deal', [iso, tt.iso3], `${c.name} and ${tt.name} sign a trade agreement.`); }
      if (want === 'alliance') { w.treaties.push({ a: iso, b: tt.iso3, kind: 'alliance', since: w.turn }); shift(w, iso, tt.iso3, ATT.alliance); shift(w, tt.iso3, iso, ATT.alliance); log(x, 'alliance', [iso, tt.iso3], `${c.name} and ${tt.name} conclude a mutual defence alliance.`, true); }
      if (want === 'ceasefire') {
        for (const war of warsOf(w, iso)) if (war.attackers.includes(tt.iso3) || war.defenders.includes(tt.iso3)) {
          endWar(x, war, p.type === 'peace_treaty' ? 'peace treaty' : 'ceasefire');
          w.treaties.push({ a: iso, b: tt.iso3, kind: p.type === 'peace_treaty' ? 'peace' : 'ceasefire', since: w.turn });
          const terms = w.pendingProposals.find(q => q.type === 'demand_concessions' && q.from === tt.iso3 && q.to === iso);
          if (terms) for (const id of regionIds(x, terms.regions, i => w.regions[i].owner === iso)) transferRegion(x, id, tt.iso3, 'cession');
        }
      }
      return;
    }
    case 'trade_deal_cancel': { const tt = needT(); w.treaties = w.treaties.filter(q => !(q.kind === 'trade' && [q.a, q.b].includes(iso) && [q.a, q.b].includes(tt.iso3))); shift(w, iso, tt.iso3, -8); return; }
    case 'alliance_leave': { const tt = needT(); w.treaties = w.treaties.filter(q => !(q.kind === 'alliance' && [q.a, q.b].includes(iso) && [q.a, q.b].includes(tt.iso3))); shift(w, iso, tt.iso3, -20); log(x, 'alliance_ended', [iso, tt.iso3], `${c.name} withdraws from its alliance with ${tt.name}.`, true); return; }
    case 'tariff': { const tt = needT(); c.tariffs[tt.iso3] = clamp(amt, 0, 200); shift(w, iso, tt.iso3, -clamp(amt / 5, 0, 15)); return; }
    case 'sanction': { const tt = needT(); addSanction(x, iso, tt.iso3, clamp(amt || 0.5, 0.05, 1)); log(x, 'sanctions', [iso, tt.iso3], `${c.name} imposes sanctions on ${tt.name}.`); return; }
    case 'lift_sanction': { const tt = needT(); w.sanctions = w.sanctions.filter(s => !(s.by === iso && s.target === tt.iso3 && !s.un)); shift(w, iso, tt.iso3, 10); log(x, 'sanctions_lifted', [iso, tt.iso3], `${c.name} lifts sanctions on ${tt.name}.`); return; }
    case 'aid_give': {
      const tt = needT(); const usd = clamp(amt, 0, 1e6) * 1e6 || c.gdp * 0.0005;
      if (usd > c.gdp * 0.02) return reject(c, d, 'The Treasury advises aid above 2% of GDP in a single month is not possible.');
      c.debt += usd; tt.debt = Math.max(0, tt.debt - usd * 0.5); tt.gdp += usd * 0.3;
      shift(w, iso, tt.iso3, ATT.aid + Math.min(10, usd / tt.gdp * 1000));
      log(x, 'aid', [iso, tt.iso3], `${c.name} provides $${(usd / 1e6).toFixed(0)}m in aid to ${tt.name}.`);
      return;
    }
    case 'military_mobilize': {
      const v = clamp(amt || c.mobilized + 0.25, 0, 1); if (v <= c.mobilized) return;
      for (const b of c.blocs) b.realApproval -= (isDemocracy(c.govType) ? 6 : 2) * (v - c.mobilized);
      if (c.mobilized < 0.2) log(x, 'mobilization', [iso], `${c.name} orders military mobilisation.`);
      c.mobilized = v; return;
    }
    case 'military_demobilize': c.mobilized = clamp(amt ? c.mobilized - amt : 0, 0, 1); return;
    case 'military_deploy': { const tt = needT(); c.readiness = clamp(c.readiness + 0.05, 0, 1); shift(w, iso, tt.iso3, -8); log(x, 'deployment', [iso, tt.iso3], `${c.name} deploys forces to its border with ${tt.name}.`); return; }
    case 'declare_war': case 'invade': case 'occupy': {
      const tt = needT();
      if (allied(w, iso, tt.iso3) && d.type === 'declare_war') return reject(c, d, `${tt.name} is a treaty ally; the alliance must be renounced first.`);
      let goals = regionIds(x, d.regions, i => w.regions[i].controller === tt.iso3);
      if (!goals.length) goals = borderTargets(x, iso, tt.iso3).slice(0, 6);
      if (!goals.length && !tt.core.some(i => x.s.regions[i].coastal)) return reject(c, d, `The General Staff reports no feasible axis of advance into ${tt.name}.`);
      if (!goals.length) goals = tt.core.filter(i => x.s.regions[i].coastal && w.regions[i].controller === tt.iso3).slice(0, 2); // amphibious
      const war = warsOf(w, iso).find(v => v.attackers.includes(tt.iso3) || v.defenders.includes(tt.iso3));
      if (war) war.goals = [...new Set([...war.goals, ...goals])];
      else declareWar(x, iso, tt.iso3, goals, d.order?.slice(0, 160));
      if (c.mobilized < 0.3) c.mobilized = 0.3;
      return;
    }
    case 'annex_region': {
      const held = regionIds(x, d.regions, i => w.regions[i].controller === iso && w.regions[i].owner !== iso);
      const ids = held.length ? held : d.target ? regionsOf(w, iso).filter(i => w.regions[i].owner === d.target) : [];
      if (!ids.length) return reject(c, d, 'Only territory under our military control can be annexed.');
      for (const id of ids) {
        const owner = w.regions[id].owner;
        const fighting = atWar(w, iso, owner) && (w.regions[id].occupiedSince ?? w.turn) > w.turn - 3;
        if (fighting) { reject(c, d, `${x.s.regions[id].name} is still contested; annexation requires the war to be won or the region held for 3 months.`); continue; }
        annex(x, id, iso);
      }
      return;
    }
    case 'withdraw': {
      const ids = (d.regions?.length ? regionIds(x, d.regions, i => w.regions[i].controller === iso) : regionsOf(w, iso).filter(i => w.regions[i].owner === (d.target ?? '') && w.regions[i].owner !== iso));
      for (const id of ids) setController(x, id, w.regions[id].owner);
      if (ids.length) log(x, 'withdrawal', [iso, d.target ?? ''], `${c.name} withdraws its forces from ${ids.length} occupied region(s).`);
      return;
    }
    case 'install_puppet_government': {
      const tt = needT();
      if (w.regions[tt.capital].controller !== iso) return reject(c, d, `We do not control ${tt.name}'s capital.`);
      for (const war of warsOf(w, iso)) if (war.defenders.includes(tt.iso3) || war.attackers.includes(tt.iso3)) endWar(x, war, 'puppet government installed');
      for (const id of regionsOf(w, iso).filter(i => w.regions[i].owner === tt.iso3)) setController(x, id, tt.iso3);
      regimeChange(x, tt.iso3, { winner: 'foreign', violent: true, occupier: iso, how: `a government installed by ${c.name}` });
      worldReact(x, iso, -10, tt.iso3, -10);
      return;
    }
    case 'blockade': {
      const tt = needT(); shift(w, iso, tt.iso3, -25); c.tariffs[tt.iso3] = 300;
      const choke = x.s.relations.chokepoints.find((ch: any) => ch.regions.some((i: number) => w.regions[i].controller === iso));
      if (choke && (choke.users.includes(tt.iso3) || choke.users.includes('*'))) { w.global.oilPrice *= 1 + choke.oilShare; log(x, 'chokepoint_closed', [iso, tt.iso3], `${c.name} blockades shipping through the ${choke.name}; oil prices jump.`, true); }
      else log(x, 'blockade', [iso, tt.iso3], `${c.name} imposes a naval blockade on ${tt.name}.`, true);
      return;
    }
    case 'grant_autonomy': {
      const ids = regionIds(x, d.regions, i => w.regions[i].owner === iso);
      const all = ids.length ? ids : regionsOf(w, iso, 'owner').filter(i => x.s.regions[i].group);
      for (const id of all) w.regions[id].autonomy = true;
      for (const b of c.blocs) b.realApproval = clamp(b.realApproval + (b.kind === 'minority' ? 20 : b.kind === 'military' ? -4 : -1));
      if (all.length) log(x, 'autonomy', [iso], `${c.name} grants autonomy to ${all.length} region(s).`);
      return;
    }
    case 'cede_region': {
      const tt = needT(); const ids = regionIds(x, d.regions, i => w.regions[i].owner === iso);
      if (!ids.length) return reject(c, d, 'Name regions we own to cede.');
      for (const id of ids) transferRegion(x, id, tt.iso3, 'cession');
      log(x, 'cession', [iso, tt.iso3], `${c.name} cedes ${ids.map(i => x.s.regions[i].name).join(', ')} to ${tt.name}.`, true);
      return;
    }
    case 'recognize_state': { const tt = needT(); (w.recognitions[tt.iso3] ??= []).includes(iso) || w.recognitions[tt.iso3].push(iso); shift(w, iso, tt.iso3, 15); return; }
    case 'repression_level': {
      const v = clamp(amt, 0, 1);
      if (v > c.repression + 0.1 && courtsStrike(x, c, d, v)) return;
      c.repression = v; return;
    }
    case 'concessions': case 'reforms': {
      const cost = c.gdp * 0.002; c.debt += cost;
      for (const b of c.blocs) { b.realApproval = clamp(b.realApproval + (b.unrest > 30 ? 8 : 3)); b.unrest *= 0.85; }
      if (d.type === 'reforms') { c.civilLiberties = clamp(c.civilLiberties + 0.03, 0, 1); c.corruption = clamp(c.corruption - 0.01, 0, 1); }
      log(x, d.type, [iso], `${c.name} announces ${d.type === 'reforms' ? 'reforms' : 'concessions to protesters'}.`);
      return;
    }
    case 'curfew': c.curfew = amt !== 0; return;
    case 'purge': {
      c.purgedAt = w.turn; c.readiness = clamp(c.readiness - 0.1, 0.2, 1);
      for (const b of c.blocs) if (b.kind === 'military' || (sub.includes('elite') && b.kind === 'business')) { b.realApproval = clamp(b.realApproval - 12); b.approval = clamp(b.approval - 6); }
      log(x, 'purge', [iso], `Purge of the ${sub.includes('elite') ? 'political and business elite' : 'officer corps'} in ${c.name}.`);
      return;
    }
    case 'civil_liberties': {
      const restrict = /restrict|limit|curtail|suspend/.test(sub + ' ' + (d.order ?? '').toLowerCase());
      if (restrict && courtsStrike(x, c, d)) return;
      c.civilLiberties = clamp(c.civilLiberties + (restrict ? -0.1 : 0.1), 0.02, 1);
      for (const b of c.blocs) if (b.kind === 'youth' || b.kind === 'minority') b.realApproval = clamp(b.realApproval + (restrict ? -8 : 6));
      return;
    }
    case 'media_control': {
      const s = sub + ' ' + (d.order ?? '').toLowerCase();
      const harsh = /censor|shutdown|surveil/.test(s);
      if (harsh && courtsStrike(x, c, d)) return;
      if (/shutdown/.test(s)) { c.info.internetShutdown = true; c.shocks.push({ growth: -1.5, months: 1, why: 'internet shutdown' }); log(x, 'internet_shutdown', [iso], `Authorities in ${c.name} shut down the internet.`); }
      else if (/censor/.test(s)) c.info.censorship = clamp(c.info.censorship + 0.15, 0, 1);
      else if (/propaganda/.test(s)) c.info.propaganda = clamp(c.info.propaganda + 0.2, 0, 1);
      else if (/surveil/.test(s)) c.info.surveillance = clamp(c.info.surveillance + 0.1, 0, 1);
      else if (/free|open|lift|restore/.test(s)) { c.info.censorship = clamp(c.info.censorship - 0.15, 0, 1); c.info.internetShutdown = false; c.info.pressFreedom = clamp(c.info.pressFreedom + 0.05, 0, 1); }
      if (harsh) c.info.pressFreedom = clamp(c.info.pressFreedom - 0.05, 0, 1);
      return;
    }
    case 'foreign_influence_op': case 'covert_op': {
      const tt = needT(); const s = d.type === 'foreign_influence_op' ? 'disinformation' : sub || 'sabotage';
      const skill = c.tech * (0.5 + c.info.surveillance);
      const success = rng.chance(clamp(0.3 + 0.2 * skill - 0.3 * tt.info.surveillance, 0.05, 0.9));
      if (success) {
        if (/disinfo/.test(s)) { tt.suppressed += 4 * (0.5 + tt.info.pressFreedom); for (const b of tt.blocs) b.realApproval -= 2; }
        else if (/fund_rebels|rebel/.test(s)) { for (const f of Object.values(w.factions)) if (f.country === tt.iso3 && f.active) { f.strength *= 1.15; if (!f.backers.includes(iso)) f.backers.push(iso); } for (const b of tt.blocs) b.unrest += 3; }
        else if (/opposition/.test(s)) for (const b of tt.blocs) b.realApproval -= 3;
        else if (/assassin/.test(s)) { if (rng.chance(0.15)) { regimeChange(x, tt.iso3, { winner: 'military', violent: true, how: 'the assassination of the head of government' }); log(x, 'assassination', [tt.iso3], `The Head of Government of ${tt.name} is assassinated.`, true); } }
        else if (/cyber/.test(s)) tt.shocks.push({ growth: -1, months: 2, why: 'cyberattack' });
        else { tt.milStock *= 0.98; tt.shocks.push({ growth: -0.5, months: 1, why: 'sabotage' }); }
      }
      if (rng.chance(0.3 * (1 - skill / 3) + 0.3 * tt.info.surveillance)) {
        shift(w, iso, tt.iso3, -25); worldReact(x, iso, -3);
        log(x, 'covert_op_exposed', [iso, tt.iso3], `${tt.name} exposes a ${s.replace(/_/g, ' ')} operation by ${c.name}.`, true);
      }
      return;
    }
    case 'constitutional_change': return constitutionalChange(x, c, d, sub);
    case 'arms_sale': {
      const tt = needT(); const usd = clamp(amt, 0, 50000) * 1e6 || 5e8;
      if (c.milStock < usd * 3) return reject(c, d, 'Our arsenal cannot spare this volume.');
      c.milStock -= usd * 0.5; c.debt -= usd * 0.5; tt.milStock += usd; tt.debt += usd * 0.5;
      shift(w, iso, tt.iso3, 10); for (const e of enemies(w, tt.iso3)) shift(w, iso, e, -15);
      log(x, 'arms_sale', [iso, tt.iso3], `${c.name} sells $${(usd / 1e9).toFixed(1)}bn of arms to ${tt.name}.`);
      return;
    }
    case 'arms_embargo': { const tt = needT(); addSanction(x, iso, tt.iso3, 0.15); tt.tech = Math.max(0.3, tt.tech - 0.005); return; }
    case 'refugee_policy': c.refugeePolicy = /open/.test(sub) ? 'open' : /close/.test(sub) ? 'closed' : 'restricted'; return;
    case 'join_organisation': case 'leave_organisation': {
      const name = Object.keys(w.blocs).find(k => k.toLowerCase() === (d.sub ?? d.target ?? '').toString().toLowerCase());
      if (!name) return reject(c, d, 'Unknown organisation.');
      const bl = w.blocs[name];
      if (d.type === 'leave_organisation') { bl.members = bl.members.filter(m => m !== iso); c.orgs = c.orgs.filter(o => o !== name); log(x, 'org_leave', [iso], `${c.name} leaves ${name}.`, true); return; }
      if (bl.members.includes(iso)) return;
      const avg = bl.members.reduce((a, m) => a + (w.attitudes[m]?.[iso] ?? 0), 0) / Math.max(1, bl.members.length);
      if (['EU', 'NATO'].includes(name) && !isDemocracy(c.govType)) return reject(c, d, `${name} membership requires democratic institutions.`);
      if (avg > 25 && rng.chance(0.5)) { bl.members.push(iso); c.orgs.push(name); log(x, 'org_join', [iso], `${c.name} joins ${name}.`, true); }
      else reject(c, d, `${name} members did not approve our accession at this time.`);
      return;
    }
    case 'un_resolution': return unResolution(x, c, d, sub);
    case 'imf_loan_request': {
      if (c.austerityUntil && w.turn < c.austerityUntil) return reject(c, d, 'An IMF programme is already in place.');
      if (debtRatio(c) < 0.5 && c.budgetBalance > -4) return reject(c, d, 'The IMF declined: no balance-of-payments need.');
      const usd = c.gdp * ECON.imfLoanPctGdp; c.debt += usd * 0.2; c.austerityUntil = w.turn + 12;
      for (const k of ['welfare', 'health', 'infrastructure'] as const) c.spending[k] *= 0.9;
      for (const b of c.blocs) if (b.kind === 'workers' || b.kind === 'retirees') b.realApproval -= 6;
      c.shocks.push({ growth: 0.8, months: 6, why: 'IMF financing restores confidence' });
      log(x, 'imf_loan', [iso], `The IMF approves a $${(usd / 1e9).toFixed(1)}bn programme for ${c.name}, with austerity conditions.`);
      return;
    }
    case 'resource_policy': {
      const s = sub + ' ' + (d.order ?? '').toLowerCase();
      if (/national/.test(s)) { c.resourcePolicy.nationalised = true; c.taxRate += 1; c.potentialGrowth -= 0.3; for (const b of c.blocs) b.realApproval += b.kind === 'business' ? -15 : 4; }
      if (/export_ban|ban/.test(s)) { c.resourcePolicy.exportBan = true; w.global.oilPrice *= 1 + c.resourceExposure * 0.3; }
      if (/production/.test(s)) { c.resourcePolicy.production = clamp(amt || 1, 0.3, 1.5); w.global.oilPrice *= 1 - (c.resourcePolicy.production - 1) * c.resourceExposure * 0.2; }
      return;
    }
    default: return reject(c, d, `Unknown directive type "${d.type}".`);
  }
}

function constitutionalChange(x: Ctx, c: Country, d: Directive, sub: string) {
  const k = c.constitution, s = (sub + ' ' + (d.order ?? '')).toLowerCase();
  const changes: [RegExp, () => void, string, number][] = [
    [/emergency/, () => { k.emergencyPowers = k.emergencyPowers === 'limited' ? 'broad' : 'unlimited'; }, 'expanded emergency powers', 0.5],
    [/weaken.*court|pack|court.*(control|appoint)/, () => { k.courts.independence = clamp(k.courts.independence - 0.3, 0, 1); }, 'curtailed judicial independence', 0.7],
    [/strengthen.*court|independen/, () => { k.courts.independence = clamp(k.courts.independence + 0.2, 0, 1); }, 'strengthened judicial independence', 0.3],
    [/restrict.*press|media law/, () => { k.liberties.press = false; c.info.pressFreedom -= 0.15; }, 'removed press-freedom guarantee', 0.6],
    [/guarantee|press freedom|bill of rights/, () => { k.liberties = { press: true, assembly: true, speech: true }; c.civilLiberties += 0.05; }, 'entrenched civil liberties', 0.3],
    [/abolish.*legislat|dissolve/, () => { k.legislature = { ...k.legislature, type: 'none', powers: 0, elected: false }; }, 'abolished the legislature', 1],
    [/restore.*legislat|elected legislat/, () => { k.legislature = { ...k.legislature, type: 'unicameral', powers: 0.6, elected: true, termYears: 4 }; c.nextElection = x.w.turn + 6; }, 'restored an elected legislature', 0.4],
    [/federal|devol/, () => { k.territorial = 'federal'; }, 'federalised the state', 0.4],
    [/central|unitary/, () => { k.territorial = 'unitary'; }, 'centralised the state', 0.5],
    [/religio|sharia|theocra/, () => { k.religionRole = 'established'; }, 'established a state religion', 0.5],
    [/secular/, () => { k.religionRole = 'secular'; }, 'made the state secular', 0.4],
    [/military.*(role|control)|civilian control/, () => { k.militaryRole = /civilian/.test(s) ? 'civilian_control' : 'political'; }, 'redefined the military role', 0.5],
  ];
  const ch = changes.find(([re]) => re.test(s));
  if (!ch) return reject(c, d, 'The drafting office could not identify the amendment. Name it (e.g. "expand emergency powers", "weaken courts", "federalise").');
  const support = c.legislatureSupport, appr = c.blocs.reduce((a, b) => a + b.realApproval * b.share, 0);
  const passes = k.amendment === 'decree' ? true : k.amendment === 'legislature' ? x.rng.chance(support) : k.amendment === 'supermajority' ? support > 0.66 || x.rng.chance(support - 0.4) : x.rng.chance(appr / 100);
  if (!passes) { reject(c, d, `The amendment (${ch[2]}) failed under the ${k.amendment} procedure.`); log(x, 'amendment_failed', [c.iso3], `Constitutional amendment in ${c.name} fails: ${ch[2]}.`); return; }
  ch[1](); k.version++; k.history.push({ version: k.version, turn: x.w.turn, change: ch[2], reason: d.order?.slice(0, 200) ?? 'government amendment' });
  c.legitimacy = clamp(c.legitimacy - ch[3] * 20 * (isDemocracy(c.govType) ? 1.5 : 0.5));
  for (const b of c.blocs) if (b.kind === 'business' || b.kind === 'youth') b.realApproval -= ch[3] * 8;
  log(x, 'constitutional_change', [c.iso3], `${c.name} amends its constitution (${k.amendment}): ${ch[2]}.`, ch[3] >= 0.6);
}

function unResolution(x: Ctx, c: Country, d: Directive, sub: string) {
  const w = x.w; const tt = d.target ? w.countries[d.target] : null;
  if (/veto|vote/.test(sub)) return; // votes/vetoes are cast automatically by stance when a resolution is tabled
  if (!tt) return reject(c, d, 'A resolution needs a target state.');
  const force = /force|military|intervention/.test((d.order ?? '').toLowerCase());
  const P5 = x.s.relations.p5 as string[];
  const vetoer = P5.find(p => w.countries[p]?.alive && p !== c.iso3 && (p === tt.iso3 || (w.attitudes[p][tt.iso3] ?? 0) > 15 || (w.attitudes[p][c.iso3] ?? 0) < -40));
  const voters = alive(w).filter(i => i !== tt.iso3);
  const yes = voters.filter(i => (w.attitudes[i][tt.iso3] ?? 0) < -15 || (w.attitudes[i][c.iso3] ?? 0) > 40).length;
  const name = `UN Security Council resolution on ${tt.name}${force ? ' authorising force' : ' imposing sanctions'}`;
  if (vetoer) { log(x, 'un_veto', [c.iso3, tt.iso3, vetoer], `${name} vetoed by ${w.countries[vetoer].name}.`, true); shift(w, vetoer, c.iso3, -5); return; }
  if (yes < voters.length * 0.5) { log(x, 'un_resolution_failed', [c.iso3, tt.iso3], `${name} fails to win enough support.`); return; }
  log(x, 'un_resolution', [c.iso3, tt.iso3], `${name} adopted.`, true);
  for (const i of voters) if ((w.attitudes[i][tt.iso3] ?? 0) < 20) addSanction(x, i, tt.iso3, force ? 0.6 : 0.4, true);
  worldReact(x, tt.iso3, -5);
}
