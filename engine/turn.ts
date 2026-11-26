// Monthly resolution. Order: directives -> economy/trade -> military & wars -> occupation -> blocs & unrest ->
// insurgency/coups/revolutions -> institutions -> international -> non-state & refugees -> world events -> attitudes -> scores.
// All formulas are deliberately simple; constants live in constants.ts.
import type { AgentResponse, Country, SimEvent, War, World } from './types.ts';
import { type Statics, strength, structuralAttitude } from './world.ts';
import { ATT, BLOCS, COUP_BASE, DEFECTION_BASE, ECON, EVENTS, INDEPENDENCE_HOLD_MONTHS, INFO, INSURGENCY_SPAWN, LADDER_THRESH, RATIFY_STABILITY, REGIME_CAN_FALL, RIOT_DAMAGE, SEPARATIST_SPAWN, STRIKE_GDP_HIT, WAR } from './constants.ts';
import { type Ctx, alive, createCountry, endWar, log, nameOf, regimeChange, regionsOf, relocateCapital, setController, shift, spawnFaction } from './ops.ts';
import { applyDecisions, borrowLimit, debtRatio, totalSpending } from './directives.ts';
import { isDemocracy } from './regime.ts';
import { Rng, clamp, km, sigmoid } from './util.ts';

export function runTurn(w: World, s: Statics, decisions: Record<string, AgentResponse>): SimEvent[] {
  const x: Ctx = { w, s, rng: new Rng(w.seed * 7919 + w.turn * 104729 + 17), ev: [] };
  for (const c of Object.values(w.countries)) { c.rejections = []; c.policyNotes = []; }
  w.cables = [];
  w.pendingProposals = w.pendingProposals.filter(p => p.turn >= w.turn - 2);
  applyDecisions(x, decisions);
  economy(x);
  wars(x);
  occupation(x);
  for (const iso of alive(w)) blocsAndUnrest(x, w.countries[iso]);
  factions(x);
  for (const iso of alive(w)) coupsAndInstitutions(x, w.countries[iso]);
  international(x);
  nonStateAndRefugees(x);
  worldEvents(x);
  attitudes(x);
  scores(x);
  w.turn++;
  return x.ev;
}

const tradeOf = (w: World, iso: string) => Object.values(w.trade[iso] ?? {}).reduce((a, b) => a + b, 0);
const warOnSoil = (w: World, iso: string) => {
  const own = regionsOf(w, iso, 'owner'); if (!own.length) return 0;
  return own.filter(i => w.regions[i].controller !== iso || w.regions[i].damage > 0.2).length / own.length;
};

