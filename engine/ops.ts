// State mutations shared by directives and monthly resolution: wars, territory, sanctions, regime change, new states.
import type { Country, Faction, GovType, SimEvent, War, World } from './types.ts';
import type { Statics } from './world.ts';
import { strength, structuralAttitude } from './world.ts';
import { ATT, PROVISIONAL_MONTHS, WAR } from './constants.ts';
import { POLYARCHY_OF, blocInfluence, chooseNewGovType, computeIncentives, constitutionTemplate, isDemocracy, makeBlocs } from './regime.ts';
import { Rng, clamp } from './util.ts';

export interface Ctx { w: World; s: Statics; rng: Rng; ev: SimEvent[] }

export function log(x: Ctx, type: string, countries: string[], text: string, major = false, data?: Record<string, unknown>) {
  x.ev.push({ turn: x.w.turn, type, countries, text, ...(major ? { major } : {}), ...(data ? { data } : {}) });
}
export const alive = (w: World) => w.order.filter(i => w.countries[i]?.alive);
export const nameOf = (w: World, ctrl: string) => ctrl.startsWith('rebel:') ? (w.factions[ctrl.slice(6)]?.name ?? 'rebels') : w.countries[ctrl]?.name ?? ctrl;

/** b's attitude toward a changes by d. */
export function shift(w: World, a: string, b: string, d: number) {
  if (a === b || !w.attitudes[b] || w.attitudes[b][a] === undefined) return;
  w.attitudes[b][a] = clamp(w.attitudes[b][a] + d, -100, 100);
}
/** Everyone reacts to actor's deed; members of a bloc/treaty with the victim react more. */
export function worldReact(x: Ctx, actor: string, d: number, victim?: string, blocExtra = 0) {
  for (const o of alive(x.w)) {
    if (o === actor) continue;
    const kin = victim && (o === victim || sharesBloc(x.w, o, victim)) ? blocExtra : 0;
    shift(x.w, actor, o, d + kin);
  }
}
export function sharesBloc(w: World, a: string, b: string) {
  return Object.values(w.blocs).some(bl => bl.members.includes(a) && bl.members.includes(b)) || allied(w, a, b);
}
export const allied = (w: World, a: string, b: string) => w.treaties.some(t => t.kind === 'alliance' && ((t.a === a && t.b === b) || (t.a === b && t.b === a)));

export function regionsOf(w: World, iso: string, by: 'owner' | 'controller' = 'controller') {
  const out: number[] = []; w.regions.forEach((r, i) => { if (r[by] === iso) out.push(i); }); return out;
}

export function warsOf(w: World, iso: string) { return w.wars.filter(v => v.active && (v.attackers.includes(iso) || v.defenders.includes(iso))); }
export function enemies(w: World, iso: string) {
  const out = new Set<string>();
  for (const v of warsOf(w, iso)) for (const e of v.attackers.includes(iso) ? v.defenders : v.attackers) out.add(e);
  return [...out];
}
export function atWar(w: World, a: string, b: string) { return enemies(w, a).includes(b); }

export function addSanction(x: Ctx, by: string, target: string, level: number, un = false) {
  const ex = x.w.sanctions.find(s => s.by === by && s.target === target);
  if (ex) ex.level = Math.max(ex.level, level); else x.w.sanctions.push({ by, target, level: clamp(level, 0.05, 1), since: x.w.turn, un });
  shift(x.w, by, target, ATT.sanction * level);
}

const MUTUAL = ['NATO', 'CSTO', 'AES'];
export function declareWar(x: Ctx, a: string, d: string, goals: number[], reason = ''): War {
  const w = x.w;
  const war: War = { id: 'W' + (w.wars.length + 1), name: `${w.countries[a].name}–${w.countries[d].name} war`, attackers: [a], defenders: [d], start: w.turn, goals, exhaustion: {}, casualties: {}, active: true, civil: false, intensity: 1 };
  w.wars.push(war);
  w.attitudes[d][a] = -100; shift(w, d, a, -40);
  worldReact(x, a, ATT.war / 4, d, ATT.war / 2);
  w.countries[a].rally = 8; w.countries[d].rally = 15;
  log(x, 'war_declared', [a, d], `${w.countries[a].name} declares war on ${w.countries[d].name}${reason ? ': ' + reason : ''}.`, true, { war: war.id });
  // allies join: treaty obligations first, then friends of the victim who dislike the aggressor
  for (const o of alive(w)) {
    if (o === a || o === d || war.attackers.includes(o) || war.defenders.includes(o)) continue;
    const bloc = MUTUAL.find(b => w.blocs[b]?.members.includes(o) && w.blocs[b].members.includes(d) && !w.blocs[b].members.includes(a));
    const treaty = allied(w, o, d) && !allied(w, o, a);
    const p = bloc === 'NATO' ? WAR.allyJoinNato : bloc || treaty ? WAR.allyJoinTreaty : (w.attitudes[o][d] > 70 && w.attitudes[o][a] < -40 ? 0.08 : 0);
    if (p && x.rng.chance(p)) {
      war.defenders.push(o); w.attitudes[a][o] = -80; shift(w, a, o, -50);
      log(x, 'ally_joins_war', [o, d, a], `${w.countries[o].name} enters the war on the side of ${w.countries[d].name}${bloc ? ` (${bloc} obligation)` : treaty ? ' (defence treaty)' : ''}.`, true);
    }
  }
  return war;
}

