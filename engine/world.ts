// Builds the starting World from the baked files in data/.
import fs from 'node:fs';
import path from 'node:path';
import type { Country, Faction, GovType, RegionStatic, World } from './types.ts';
import { classify, isDemocracy, makeBlocs } from './regime.ts';
import { Rng, clamp } from './util.ts';

export interface Statics {
  regions: RegionStatic[];
  countryData: Record<string, any>;
  relations: any;
  baseTrade: Record<string, Record<string, number>>;
  byCountry: Record<string, number[]>; // regions owned at start
}

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
let cached: Statics | null = null;
export function loadStatics(): Statics {
  if (cached) return cached;
  const regions: RegionStatic[] = read('regions.json');
  const countryData = Object.fromEntries((read('countries.json') as any[]).map(c => [c.iso3, c]));
  const byCountry: Record<string, number[]> = {};
  for (const r of regions) (byCountry[r.country] ??= []).push(r.id);
  return (cached = { regions, countryData, relations: read('relations.json'), baseTrade: read('trade.json'), byCountry });
}

export const DEV_COUNTRIES = ['USA', 'CHN', 'RUS', 'IND', 'GBR', 'FRA', 'DEU', 'JPN', 'BRA', 'IRN', 'ISR', 'SAU', 'TUR', 'UKR', 'PAK', 'KOR', 'PRK', 'TWN', 'EGY', 'NGA'];

/** Military strength in comparable units (roughly "billions of USD of effective force"). */
export function strength(c: Country) {
  return (Math.pow(c.milStock / 1e9, 0.8) * c.tech + c.personnel / 2e4) * c.readiness * (1 + c.mobilized);
}

export function structuralAttitude(w: World, s: Statics, a: string, b: string): number {
  const R = s.relations;
  let v = 0;
  for (const bl of Object.entries(w.blocs)) {
    const [name, x] = bl;
    if (x.members.includes(a) && x.members.includes(b)) v += name === 'NATO' ? 25 : name === 'EU' ? 20 : x.type === 'mutual_defence' ? 20 : 6;
  }
  for (const t of w.treaties) if (t.kind === 'alliance' && ((t.a === a && t.b === b) || (t.a === b && t.b === a))) v += 30;
  for (const [x, y, k] of R.rivalries) if ((x === a && y === b) || (x === b && y === a)) v -= k;
  for (const [x, y, k] of R.friendships) if ((x === a && y === b) || (x === b && y === a)) v += k;
  if ((R.colonial[a] ?? []).includes(b) || (R.colonial[b] ?? []).includes(a)) v += 4;
  const ca = w.countries[a], cb = w.countries[b];
  if (ca && cb) {
    const da = isDemocracy(ca.govType), db = isDemocracy(cb.govType);
    v += da && db ? 10 : da !== db ? -8 : 4;   // regime similarity (proxy for UN voting alignment)
  }
  return clamp(v, -100, 100);
}