function economy(x: Ctx) {
  const { w, s, rng } = x;
  // world oil price: mean-reverting random walk with occasional shocks
  w.global.oilPrice = clamp(w.global.oilPrice * Math.exp(ECON.oilPriceVol * rng.normal()) + (1 - w.global.oilPrice) * 0.05, 0.4, 3);
  w.global.foodPrice = clamp(w.global.foodPrice + (1 + w.global.scarcity - w.global.foodPrice) * 0.05 + 0.02 * rng.normal(), 0.6, 2.5);
  w.global.scarcity += EVENTS.climateStressPerYear / 12;
  w.global.pandemic = Math.max(0, w.global.pandemic - 1);
  // trade matrix: base flows scaled by GDP change and frictions
  for (const a of alive(w)) {
    const ca = w.countries[a], base = s.baseTrade[a] ?? {};
    const row: Record<string, number> = {};
    for (const [b, v0] of Object.entries(base)) {
      const cb = w.countries[b]; if (!cb?.alive) continue;
      let f = Math.sqrt((ca.gdp / s.countryData[a].gdp) * (cb.gdp / (s.countryData[b]?.gdp ?? cb.gdp)));
      const sanc = w.sanctions.filter(q => (q.by === a && q.target === b) || (q.by === b && q.target === a)).reduce((m, q) => Math.max(m, q.level), 0);
      f *= 1 - 0.85 * sanc;
      f *= 1 - clamp(((cb.tariffs[a] ?? 0) + (ca.tariffs[b] ?? 0)) / 200, 0, 0.95);
      if (w.wars.some(v => v.active && ((v.attackers.includes(a) && v.defenders.includes(b)) || (v.attackers.includes(b) && v.defenders.includes(a))))) f *= 0.02;
      if (w.treaties.some(t => t.kind === 'trade' && [t.a, t.b].includes(a) && [t.a, t.b].includes(b))) f *= 1.15;
      row[b] = Math.round(v0 * f);
    }
    w.trade[a] = row;
  }
  for (const iso of alive(w)) {
    const c = w.countries[iso], d = s.countryData[iso] ?? {};
    const exportsNow = tradeOf(w, iso), exportsBase = Object.values(s.baseTrade[iso] ?? {}).reduce((a, b) => a + b, 0) || 1;
    const tradeChange = exportsNow / exportsBase - Math.sqrt(c.gdp / (d.gdp ?? c.gdp));   // friction-driven change only
    const openness = (d.tradePctGdp ?? 50) / 100;
    const sanctionExposure = w.sanctions.filter(q => q.target === iso).reduce((a, q) => a + q.level * ((s.baseTrade[q.by]?.[iso] ?? 0) + (s.baseTrade[iso]?.[q.by] ?? 0)) / (2 * exportsBase) + (q.un ? 0.02 * q.level : 0), 0);
    c.sanctionExposure = clamp(sanctionExposure, 0, 1);
    const extraInvest = c.spending.infrastructure - 3 + c.spending.research - (c.incomeGroup === 'high' ? 0.8 : 0.2);
    const shock = c.shocks.reduce((a, q) => a + q.growth, 0);
    c.shocks = c.shocks.map(q => ({ ...q, months: q.months - 1 })).filter(q => q.months > 0);
    const strikes = c.stage >= 3 ? STRIKE_GDP_HIT * (c.curfew ? 1.3 : 1) : 0;
    const refugeeStrain = Math.min(2, c.refugeesHosted / Math.max(1, c.pop) * 40);
    const target = c.potentialGrowth
      + ECON.investBoost * clamp(extraInvest, -3, 6)
      - ECON.taxDrag * (c.taxRate - c.baseTaxRate)
      - ECON.unrestDrag * c.unrest / 100 - strikes
      - ECON.sanctionDrag * clamp(sanctionExposure, 0, 1)
      - ECON.warDrag * warOnSoil(w, iso)
      - ECON.mobilizationDrag * c.mobilized
      + c.resourceExposure * (w.global.oilPrice - 1) * 8 * c.resourcePolicy.production
      - 0.3 * c.policyRate + 4 * clamp(tradeChange, -0.5, 0.5) * openness
      - c.crime * 0.5 - refugeeStrain - (w.global.pandemic ? 3 : 0) + shock;
    c.growth = clamp(c.growth + (target - c.growth) * 0.25 + 0.15 * rng.normal(), -30, 25);
    // inflation & jobs
    const deficit = -c.budgetBalance;
    const infTarget = ECON.inflationTarget + (debtRatio(c) > borrowLimit(c) * 0.8 ? ECON.deficitInflation * Math.max(0, deficit - 3) * 4 : 0)
      + 6 * clamp(sanctionExposure, 0, 1) + 5 * warOnSoil(w, iso) + 4 * (w.global.foodPrice - 1) - 0.8 * c.resourceExposure * (w.global.oilPrice - 1) * -3 - 0.6 * c.policyRate;
    const pull = c.inflation > 30 ? 0.03 : ECON.inflationPull;
    c.inflation = clamp(c.inflation + (infTarget - c.inflation) * pull, -3, 500);
    const natural = s.countryData[iso]?.unemployment ?? 6;
    c.unemployment = clamp(c.unemployment + ECON.okun * (c.potentialGrowth - c.growth) / 12 + (natural - c.unemployment) * 0.02, 0.5, 45);
    // regions grow with their controller's growth; war damage destroys output
    const g = 1 + c.growth / 1200;
    for (const id of regionsOf(w, iso)) { const r = w.regions[id]; r.gdp *= g * (1 - r.damage * 0.02); r.pop *= 1 + (d.popGrowth ?? 1) / 1200; r.damage *= 0.97; }
    const held = regionsOf(w, iso);
    c.gdp = Math.max(1e6, held.reduce((a, i) => a + w.regions[i].gdp * (w.regions[i].owner === iso ? 1 : WAR.occupationShare), 0));
    c.pop = Math.max(1, held.reduce((a, i) => a + w.regions[i].pop, 0));
    // budget: revenue - spending - interest - war & occupation costs. Deficits add to debt (debt can never be negative).
    c.interestRate = ECON.interestBase + ECON.interestDebtPenalty * debtRatio(c) + Math.max(0, c.policyRate) * 0.005 + (sanctionExposure > 0.3 ? 0.03 : 0);
    const occupied = held.filter(i => w.regions[i].owner !== iso).reduce((a, i) => a + w.regions[i].pop, 0);
    const warCost = c.mobilized * 1.5 + (occupied / 1e6) * WAR.occupationCostPerMillion * 12 / c.gdp * 100;
    const aid = Object.values(c.aidOut).reduce((a, b) => a + b, 0) * 12 / c.gdp * 100;
    const spend = totalSpending(c) + c.interestRate * debtRatio(c) * 100 + warCost + aid;
    const revenue = c.taxRate * (1 - c.corruption * 0.15) * (c.stage >= 3 ? 0.95 : 1);
    c.budgetBalance = revenue - spend;
    c.debt = Math.max(0, c.debt - c.budgetBalance / 100 * c.gdp / 12);
    if (debtRatio(c) > borrowLimit(c) && c.budgetBalance < 0) {
      // can't borrow more: forced austerity (spending cut toward balance) — the Treasury acts, not the leader
      const cut = Math.min(1, -c.budgetBalance / totalSpending(c));
      for (const k of Object.keys(c.spending) as (keyof Country['spending'])[]) c.spending[k] *= 1 - cut * 0.3;
      c.rejections.push('Treasury: debt has reached the borrowing limit; spending was cut automatically to avoid default.');
      if (rng.chance(0.15)) log(x, 'debt_crisis', [iso], `${c.name} hits its borrowing limit; emergency spending cuts imposed.`);
    }
    // military capital stock
    c.milStock = Math.max(0, c.milStock * (1 - 0.008) + c.spending.military / 100 * c.gdp / 12);
    c.readiness = clamp(c.readiness + (0.7 + 0.2 * c.mobilized - c.readiness) * 0.1 - (occupied / Math.max(1, c.pop)) * 0.05, 0.2, 1);
    c.personnel = Math.max(100, c.personnel + ((s.countryData[iso]?.milPersonnel ?? c.personnel) * (1 + c.mobilized * 1.5) - c.personnel) * 0.05);
    if (c.info.internetShutdown && rng.chance(0.5)) c.info.internetShutdown = false; // shutdowns are costly and lapse
  }
}

function sideOf(war: War, ctrl: string): 'A' | 'D' | null {
  return war.attackers.includes(ctrl) ? 'A' : war.defenders.includes(ctrl) ? 'D' : null;
}
function sideStrength(w: World, members: string[], primary: string) {
  return members.reduce((a, m) => {
    if (m.startsWith('rebel:')) { const f = w.factions[m.slice(6)]; return a + (f?.active ? f.strength : 0); }
    const c = w.countries[m]; if (!c?.alive) return a;
    return a + strength(c) * (m === primary ? 1 : 0.35);   // allies commit a share of their force
  }, 0);
}
const capitalOf = (w: World, s: Statics, ctrl: string): [number, number] => {
  if (ctrl.startsWith('rebel:')) { const f = w.factions[ctrl.slice(6)]; const r = f?.regions[0] ?? w.countries[f?.country ?? '']?.capital ?? 0; return [s.regions[r].lon, s.regions[r].lat]; }
  const c = w.countries[ctrl]; return [s.regions[c.capital].lon, s.regions[c.capital].lat];
};