export function endWar(x: Ctx, war: War, how: string) {
  war.active = false; war.end = x.w.turn;
  const names = (xs: string[]) => xs.map(i => nameOf(x.w, i)).join(', ');
  log(x, 'war_ended', [...war.attackers, ...war.defenders].filter(i => !i.startsWith('rebel:')), `${war.name} ends (${how}). ${names(war.attackers)} vs ${names(war.defenders)}.`, true, { war: war.id });
}

/** Change who controls a region. Returns true if a capital fell. */
export function setController(x: Ctx, id: number, ctrl: string): boolean {
  const r = x.w.regions[id], prev = r.controller;
  if (prev === ctrl) return false;
  r.controller = ctrl;
  r.occupiedSince = ctrl === r.owner ? null : x.w.turn;
  for (const f of Object.values(x.w.factions)) f.regions = f.regions.filter(i => i !== id);
  if (ctrl.startsWith('rebel:')) x.w.factions[ctrl.slice(6)]?.regions.push(id);
  const cap = Object.values(x.w.countries).find(c => c.alive && c.capital === id && c.iso3 === prev);
  return !!cap;
}

/** Owner changes (annexation, cession, independence). Moves the region's people into the new owner's blocs. */
export function transferRegion(x: Ctx, id: number, to: string, how: string) {
  const w = x.w, r = w.regions[id], from = r.owner;
  if (from === to) return;
  r.owner = to; r.controller = to; r.occupiedSince = null;
  const nc = w.countries[to], oc = w.countries[from];
  if (nc && how !== 'independence') {
    let b = nc.blocs.find(b => b.kind === 'minority');
    const share = r.pop / Math.max(1, nc.pop + r.pop);
    if (!b) { b = { kind: 'minority', name: 'Annexed populations', share: 0, approval: 15, realApproval: 15, unrest: 40, influence: 0.02, grievances: ['annexation'] }; nc.blocs.push(b); }
    b.share = Math.min(0.6, b.share + share); b.realApproval = Math.min(b.realApproval, 20); b.approval = Math.min(b.approval, 25);
    const tot = nc.blocs.reduce((s, x) => s + x.share, 0); for (const q of nc.blocs) q.share /= tot;
    if (!b.grievances.includes(how)) b.grievances.push(how);
  }
  if (oc && oc.capital === id) relocateCapital(x, oc);
  if (oc && !regionsOf(w, from, 'owner').length) { oc.alive = false; log(x, 'country_extinguished', [from, to], `${oc.name} has ceased to exist as a state; its last territory passed to ${nc?.name}.`, true); }
}

export function relocateCapital(x: Ctx, c: Country) {
  const held = regionsOf(x.w, c.iso3).filter(i => x.w.regions[i].owner === c.iso3);
  if (!held.length) return false;
  const best = held.reduce((a, b) => x.w.regions[b].pop > x.w.regions[a].pop ? b : a);
  c.capital = best;
  log(x, 'capital_relocated', [c.iso3], `The government of ${c.name} relocates to ${x.s.regions[best].name}.`);
  return true;
}

export function annex(x: Ctx, id: number, to: string) {
  const victim = x.w.regions[id].owner;
  transferRegion(x, id, to, 'annexation');
  worldReact(x, to, ATT.annexWorld, victim, ATT.annexBlocExtra);
  log(x, 'annexation', [to, victim], `${x.w.countries[to].name} formally annexes ${x.s.regions[id].name} from ${x.w.countries[victim]?.name ?? victim}. Borders redrawn.`, true, { region: id });
  // democracies allied with the victim respond with sanctions half the time
  for (const o of alive(x.w)) if (o !== to && sharesBloc(x.w, o, victim) && isDemocracy(x.w.countries[o].govType) && x.rng.chance(0.5)) addSanction(x, o, to, 0.3);
}