export function initWorld(opts: { seed: number; startDate?: string }): World {
  const s = loadStatics();
  const rng = new Rng(opts.seed);
  const incentives = read('incentives.json'), constitutions = read('constitutions.json');
  const now = new Date();
  const startDate = opts.startDate ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const R = s.relations;
  const w: World = {
    turn: 0, startDate, seed: opts.seed, countries: {}, order: [], regions: [], factions: {}, wars: [], sanctions: [], treaties: [],
    blocs: structuredClone(R.blocs), attitudes: {}, trade: structuredClone(s.baseTrade), cables: [], pendingProposals: [],
    global: { oilPrice: 1, scarcity: 0, pandemic: 0, foodPrice: 1 }, recognitions: {}, commitments: [], nextFactionId: 1, nextLeaderId: 1,
  };
  w.regions = s.regions.map(r => ({ owner: r.country, controller: r.country, pop: r.pop, gdp: 0, unrest: 0, damage: 0, occupiedSince: null, autonomy: r.autonomy }));

  for (const iso of Object.keys(s.countryData)) {
    const d = s.countryData[iso];
    const gov: GovType = d.govType ?? classify(d.system, d.polyarchy);
    const minorityPop = (s.byCountry[iso] ?? []).filter(i => s.regions[i].group).reduce((a, i) => a + s.regions[i].pop, 0);
    const minorityName = (s.byCountry[iso] ?? []).map(i => s.regions[i].group).find(Boolean) ?? '';
    const dem = isDemocracy(gov);
    const startApproval = dem ? 44 : 50;
    const welfareBase = { high: 12, upper: 6, lower: 3, low: 1.5 }[d.incomeGroup as string] ?? 3;
    const spending = {
      health: Math.max(0.5, d.healthExpPctGdp * 0.6), education: Math.max(0.5, d.eduExpPctGdp), welfare: welfareBase,
      infrastructure: 3, military: Math.max(0, d.milPctGdp), security: 1.5, research: d.incomeGroup === 'high' ? 0.8 : 0.2,
    };
    const interestRate = 0.03 + 0.04 * d.debtPctGdp / 100;
    const spendTotal = Object.values(spending).reduce((a, b) => a + b, 0) + interestRate * d.debtPctGdp;
    // ponytail: revenue is set so the starting deficit is ~2.5% of GDP (real budget data not in the open sources we fetch).
    const taxRate = clamp(spendTotal - 2.5, 5, 60);
    const c: Country = {
      iso3: iso, name: d.name, alive: true, govType: gov, puppetOf: null,
      constitution: structuredClone(constitutions[iso]), incentives: structuredClone(incentives[iso]),
      leader: { id: w.nextLeaderId++, title: `Head of Government of ${d.name}`, since: 0, origin: 'incumbent', memory: '' },
      leaderHistory: [], govHistory: [{ turn: 0, govType: gov, reason: 'starting government' }], provisionalUntil: null,
      capital: s.regions.find(r => r.country === iso && r.capital)!.id, core: s.byCountry[iso] ?? [],
      pop: d.pop, gdp: d.gdp, potentialGrowth: clamp(0.5 * d.growth + 0.5 * ({ high: 1.8, upper: 3.2, lower: 4.2, low: 4.5 }[d.incomeGroup as string] ?? 3), -2, 7),
      growth: d.growth, inflation: d.inflation, unemployment: d.unemployment, debt: d.gdp * d.debtPctGdp / 100,
      taxRate, interestRate, budgetBalance: taxRate - spendTotal, spending, incomeGroup: d.incomeGroup, austerityUntil: null,
      resourceExposure: clamp(-(d.energyImports) / 100 * 0.08 + (d.oilRents + d.gasRents) / 100, -0.1, 0.6),
      milStock: d.gdp * d.milPctGdp / 100 * 8, personnel: Math.max(d.milPersonnel, d.pop * 0.001),
      tech: clamp(0.4 + 1.4 * (Math.log10(Math.max(d.gdpPc, 500)) - 3) / 1.9, 0.4, 2) + (d.nuclear ? 0.2 : 0),
      readiness: 0.7, mobilized: 0, nuclear: d.nuclear,
      blocs: makeBlocs(gov, { urban: d.urban, age014: d.age014, age65: d.age65, minorityShare: minorityPop / Math.max(1, d.pop), minorityName, religious: gov === 'theocracy' || ['muslim', 'muslim_shia'].includes(d.religion) && !dem }, startApproval),
      repression: clamp(0.9 - d.polyarchy, 0.05, 0.9), civilLiberties: clamp(d.polyarchy, 0.05, 0.95), curfew: false,
      legislatureSupport: dem ? rng.range(0.45, 0.65) : 0.85, nextElection: d.nextElectionMonths,
      info: { pressFreedom: d.pressFreedom, censorship: d.censorship, stateMedia: d.stateMedia, surveillance: d.surveillance, internetShutdown: false, propaganda: dem ? 0.1 : 0.6 },
      unrest: 0, stage: 0, suppressed: dem ? 2 : 15 * (1 - d.polyarchy), stability: 60, legitimacy: dem ? 60 : 50,
      corruption: d.corruption, crime: d.crime, terror: d.terror, literacy: d.literacy, urban: d.urban, lifeExp: d.lifeExp,
      refugeesHosted: d.refugeesHosted, refugeesOut: d.refugeesOrigin, refugeePolicy: 'restricted',
      orgs: Object.entries(R.blocs).filter(([, b]: [string, any]) => b.members.includes(iso)).map(([k]) => k),
      tariffs: {}, aidOut: {}, rejections: [], policyNotes: [],
      scores: { welfare: 50, approval: 50, survival: 50, power: 0, weighted: 0 }, coupRisk: 0, policyRate: 0, protestMonths: 0, unrestRise: 0, escalation: 0, coopActs: 0, hostileActs: 0, lastDefectionTurn: null, standingOrders: [], lastReview: null,
      lastCoupTurn: d.lastCoupYear != null ? (d.lastCoupYear - Number(startDate.slice(0, 4))) * 12 + 6 - Number(startDate.slice(5, 7)) : null,
      lastCivilWarTurn: d.recentCivilWar ? -12 : null, baseTaxRate: taxRate, sanctionExposure: 0, shocks: [], rally: 0, purgedAt: null, pendingDraft: null,
      resourcePolicy: { nationalised: false, exportBan: false, production: 1 }, estimated: d.estimated,
    };
    w.countries[iso] = c; w.order.push(iso);
  }

  // conflicts & insurgencies lower starting approval and raise unrest
  for (const k of R.conflicts) for (const iso of (k.countries ?? k.sides?.flat() ?? []).filter((x: string) => !x.startsWith('rebel:'))) {
    const c = w.countries[iso]; if (!c) continue;
    for (const b of c.blocs) { b.unrest = Math.max(b.unrest, 60 * k.intensity); b.approval = b.realApproval = Math.min(b.approval, 45 - 10 * k.intensity); }
  }
  for (const c of Object.values(w.countries)) if (c.terror > 0.5) for (const b of c.blocs) b.unrest = Math.max(b.unrest, 30);

  for (const o of R.occupations) for (const id of o.regions) { w.regions[id].controller = o.controller; w.regions[id].occupiedSince = 0; }
  for (const reb of R.rebels) {
    const c = w.countries[reb.country]; if (!c) continue;
    const f: Faction = { id: 'F' + w.nextFactionId++, country: reb.country, name: reb.faction, ideology: reb.ideology, group: null, strength: 0, backers: reb.backers, regions: reb.regions, since: 0, holdMonths: 0, active: true };
    w.factions[f.id] = f;
    for (const id of reb.regions) w.regions[id].controller = 'rebel:' + f.id;
    f.strength = strength(c) * 0.7;
    const conflict = R.conflicts.find((k: any) => k.sides?.[1]?.[0] === 'rebel:' + reb.country);
    w.wars.push({ id: 'W' + (w.wars.length + 1), name: conflict?.name ?? `${c.name} civil war`, attackers: ['rebel:' + f.id], defenders: [reb.country], start: 0, goals: [], exhaustion: {}, casualties: {}, active: true, civil: true, intensity: conflict?.intensity ?? 0.5 });
  }
  for (const k of R.conflicts.filter((k: any) => k.type === 'interstate')) {
    const [d, a] = k.sides; // curated lists defender first
    w.wars.push({ id: 'W' + (w.wars.length + 1), name: k.name, attackers: a, defenders: d, start: 0, goals: k.front, exhaustion: {}, casualties: {}, active: true, civil: false, intensity: k.intensity });
    for (const x of [...a, ...d]) { w.countries[x].mobilized = 0.4; }
  }
  for (const sc of R.sanctions) if (w.countries[sc.by] && w.countries[sc.target]) w.sanctions.push({ by: sc.by, target: sc.target, level: sc.level, since: 0, un: sc.un });
  for (const [a, b] of R.defenceTreaties) w.treaties.push({ a, b, kind: 'alliance', since: 0 });

  // region GDP: national GDP split over regions the government actually controls; occupied/rebel regions at half productivity
  for (const iso of w.order) {
    const ids = s.byCountry[iso] ?? [], c = w.countries[iso];
    const held = ids.filter(i => w.regions[i].controller === iso), share = held.reduce((a, i) => a + s.regions[i].gdpShare, 0) || 1;
    for (const i of ids) w.regions[i].gdp = c.gdp * s.regions[i].gdpShare / share * (w.regions[i].controller === iso ? 1 : 0.5);
  }
  for (const a of w.order) {
    w.attitudes[a] = {};
    for (const b of w.order) if (a !== b) w.attitudes[a][b] = Math.round(structuralAttitude(w, s, a, b) + rng.range(-5, 5));
  }
  for (const war of w.wars) for (const a of war.attackers) for (const d of war.defenders) if (w.attitudes[a] && w.attitudes[d]) { w.attitudes[a][d] = -90; w.attitudes[d][a] = -90; }
  for (const sc of w.sanctions) w.attitudes[sc.target][sc.by] = Math.min(w.attitudes[sc.target][sc.by], -30);
  return w;
}