function wars(x: Ctx) {
  const { w, s, rng } = x;
  for (const war of w.wars.filter(v => v.active)) {
    war.attackers = war.attackers.filter(m => m.startsWith('rebel:') ? w.factions[m.slice(6)]?.active : w.countries[m]?.alive);
    war.defenders = war.defenders.filter(m => m.startsWith('rebel:') ? w.factions[m.slice(6)]?.active : w.countries[m]?.alive);
    if (!war.attackers.length || !war.defenders.length) { endWar(x, war, 'one side ceased to exist'); continue; }
    const SA = sideStrength(w, war.attackers, war.attackers[0]), SD = sideStrength(w, war.defenders, war.defenders[0]);
    // front: enemy-held regions adjacent to own-held regions
    const front = { A: [] as [number, number][], D: [] as [number, number][] };
    w.regions.forEach((r, i) => {
      const side = sideOf(war, r.controller); if (!side) return;
      for (const n of s.regions[i].nb) { const os = sideOf(war, w.regions[n].controller); if (os && os !== side) front[side].push([i, n]); }
    });
    if (!front.A.length && !front.D.length) {
      // no land contact: amphibious/air campaign against goals, low odds
      if (war.goals.length) front.A.push(...war.goals.filter(g => sideOf(war, w.regions[g].controller) === 'D').slice(0, 1).map(g => [g, g] as [number, number]));
    }
    const nA = new Set(front.A.map(p => p[1])).size || 1, nD = new Set(front.D.map(p => p[1])).size || 1;
    const tryCaptures = (side: 'A' | 'D', own: number, enemy: number, pairs: [number, number][], nTargets: number, nEnemyFront: number) => {
      const goals = new Set(war.goals);
      // goals first, then the regions nearest the enemy's seat of government (armies drive on capitals)
      const enemyPrimary = (side === 'A' ? war.defenders : war.attackers)[0];
      const ec = capitalOf(w, s, enemyPrimary);
      const dist = (i: number) => km([s.regions[i].lon, s.regions[i].lat], ec);
      const targets = [...new Set(pairs.map(p => p[1]))].map(t => [t, dist(t) * (0.8 + 0.4 * rng.next())] as [number, number])
        .sort((a, b) => (goals.has(b[0]) ? 1 : 0) - (goals.has(a[0]) ? 1 : 0) || a[1] - b[1]).map(p => p[0]);
      let caps = 0;
      for (const t of targets.slice(0, WAR.maxCapturesPerMonth * 3)) {
        if (caps >= WAR.maxCapturesPerMonth) break;
        const from = pairs.find(p => p[1] === t)![0];
        const tr = s.regions[t], defCtrl = w.regions[t].controller;
        const attCtrl = w.regions[from].controller;
        const supply = 1 / (1 + km(capitalOf(w, s, attCtrl), [tr.lon, tr.lat]) / WAR.supplyFalloffKm);
        const local = (own / Math.sqrt(nTargets)) * supply;
        const defC = !defCtrl.startsWith('rebel:') ? w.countries[defCtrl] : null;
        let defLocal = (enemy / Math.sqrt(nEnemyFront)) * (WAR.terrain[tr.terrain] ?? 1) * 1.2 * (defC?.capital === t ? 1.4 : 1);
        if (defC && w.regions[t].owner === defCtrl && w.regions[t].unrest > 60) defLocal *= 0.8;   // disloyal regions fall faster
        let p = sigmoid(WAR.captureSteep * (local / Math.max(1e-6, defLocal) - WAR.captureMid)) * war.intensity * 0.5;
        if (defC?.nuclear && defC.core.includes(t) && !war.civil) p *= WAR.nuclearDeterrence;
        if (rng.chance(p)) {
          const newCtrl = side === 'A' ? (war.attackers.includes(attCtrl) ? attCtrl : war.attackers[0]) : (war.defenders.includes(attCtrl) ? attCtrl : war.defenders[0]);
          // liberated land returns to its owner if the owner is on our side
          const owner = w.regions[t].owner;
          const ctrl = sideOf(war, owner) === side ? owner : newCtrl;
          const capFell = setController(x, t, ctrl);
          w.regions[t].damage = clamp(w.regions[t].damage + 0.15, 0, 1);
          caps++;
          log(x, 'region_captured', [ctrl, defCtrl].filter(c => !c.startsWith('rebel:')), `${nameOf(w, ctrl)} takes ${tr.name} from ${nameOf(w, defCtrl)}.`, false, { region: t, war: war.id });
          if (capFell) log(x, 'capital_fallen', [defCtrl, ctrl].filter(c => !c.startsWith('rebel:')), `The capital of ${nameOf(w, defCtrl)}, ${tr.name}, falls to ${nameOf(w, ctrl)}.`, true, { region: t });
        }
      }
    };
    tryCaptures('A', SA, SD, front.A, nA, nD);
    tryCaptures('D', SD, SA, front.D, nD, nA);
    // casualties, damage, exhaustion
    for (const [members, ownS, oppS] of [[war.attackers, SA, SD], [war.defenders, SD, SA]] as [string[], number, number][]) {
      for (const m of members) {
        const lossRate = WAR.casualtyRate * war.intensity * clamp(oppS / Math.max(1e-6, ownS), 0.3, 3);
        if (m.startsWith('rebel:')) { const f = w.factions[m.slice(6)]; if (f) f.strength *= 1 - lossRate * 3; continue; }
        const c = w.countries[m]; if (!c?.alive) continue;
        const lost = c.personnel * lossRate;
        c.personnel -= lost; war.casualties[m] = (war.casualties[m] ?? 0) + lost;
        war.exhaustion[m] = clamp((war.exhaustion[m] ?? 0) + WAR.exhaustionPerMonth * war.intensity + lost / Math.max(1, c.personnel) * 100 * WAR.exhaustionCasualty / 10 - (c.rally > 0 ? 0.5 : 0), 0, 100);
        for (const b of c.blocs) b.realApproval -= (isDemocracy(c.govType) ? 0.6 : 0.2) * war.intensity * (b.kind === 'military' ? -0.5 : 1);
      }
    }
    for (const [i] of [...front.A, ...front.D]) { w.regions[i].damage = clamp(w.regions[i].damage + 0.01 * war.intensity, 0, 1); w.regions[i].pop *= 1 - 0.0003 * war.intensity; }
    // capital lost -> surrender chance; exhaustion collapse
    for (const sideMembers of [war.defenders, war.attackers]) {
      const p = sideMembers[0]; if (p.startsWith('rebel:')) continue;
      const c = w.countries[p]; if (!c?.alive) continue;
      const capCtrl = w.regions[c.capital].controller;
      if (capCtrl !== p && sideOf(war, capCtrl) && rng.chance(WAR.capitalFallSurrender)) {
        endWar(x, war, `${c.name} capitulates after losing its capital`);
        if (!war.civil && !capCtrl.startsWith('rebel:') && rng.chance(0.5)) regimeChange(x, p, { winner: 'foreign', violent: true, occupier: capCtrl, how: `capitulation to ${w.countries[capCtrl].name}` });
        else if (!relocateCapital(x, c)) c.alive = false;
        break;
      }
    }
    if (!war.active) continue;
    const exA = war.exhaustion[war.attackers[0]] ?? 0, exD = war.exhaustion[war.defenders[0]] ?? 0;
    if ((exA > 95 || exD > 95) && rng.chance(0.25)) endWar(x, war, 'collapse from exhaustion');
    else if (!war.civil && exA > WAR.exhaustionCeasefire && exD > WAR.exhaustionCeasefire && rng.chance(0.05)) endWar(x, war, 'mutual exhaustion ceasefire');
  }
  // rally effect decays
  for (const c of Object.values(w.countries)) c.rally *= 0.85;
}