/**
 * Regime change pipeline (see SPEC "Regime change & new constitutions"):
 * winning coalition -> new government type -> constitution (template now; LLM draft later in the sim layer)
 * -> provisional period -> recompute incentives/blocs/institutions/info/orgs -> fresh leader.
 */
export function regimeChange(x: Ctx, iso: string, o: { winner: string; violent: boolean; backers?: string[]; occupier?: string; how: string }) {
  const w = x.w, c = w.countries[iso], rng = x.rng;
  const prev = c.govType;
  const gdpPc = c.gdp / Math.max(1, c.pop);
  const backerGov = o.backers?.length ? w.countries[o.backers[0]]?.govType : undefined;
  const gov: GovType = o.occupier ? w.countries[o.occupier].govType : chooseNewGovType(rng, { winner: o.winner, violent: o.violent, literacy: c.literacy, gdpPc, prev, backerGov });
  const poly = POLYARCHY_OF[gov];
  c.govType = gov; c.puppetOf = o.occupier ?? null;
  c.govHistory.push({ turn: w.turn, govType: gov, reason: o.how });
  const facts = { system: '', polyarchy: poly, corruption: c.corruption, federal: c.constitution.territorial === 'federal', bicameral: c.constitution.legislature.type === 'bicameral', religion: x.s.countryData[iso]?.religion ?? 'christian', hasMinorities: c.blocs.some(b => b.kind === 'minority'), age65: 10, urban: c.urban, electionYears: 4 };
  const old = c.constitution;
  const k = constitutionTemplate(gov, facts, 'template (provisional, pending drafting commission)');
  k.version = old.version + 1; k.status = 'provisional';
  k.history = [...old.history, { version: k.version, turn: w.turn, change: `New constitutional order: ${gov.replace(/_/g, ' ')}`, reason: o.how }];
  k.preamble = `Provisional constitution of ${c.name}, adopted after ${o.how}.`;
  c.constitution = k;
  c.pendingDraft = { winner: o.winner, violent: o.violent, backers: o.backers ?? (o.occupier ? [o.occupier] : []), how: o.how };
  c.provisionalUntil = w.turn + rng.int(...PROVISIONAL_MONTHS);
  c.incentives = computeIncentives(gov, poly, c.corruption);
  // winners and losers
  const winBloc: Record<string, string[]> = { military: ['military'], revolutionary: ['workers', 'rural', 'youth'], democratic: ['youth', 'workers', 'business'], religious: ['religious', 'rural'], ethnic: ['minority'], separatist: ['minority'], foreign: ['business'] };
  const winners = winBloc[o.winner] ?? [];
  for (const b of c.blocs) {
    b.influence = blocInfluence(gov, b.kind, b.share);
    const d = winners.includes(b.kind) ? 25 : b.kind === 'business' || b.kind === 'military' ? -15 : -5;
    b.realApproval = clamp(b.realApproval + d); b.approval = clamp(b.approval + d); b.unrest *= 0.6;
  }
  c.legislatureSupport = isDemocracy(gov) ? 0.5 : 0.9;
  c.nextElection = isDemocracy(gov) || gov === 'hybrid_regime' ? w.turn + rng.int(6, 18) : null;
  const dem = isDemocracy(gov);
  c.info.pressFreedom = clamp(dem ? Math.max(c.info.pressFreedom, 0.55) : Math.min(c.info.pressFreedom, 0.25), 0, 1);
  c.info.stateMedia = clamp(1 - poly, 0, 1); c.info.censorship = clamp(dem ? 0.2 : 0.7, 0, 1); c.info.propaganda = dem ? 0.1 : 0.7;
  c.repression = dem ? 0.2 : 0.6; c.civilLiberties = poly; c.legitimacy = 35; c.stability = Math.min(c.stability, 40); c.suppressed *= 0.3;
  c.purgedAt = w.turn;
  // organisations: AU suspends after unconstitutional change; EU/NATO suspend non-democracies
  for (const [name, bl] of Object.entries(w.blocs)) if (bl.members.includes(iso)) {
    if ((name === 'AU' && ['military', 'revolutionary'].includes(o.winner)) || (['EU', 'NATO'].includes(name) && !dem)) {
      if (!bl.suspended.includes(iso)) { bl.suspended.push(iso); log(x, 'org_suspension', [iso], `${name} suspends ${c.name} after ${o.how}.`); }
    }
  }
  // fresh leader with reset memory
  const old_leader = c.leader;
  c.leaderHistory.push({ id: old_leader.id, from: old_leader.since, to: w.turn, origin: old_leader.origin });
  c.leader = { id: w.nextLeaderId++, title: `Head of Government of ${c.name}`, since: w.turn, origin: o.how, memory: '' };
  for (const other of alive(w)) if (other !== iso) w.attitudes[other][iso] = Math.round((w.attitudes[other][iso] + structuralAttitude(w, x.s, other, iso)) / 2);
  log(x, 'regime_change', [iso, ...(o.backers ?? []), ...(o.occupier ? [o.occupier] : [])], `REGIME CHANGE in ${c.name}: ${o.how}. New government: ${gov.replace(/_/g, ' ')}${o.occupier ? ` installed by ${w.countries[o.occupier].name}` : ''}. A provisional constitution is in force.`, true, { from: prev, to: gov });
}