function occupation(x: Ctx) {
  const { w, s, rng } = x;
  w.regions.forEach((r, i) => {
    if (r.controller === r.owner || r.controller.startsWith('rebel:')) return;
    const occ = w.countries[r.controller]; if (!occ) return;
    const st = s.regions[i];
    const ethnicDiff = st.group || st.religion !== (s.countryData[r.controller]?.religion) ? 20 : 5;
    const resistance = 25 + ethnicDiff + 25 * occ.repression - (w.countries[r.owner]?.alive ? 0 : 10);
    r.unrest = clamp(r.unrest + (resistance - r.unrest) * 0.2);
    // sustained resistance may spawn an insurgency backed by the original owner
    if (r.unrest > 55 && rng.chance(0.01) && w.countries[r.owner]?.alive) {
      const f = spawnFaction(x, r.controller, 'ethnic', st.group ?? w.countries[r.owner].name, `${st.name} resistance`, 0.03);
      f.backers.push(r.owner);
      log(x, 'resistance', [r.controller, r.owner], `An armed resistance movement emerges in occupied ${st.name}.`);
    }
  });
}

function blocsAndUnrest(x: Ctx, c: Country) {
  const { w, s, rng } = x;
  const iso = c.iso3, dem = isDemocracy(c.govType), d = s.countryData[iso] ?? {};
  const base = (k: string) => d[k] ?? 0;
  const econ = clamp((c.growth - 2) * 2, -15, 12) - clamp((c.inflation - 4) * 0.8, 0, 25) - clamp((c.unemployment - 6) * 1.2, 0, 20);
  const services = ((c.spending.health - base('healthExpPctGdp') * 0.6) + (c.spending.education - base('eduExpPctGdp')) + (c.spending.welfare - ({ high: 12, upper: 6, lower: 3, low: 1.5 }[c.incomeGroup]))) * 1.5;
  const atWar = w.wars.filter(v => v.active && !v.civil && (v.attackers.includes(iso) || v.defenders.includes(iso)));
  const minorityRegions = regionsOf(w, iso, 'owner').filter(i => s.regions[i].group);
  const autonomy = minorityRegions.length ? minorityRegions.filter(i => w.regions[i].autonomy).length / minorityRegions.length : 0;
  for (const b of c.blocs) {
    let t = 50 + econ + clamp(services, -10, 10) - c.repression * 10 + (c.legitimacy - 50) / 5 + c.rally - atWar.length * (dem ? 3 : 1);
    switch (b.kind) {
      case 'workers': t += -clamp(c.unemployment - 6, 0, 15) + (c.spending.welfare - 3) * 0.5 - Math.min(10, c.refugeesHosted / Math.max(1, c.pop) * 200); break;
      case 'business': t += -(c.taxRate - c.baseTaxRate) * 1.5 - c.sanctionExposure * 40 + c.growth - c.unrest / 5 - (c.resourcePolicy.nationalised ? 10 : 0); break;
      case 'military': t += (c.spending.military - base('milPctGdp')) * 4 + (c.govType === 'military_junta' ? 15 : 0) - (c.purgedAt != null && w.turn - c.purgedAt < 12 ? 10 : 0) + atWar.length * 3; break;
      case 'rural': t += -(w.global.foodPrice - 1) * 15 + (c.spending.infrastructure - 3) * 2; break;
      case 'youth': t += -clamp(c.unemployment - 6, 0, 20) * 0.8 + c.civilLiberties * 15 - c.info.censorship * 10 - (c.info.internetShutdown ? 15 : 0); break;
      case 'minority': t += -c.repression * 25 + autonomy * 15 - 10; break;
      case 'religious': t += (c.govType === 'theocracy' ? 15 : 0) - (c.civilLiberties - 0.5) * 10; break;
      case 'retirees': t += (c.spending.health + c.spending.welfare - 8) * 1.5 - clamp(c.inflation - 4, 0, 20); break;
    }
    b.realApproval = clamp(clamp(b.realApproval) + (clamp(t) - clamp(b.realApproval)) * BLOCS.approvalSpeed);
    // perceived approval: propaganda in closed media environments makes blocs believe things are better
    const bias = BLOCS.propagandaBias * c.info.propaganda * c.info.stateMedia * (1 - c.info.pressFreedom) * (1 - c.suppressed / 150);
    b.approval = clamp(b.realApproval + bias);
    c.suppressed = clamp(c.suppressed + Math.max(0, b.approval - b.realApproval) * 0.01 * b.share, 0, 100);
    // unrest: grows below threshold, mobilises faster with open internet, repression cuts it but feeds suppressed discontent
    const mob = c.info.internetShutdown ? 0.3 : 1.2 - c.info.censorship * 0.7;
    if (b.approval < BLOCS.unrestThreshold) b.unrest += (BLOCS.unrestThreshold - b.approval) * BLOCS.unrestGrowth * mob * (c.curfew ? 0.6 : 1);
    else b.unrest -= b.unrest * BLOCS.unrestDecay;
    const cut = b.unrest * BLOCS.repressionUnrestCut * c.repression * 0.3;
    b.unrest = clamp(b.unrest - cut);
    c.suppressed = clamp(c.suppressed + cut * BLOCS.repressionBacklash * b.share, 0, 100);
    b.grievances = [c.inflation > 10 && 'prices', c.unemployment > 10 && 'jobs', c.repression > 0.5 && 'repression', atWar.length && 'war', b.kind === 'minority' && autonomy < 0.5 && 'autonomy', c.info.censorship > 0.6 && b.kind === 'youth' && 'censorship'].filter(Boolean) as string[];
  }
  // suppressed discontent can burst (leaks, crises, neighbours' revolutions)
  const neighbourRevolt = (d.borders ?? []).some((n: string) => (w.countries[n]?.stage ?? 0) >= 6);
  const trigger = (neighbourRevolt ? 2 : 0) + (c.growth < -2 ? 1 : 0) + (rng.chance(INFO.leakChance) ? 2 : 0);
  if (c.suppressed > 20 && rng.chance(BLOCS.suppressedBurstBase * c.suppressed / 10 * (1 + trigger))) {
    for (const b of c.blocs) { b.realApproval = clamp(b.realApproval - c.suppressed * 0.3); b.approval = b.realApproval; b.unrest = clamp(b.unrest + c.suppressed * 0.6); }
    log(x, 'discontent_erupts', [iso], `Long-suppressed discontent erupts in ${c.name}${neighbourRevolt ? ', inspired by upheaval next door' : ''}.`, true);
    c.suppressed *= 0.3;
  }
  // national unrest: share & influence weighted
  const wsum = c.blocs.reduce((a, b) => a + b.share * 0.7 + b.influence * 0.3, 0) || 1;
  c.unrest = clamp(c.blocs.reduce((a, b) => a + b.unrest * (b.share * 0.7 + b.influence * 0.3), 0) / wsum + c.terror * 10);
  const hasRebels = Object.values(w.factions).some(f => f.active && f.country === iso);
  const holdsLand = Object.values(w.factions).some(f => f.active && f.country === iso && f.regions.length);
  let stage = LADDER_THRESH.filter(t => c.unrest >= t).length - 1;
  if (hasRebels) stage = Math.max(stage, 5);
  if (holdsLand) stage = 6;
  if (stage !== c.stage && stage >= 2) log(x, 'unrest_' + ['calm', 'discontent', 'protests', 'strikes', 'riots', 'insurgency', 'civil_war'][stage], [iso], `${c.name}: ${['calm', 'discontent', 'protests', 'strikes', 'riots', 'armed insurgency', 'civil war'][stage]}${stage > c.stage ? ' spreads' : ' subsides'}.${b0Grievance(c)}`, stage >= 5);
  c.stage = stage;
  // region unrest & riot damage
  for (const id of regionsOf(w, iso, 'owner')) {
    const r = w.regions[id]; if (r.controller !== iso) continue;
    const st = s.regions[id];
    const minority = c.blocs.find(b => b.kind === 'minority');
    const sep = st.separatism * 60 * (minority ? (100 - minority.approval) / 100 : 0.5) * (r.autonomy ? 0.5 : 1);
    r.unrest = clamp(r.unrest + (c.unrest * 0.7 + sep + r.damage * 30 - r.unrest) * 0.2);
    if (stage >= 4 && r.unrest > 60) r.damage = clamp(r.damage + RIOT_DAMAGE, 0, 1);
  }
  c.legitimacy = clamp(c.legitimacy + (50 + (avgApproval(c) - 50) * 0.6 + (c.constitution.status === 'provisional' ? -10 : 0) - c.legitimacy) * 0.05);
  c.stability = clamp(100 - c.unrest * 0.7 - c.suppressed * 0.2 + (c.legitimacy - 50) * 0.3 - (stage >= 6 ? 15 : 0));
}
const b0Grievance = (c: Country) => { const g = [...new Set(c.blocs.flatMap(b => b.grievances))]; return g.length ? ` Grievances: ${g.join(', ')}.` : ''; };
export const avgApproval = (c: Country, real = true) => {
  const t = c.blocs.reduce((a, b) => a + b.influence, 0) || 1;
  return c.blocs.reduce((a, b) => a + (real ? b.realApproval : b.approval) * b.influence, 0) / t;
};

function factions(x: Ctx) {
  const { w, s, rng } = x;
  // spawn: insurgencies from sustained riots, separatists from aggrieved minority regions
  for (const iso of alive(w)) {
    const c = w.countries[iso];
    const existing = Object.values(w.factions).filter(f => f.active && f.country === iso);
    if (c.stage >= 4 && !existing.some(f => f.ideology !== 'separatist') && rng.chance(INSURGENCY_SPAWN * (c.unrest - 55) / 45)) {
      const worst = [...c.blocs].sort((a, b) => a.approval * (1 - a.influence) - b.approval * (1 - b.influence))[0];
      const ideology = worst.kind === 'religious' ? 'religious' : worst.kind === 'military' ? 'military' : worst.kind === 'minority' ? 'ethnic' : worst.kind === 'youth' && c.literacy > 80 ? 'democratic' : 'revolutionary';
      const f = spawnFaction(x, iso, ideology, null, `${c.name} ${{ religious: 'Islamic/religious front', military: 'officers’ movement', ethnic: 'ethnic liberation army', democratic: 'democratic resistance', revolutionary: 'revolutionary front' }[ideology]}`, 0.08 * c.unrest / 100);
      log(x, 'insurgency', [iso], `Armed insurgency breaks out in ${c.name}: ${f.name} (${ideology}).`, true);
    }
    for (const id of regionsOf(w, iso, 'owner')) {
      const st = s.regions[id], r = w.regions[id];
      if (!st.group || st.separatism < 0.3 || r.unrest < 60 || r.controller !== iso) continue;
      if (existing.some(f => f.group === st.group) || Object.values(w.factions).some(f => f.active && f.group === st.group && f.country === iso)) continue;
      if (rng.chance(SEPARATIST_SPAWN * st.separatism)) {
        const f = spawnFaction(x, iso, 'separatist', st.group, `${st.group} separatist movement`, 0.05);
        const kin = alive(w).find(o => o !== iso && (s.countryData[o]?.borders ?? []).includes(iso) && w.attitudes[o][iso] < -30);
        if (kin) f.backers.push(kin);
        log(x, 'separatism', [iso], `${f.name} takes up arms in ${c.name} (${st.name}).`, true);
      }
    }
  }
  for (const f of Object.values(w.factions)) {
    if (!f.active) continue;
    const c = w.countries[f.country];
    if (!c?.alive) { f.active = false; continue; }
    const theirs = f.group ? regionsOf(w, f.country, 'owner').filter(i => s.regions[i].group === f.group) : regionsOf(w, f.country, 'owner');
    const regUnrest = theirs.length ? theirs.reduce((a, i) => a + w.regions[i].unrest, 0) / theirs.length : c.unrest;
    const backing = f.backers.filter(b => w.countries[b]?.alive).reduce((a, b) => a + strength(w.countries[b]) * 0.02, 0);
    const growth = (regUnrest - 45) / 100 * 0.08 * strength(c) * 0.1 + backing * 0.1 - c.spending.security / 100 * strength(c) * 0.02;
    f.strength = Math.max(0, f.strength + growth);
    // civil war: a faction strong enough starts contesting regions -> war between government and rebels
    let war = w.wars.find(v => v.active && v.civil && v.attackers.includes('rebel:' + f.id));
    if (!war && f.strength > strength(c) * 0.12) {
      const seed = (f.group ? theirs : regionsOf(w, f.country)).filter(i => w.regions[i].controller === f.country).sort((a, b) => w.regions[b].unrest - w.regions[a].unrest)[0];
      if (seed != null) {
        setController(x, seed, 'rebel:' + f.id);
        war = { id: 'W' + (w.wars.length + 1), name: `${c.name} civil war (${f.name})`, attackers: ['rebel:' + f.id], defenders: [f.country], start: w.turn, goals: f.group ? theirs : [c.capital], exhaustion: {}, casualties: {}, active: true, civil: true, intensity: 0.8 };
        w.wars.push(war);
        log(x, 'civil_war', [f.country, ...f.backers], `Civil war in ${c.name}: ${f.name} seizes ${s.regions[seed].name}.`, true);
      }
    }
    if (f.strength < strength(c) * 0.01 && !f.regions.length) { f.active = false; if (war) endWar(x, war, 'insurgency defeated'); log(x, 'insurgency_defeated', [f.country], `${f.name} has been defeated.`); continue; }
    // revolution: rebels hold the capital and most of the core population
    const corePop = c.core.reduce((a, i) => a + w.regions[i].pop, 0) || 1;
    const rebelPop = f.regions.reduce((a, i) => a + w.regions[i].pop, 0);
    const capHeld = w.regions[c.capital].controller === 'rebel:' + f.id;
    if (f.ideology !== 'separatist' && capHeld && (rebelPop / corePop > 0.5 || rng.chance(WAR.capitalFallSurrender))) {
      if (!REGIME_CAN_FALL) { relocateCapital(x, c); continue; }
      if (war) endWar(x, war, `${f.name} victory`);
      f.active = false;
      for (const i of [...f.regions]) setController(x, i, f.country);
      log(x, 'regime_collapse', [f.country, ...f.backers], `The government of ${c.name} collapses. ${f.name} takes power.`, true);
      regimeChange(x, f.country, { winner: f.ideology === 'ethnic' ? 'ethnic' : f.ideology, violent: true, backers: f.backers, how: `the victory of ${f.name} in civil war` });
      continue;
    }
    if (capHeld && !relocateCapital(x, c)) c.alive = false;
    // separatists: holding all their regions for long enough -> independence
    if (f.group && theirs.length && theirs.every(i => w.regions[i].controller === 'rebel:' + f.id)) {
      f.holdMonths++;
      if (f.holdMonths >= INDEPENDENCE_HOLD_MONTHS) { if (war) endWar(x, war, 'separatist victory'); createCountry(x, f.country, theirs, f); }
    } else f.holdMonths = 0;
  }
}