/** Separatist victory: carve a new state out of `regions`. */
export function createCountry(x: Ctx, parent: string, regions: number[], f: Faction): string {
  const w = x.w, p = w.countries[parent];
  const biggest = regions.reduce((a, b) => w.regions[b].pop > w.regions[a].pop ? b : a);
  const baseName = x.s.regions[biggest].name;
  let iso = ('X' + baseName.normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2)).padEnd(3, 'X');
  for (let n = 0; w.countries[iso]; n++) iso = 'X' + String.fromCharCode(65 + (n % 26)) + String.fromCharCode(65 + Math.floor(n / 26) % 26);
  const pop = regions.reduce((a, i) => a + w.regions[i].pop, 0), gdp = regions.reduce((a, i) => a + w.regions[i].gdp, 0);
  const name = f.group ? `Republic of ${baseName}` : `${baseName} Republic`;
  const c: Country = structuredClone(p);
  Object.assign(c, {
    iso3: iso, name, alive: true, puppetOf: null, capital: biggest, core: [...regions], pop, gdp, debt: gdp * 0.2, personnel: Math.round(pop * 0.004),
    milStock: f.strength * 2e9, mobilized: 0.3, lastCoupTurn: null, lastCivilWarTurn: x.w.turn, lastDefectionTurn: null, protestMonths: 0, unrestRise: 0, escalation: 0, coopActs: 0, hostileActs: 0, standingOrders: [], lastReview: null, baseTaxRate: p.taxRate, sanctionExposure: 0, nuclear: false, orgs: [], tariffs: {}, aidOut: {}, rejections: [], policyNotes: [],
    refugeesHosted: 0, refugeesOut: 0, leaderHistory: [], govHistory: [], provisionalUntil: null, coupRisk: 0, shocks: [], rally: 20,
    estimated: ['derived from parent country at independence'],
  });
  c.blocs = makeBlocs(c.govType, { urban: p.urban, age014: 25, age65: 8, minorityShare: 0.05, minorityName: `${p.name} loyalists`, religious: false }, 65);
  w.countries[iso] = c; w.order.push(iso);
  w.attitudes[iso] = {};
  for (const o of w.order) if (o !== iso) {
    w.attitudes[iso][o] = Math.round((w.attitudes[parent]?.[o] ?? 0) * -0.3); w.attitudes[o][iso] = Math.round((w.attitudes[o][parent] ?? 0) * -0.5);
  }
  w.attitudes[iso][parent] = -70; w.attitudes[parent][iso] = -90;
  for (const b of f.backers) if (w.attitudes[iso][b] !== undefined) { w.attitudes[iso][b] = 70; w.attitudes[b][iso] = 60; }
  w.trade[iso] = {};
  for (const i of regions) transferRegion(x, i, iso, 'independence');
  p.blocs = p.blocs.filter(b => b.kind !== 'minority' || b.name !== f.group);
  w.recognitions[iso] = [...f.backers];
  f.active = false;
  log(x, 'independence', [iso, parent], `${name} declares independence from ${p.name} after separatist victory. A new state appears on the map.`, true, { regions });
  regimeChange(x, iso, { winner: 'separatist', violent: true, backers: f.backers, how: `independence from ${p.name}` });
  c.leaderHistory = [];
  return iso;
}

export function spawnFaction(x: Ctx, iso: string, ideology: Faction['ideology'], group: string | null, name: string, seed: number): Faction {
  const f: Faction = { id: 'F' + x.w.nextFactionId++, country: iso, name, ideology, group, strength: strength(x.w.countries[iso]) * seed, backers: [], regions: [], since: x.w.turn, holdMonths: 0, active: true };
  x.w.factions[f.id] = f;
  return f;
}