function coupsAndInstitutions(x: Ctx, c: Country) {
  const { w, rng } = x;
  const iso = c.iso3, dem = isDemocracy(c.govType);
  const mil = c.blocs.find(b => b.kind === 'military');
  const milA = mil?.realApproval ?? 50;
  const purgeShield = c.purgedAt != null && w.turn - c.purgedAt < 6 ? 0.4 : 1;
  const provisional = c.provisionalUntil != null ? 2 : 1;
  c.coupRisk = COUP_BASE * clamp((45 - milA) / 45, 0, 1) * (1 - c.stability / 100) * (dem ? 0.15 : 1) * (c.govType === 'military_junta' ? 1.5 : 1) * purgeShield * provisional * (c.stage >= 4 ? 2 : 1);
  if (rng.chance(c.coupRisk)) {
    if (rng.chance(0.55)) { log(x, 'coup', [iso], `Military coup in ${c.name}. The Head of Government has been removed.`, true); regimeChange(x, iso, { winner: 'military', violent: rng.chance(0.4), how: 'a military coup' }); return; }
    log(x, 'coup_failed', [iso], `A coup attempt in ${c.name} fails; plotters arrested.`, true);
    c.purgedAt = w.turn; if (mil) mil.realApproval -= 10; c.legitimacy -= 5;
  }
  // security forces may refuse to repress when the military bloc is alienated
  if (c.stage >= 4 && c.repression > 0.5 && milA < 35 && rng.chance(DEFECTION_BASE * (35 - milA) / 35)) {
    log(x, 'defection', [iso], `Security forces in ${c.name} refuse orders to fire on protesters; units defect.`, true);
    c.repression *= 0.5;
    const f = Object.values(w.factions).find(f => f.active && f.country === iso && f.ideology !== 'separatist') ?? spawnFaction(x, iso, 'democratic', null, `${c.name} national salvation front`, 0.1);
    f.strength += strength(c) * 0.1; c.readiness *= 0.8;
  }
  // legislative elections (leader is permanent; elections only shape legislative support)
  if (c.nextElection != null && w.turn >= c.nextElection && c.constitution.legislature.elected) {
    const appr = avgApproval(c, false);
    const fair = dem ? 1 : 0.4;
    c.legislatureSupport = clamp(fair * (0.5 + (appr - 45) / 60 + x.rng.range(-0.08, 0.08)) + (1 - fair) * 0.75, 0.1, 0.95);
    c.nextElection = w.turn + c.constitution.legislature.termYears * 12;
    log(x, 'election', [iso], `Legislative elections in ${c.name}: government-aligned parties win ${(c.legislatureSupport * 100).toFixed(0)}% of seats.`);
  } else c.legislatureSupport = clamp(c.legislatureSupport + ((0.5 + (avgApproval(c) - 45) / 80) - c.legislatureSupport) * 0.01, 0.05, 0.98);
  // scandals: public in free media, suppressed otherwise
  if (rng.chance(EVENTS.scandal * c.corruption * 2)) {
    if (c.info.pressFreedom > 0.5) { for (const b of c.blocs) b.realApproval -= 4; log(x, 'scandal', [iso], `A corruption scandal engulfs the government of ${c.name}.`); }
    else c.suppressed += 5;
  }
  // provisional governments ratify once stable
  if (c.provisionalUntil != null && w.turn >= c.provisionalUntil) {
    if (c.stability >= RATIFY_STABILITY) {
      c.constitution.status = 'ratified'; c.provisionalUntil = null; c.pendingDraft = null;
      c.constitution.history.push({ version: c.constitution.version, turn: w.turn, change: 'ratified', reason: c.constitution.amendment === 'referendum' ? 'referendum' : 'decree' });
      log(x, 'constitution_ratified', [iso], `${c.name} ratifies its new constitution (${['liberal_democracy', 'electoral_democracy'].includes(c.govType) ? 'by referendum' : 'by decree'}).`);
    } else c.provisionalUntil = w.turn + 3;
  }
}

function international(x: Ctx) {
  const { w, rng } = x;
  // recognition of new states
  for (const [iso, recs] of Object.entries(w.recognitions)) {
    if (!w.countries[iso]?.alive) continue;
    for (const o of alive(w)) if (o !== iso && !recs.includes(o) && rng.chance(0.03) && (w.attitudes[o][iso] ?? 0) > 10) { recs.push(o); log(x, 'recognition', [o, iso], `${w.countries[o].name} recognises ${w.countries[iso].name}.`); }
  }
  // EU single market & aid flows
  for (const c of Object.values(w.countries)) if (c.alive) for (const [to, usd] of Object.entries(c.aidOut)) if (w.countries[to]?.alive) w.countries[to].gdp += usd * 0.3;
}

function nonStateAndRefugees(x: Ctx) {
  const { w, s, rng } = x;
  for (const iso of alive(w)) {
    const c = w.countries[iso], d = s.countryData[iso] ?? {};
    const poor = c.gdp / Math.max(1, c.pop) < 4000 ? 1 : 0.3;
    const nearWar = (d.borders ?? []).some((n: string) => (w.countries[n]?.stage ?? 0) >= 6) ? 0.15 : 0;
    c.terror = clamp(c.terror + ((0.03 + 0.5 * poor * c.unrest / 100 + nearWar) - c.terror) * 0.03, 0, 1);
    if (rng.chance(c.terror * 0.04)) {
      for (const b of c.blocs) b.realApproval -= isDemocracy(c.govType) ? 2 : 1;
      c.rally += 2;
      log(x, 'terror_attack', [iso], `Terrorist attack in ${c.name}.`);
    }
    c.crime = clamp(c.crime + ((d.crime ?? 0.2) + c.unrest / 400 - c.spending.security / 50 - c.crime) * 0.02, 0, 1);
    // refugees from war on own soil / civil war / collapse
    const intensity = Math.max(warOnSoil(w, iso), c.stage >= 6 ? 0.6 : c.stage >= 5 ? 0.2 : 0);
    if (intensity > 0.05) {
      const out = c.pop * WAR.refugeeRate * intensity;
      const hosts = (d.borders ?? []).filter((n: string) => w.countries[n]?.alive);
      const wt = (n: string) => ({ open: 1, restricted: 0.4, closed: 0.08 }[w.countries[n].refugeePolicy]) * Math.sqrt(w.countries[n].gdp);
      const tot = hosts.reduce((a: number, n: string) => a + wt(n), 0);
      if (tot > 0) {
        for (const n of hosts) { const h = w.countries[n]; const k = out * wt(n) / tot; h.refugeesHosted += k; if (k / h.pop > 0.002) shift(w, iso, n, -1); }
        c.refugeesOut += out;
        for (const id of regionsOf(w, iso)) w.regions[id].pop *= 1 - WAR.refugeeRate * intensity;
        if (out > 1e5 && rng.chance(0.2)) log(x, 'refugees', [iso, ...hosts.slice(0, 3)], `${Math.round(out / 1e3)}k refugees flee ${c.name} this month.`);
      }
    }
    c.refugeesHosted *= 0.995;
  }
}

function worldEvents(x: Ctx) {
  const { w, s, rng } = x;
  const live = alive(w);
  for (const iso of live) {
    const c = w.countries[iso];
    if (rng.chance(EVENTS.disasterPerCountry * (1 + w.global.scarcity))) {
      const kind = rng.pick(['earthquake', 'flood', 'cyclone', 'drought', 'wildfire']);
      const sev = rng.range(0.5, 3);
      c.shocks.push({ growth: -sev, months: 3, why: kind });
      const ids = regionsOf(w, iso); const r = rng.pick(ids); if (r != null) w.regions[r].damage = clamp(w.regions[r].damage + 0.1 * sev, 0, 1);
      const response = (c.spending.welfare + c.spending.health) > 8 ? 2 : -3;
      for (const b of c.blocs) b.realApproval += response;
      log(x, 'disaster', [iso], `A ${kind} strikes ${c.name}${r != null ? ` (${s.regions[r].name})` : ''}.`, sev > 2.5, { region: r });
    }
    if (debtRatio(c) > borrowLimit(c) * 0.75 && rng.chance(EVENTS.financialCrisisPerHighDebt * debtRatio(c))) {
      c.shocks.push({ growth: -4, months: 6, why: 'financial crisis' }); c.unemployment += 2; c.inflation += 3;
      for (const b of c.blocs) b.realApproval -= b.kind === 'business' ? 10 : 5;
      log(x, 'financial_crisis', [iso], `Financial crisis in ${c.name}: bond yields spike, banks wobble.`, true);
    }
    if (rng.chance(EVENTS.cropFailure * (1 + 3 * w.global.scarcity) * ((s.countryData[iso]?.waterStress ?? 20) > 40 ? 2 : 1))) {
      c.inflation += 2; for (const b of c.blocs) if (b.kind === 'rural') b.realApproval -= 10;
      log(x, 'crop_failure', [iso], `Crop failure in ${c.name} drives up food prices.`);
    }
  }
  if (!w.global.pandemic && rng.chance(EVENTS.pandemic)) { w.global.pandemic = 8; log(x, 'pandemic', [], 'A new pandemic spreads worldwide; borders close and economies contract.', true); }
  if (Math.abs(w.global.oilPrice - 1) > 0.5 && rng.chance(0.1)) log(x, 'oil_shock', [], `Oil price at ${(w.global.oilPrice * 100).toFixed(0)}% of its starting level.`);
}

function attitudes(x: Ctx) {
  const { w, s } = x;
  if (w.turn % 3 !== 0) return; // ponytail: structural pull recomputed quarterly (O(n²) per call)
  const live = alive(w);
  for (const a of live) for (const b of live) if (a !== b) {
    const base = structuralAttitude(w, s, a, b);
    w.attitudes[a][b] = Math.round(clamp(w.attitudes[a][b] + (base - w.attitudes[a][b]) * ATT.revert * 3, -100, 100));
  }
}

function scores(x: Ctx) {
  const { w } = x;
  const live = alive(w);
  const maxG = Math.max(...live.map(i => w.countries[i].gdp)), maxS = Math.max(...live.map(i => strength(w.countries[i])));
  const worldGdp = live.reduce((a, i) => a + w.countries[i].gdp, 0);
  for (const iso of live) {
    const c = w.countries[iso];
    const pc = c.gdp / Math.max(1, c.pop);
    const income = clamp((Math.log10(Math.max(pc, 300)) - 2.5) / 2.5 * 100);
    const health = clamp((c.lifeExp - 50) * 3 + (c.spending.health - 4) * 2);
    const safety = clamp(100 - c.unrest - (c.stage >= 6 ? 30 : 0) - c.terror * 20 - (w.wars.some(v => v.active && (v.attackers.includes(iso) || v.defenders.includes(iso))) ? 15 : 0));
    const freedom = clamp(c.civilLiberties * 100 * (1 - c.repression * 0.7));
    const jobs = clamp(100 - c.unemployment * 4 - Math.max(0, c.inflation - 3) * 2);
    const welfare = 0.25 * income + 0.2 * health + 0.2 * safety + 0.15 * freedom + 0.2 * jobs;
    const approval = avgApproval(c);
    const rebelRisk = Object.values(w.factions).filter(f => f.active && f.country === iso).reduce((a, f) => a + f.strength / Math.max(1e-6, strength(c)), 0);
    const survival = clamp(100 - c.coupRisk * 1200 - rebelRisk * 60 - (w.regions[c.capital].controller !== iso ? 40 : 0));
    const allies = w.treaties.filter(t => t.kind === 'alliance' && (t.a === iso || t.b === iso)).map(t => t.a === iso ? t.b : t.a);
    const power = clamp(45 * c.gdp / maxG + 45 * strength(c) / maxS + 10 * allies.reduce((a, o) => a + (w.countries[o]?.gdp ?? 0), 0) / worldGdp * 5);
    const k = c.incentives;
    c.scores = { welfare: +welfare.toFixed(1), approval: +approval.toFixed(1), survival: +survival.toFixed(1), power: +power.toFixed(1), weighted: +(k.welfare * welfare + k.approval * approval + k.survival * survival + k.power * power).toFixed(1) };
  }
}
