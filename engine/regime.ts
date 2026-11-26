// Government types, incentive weights, constitution templates and regime-change rules.
// Used by the data build (initial values) and by the engine (after a regime change).
import type { Bloc, Constitution, GovType, Incentives } from './types.ts';
import { Rng, clamp } from './util.ts';

export interface RegimeFacts {
  system: string; polyarchy: number; corruption: number; federal: boolean; bicameral: boolean;
  religion: string; hasMinorities: boolean; age65: number; urban: number; electionYears: number;
}

/** Regime class from constitutional system + V-Dem electoral democracy index (0..1). */
export function classify(system: string, polyarchy: number): GovType {
  if (system === 'junta') return 'military_junta';
  if (system === 'onep') return 'one_party_state';
  if (system === 'theo') return 'theocracy';
  if (system === 'amon') return 'absolute_monarchy';
  if (polyarchy >= 0.7) return 'liberal_democracy';
  if (polyarchy >= 0.5) return 'electoral_democracy';
  if (polyarchy >= 0.3) return 'hybrid_regime';
  return 'authoritarian';
}

export const DEMOCRATIC: GovType[] = ['liberal_democracy', 'electoral_democracy'];
export const isDemocracy = (g: GovType) => DEMOCRATIC.includes(g);

/**
 * Incentive weights (sum to 1). How a government of this kind actually behaves:
 * - accountability (polyarchy) pushes weight toward welfare and approval: voters, courts and press punish neglect;
 * - low accountability pushes weight toward survival: rulers answer to a small coalition and fear coups;
 * - power rises with autocracy and corruption (prestige/rents) and in revolutionary regimes (exporting the model).
 * Hand-edit results in data/incentives.json.
 */
export function computeIncentives(gov: GovType, polyarchy: number, corruption: number): Incentives {
  const acc = clamp(polyarchy, 0, 1);
  let welfare = 0.15 + 0.35 * acc;
  let approval = 0.10 + 0.25 * acc;
  let survival = 0.15 + 0.40 * (1 - acc);
  let power = 0.15 + 0.15 * (1 - acc) + 0.10 * corruption;
  if (gov === 'military_junta') { survival += 0.10; power += 0.05; }
  if (gov === 'revolutionary_state') { power += 0.10; survival += 0.05; }
  if (gov === 'theocracy') { survival += 0.05; power += 0.05; }
  if (gov === 'absolute_monarchy') { survival += 0.05; welfare += 0.05; } // rentier welfare buys loyalty
  const t = welfare + approval + survival + power;
  const r = (x: number) => Math.round((x / t) * 1000) / 1000;
  const out = { welfare: r(welfare), approval: r(approval), survival: r(survival), power: r(power) };
  out.power = Math.round((1 - out.welfare - out.approval - out.survival) * 1000) / 1000; // exact sum 1
  return out;
}

const HEADS: Record<string, [string, string, string]> = {
  pres: ['President', 'President', 'Directly elected executive presidency'],
  semi: ['President', 'Prime Minister', 'Dual executive: elected president, prime minister answerable to the legislature'],
  parl: ['President (ceremonial)', 'Prime Minister', 'Government formed by and answerable to the legislature'],
  cmon: ['Monarch (ceremonial)', 'Prime Minister', 'Constitutional monarchy; government answerable to parliament'],
  smon: ['Monarch', 'Prime Minister (appointed by the Monarch)', 'Monarch holds significant executive power alongside a partly elected legislature'],
  amon: ['Monarch', 'Monarch', 'Hereditary monarch rules by decree'],
  onep: ['President / General Secretary', 'Premier', 'Ruling party monopoly on political power'],
  theo: ['Supreme Leader', 'President', 'Religious authority supreme over elected institutions'],
  junta: ['Chairman of the Ruling Council', 'Prime Minister (appointed)', 'Military council rules pending transition'],
  rev: ['Chairman of the Revolutionary Council', 'Chairman of the Revolutionary Council', 'Revolutionary movement governs through a vanguard council'],
};

const SYSTEM_FOR: Record<GovType, string> = {
  liberal_democracy: 'parl', electoral_democracy: 'pres', hybrid_regime: 'pres', authoritarian: 'pres',
  absolute_monarchy: 'amon', one_party_state: 'onep', theocracy: 'theo', military_junta: 'junta', revolutionary_state: 'rev',
};

/** Template constitution. Used at start (with the real system) and as fallback after regime change. */
export function constitutionTemplate(gov: GovType, f: RegimeFacts, source = 'template from system type + V-Dem score'): Constitution {
  const system = f.system || SYSTEM_FOR[gov];
  const [hos, hog, how] = HEADS[system] ?? HEADS.pres;
  const dem = isDemocracy(gov); const acc = f.polyarchy;
  const legislature: Constitution['legislature'] =
    gov === 'absolute_monarchy' ? { type: 'consultative', powers: 0.1, elected: false, termYears: 4 }
    : gov === 'military_junta' || gov === 'revolutionary_state' ? { type: 'none', powers: 0, elected: false, termYears: 0 }
    : { type: f.bicameral ? 'bicameral' : 'unicameral', powers: Math.round(clamp(0.2 + 0.7 * acc, 0, 1) * 100) / 100, elected: true, termYears: f.electionYears };
  return {
    version: 1, status: 'ratified', govType: gov, system,
    headOfState: hos, headOfGovernment: hog,
    howPowerHeld: how + '. The current Head of Government serves indefinitely; no electoral, term-limit or parliamentary mechanism can remove them.',
    legislature,
    courts: { independence: Math.round(clamp(acc * 0.9 + 0.05 - f.corruption * 0.2, 0.02, 0.95) * 100) / 100 },
    liberties: { press: acc > 0.5, assembly: acc > 0.4, speech: acc > 0.45 },
    emergencyPowers: dem ? 'limited' : acc > 0.3 ? 'broad' : 'unlimited',
    militaryRole: gov === 'military_junta' ? 'ruling' : dem ? 'civilian_control' : 'political',
    religionRole: gov === 'theocracy' ? 'theocratic' : (f.religion.startsWith('muslim') && !dem) || system === 'amon' ? 'established' : 'secular',
    territorial: f.federal ? 'federal' : f.hasMinorities ? 'unitary_with_autonomy' : 'unitary',
    amendment: dem ? (acc > 0.75 ? 'referendum' : 'supermajority') : gov === 'hybrid_regime' ? 'legislature' : 'decree',
    succession: dem ? 'Deputy assumes office pending appointment of a successor by the governing institutions'
      : system === 'amon' || system === 'smon' || system === 'cmon' ? 'Hereditary, designated crown prince'
      : 'Designated by the ruling council or party leadership',
    preamble: '', generated: true, source, history: [],
  };
}

/**
 * Regime-change outcome table. Weights are relative probabilities, loosely based on observed transitions
 * (e.g. Geddes-Wright-Frantz autocratic regimes data, Polity transitions):
 * - coups overwhelmingly produce military rule; some promise elections (hybrid) — ~70/20/10;
 * - violent revolutions mostly yield one-party/revolutionary regimes (Russia 1917, China 1949, Iran 1979 for religious);
 * - peaceful mass protests in richer, literate societies often democratise (1989 Eastern Europe), poorer ones fall back to hybrid;
 * - religious movements produce theocracies or religious-tinged authoritarian rule;
 * - separatists copy their region's previous autonomy arrangement or kin states: mostly hybrid/electoral;
 * - foreign occupiers install puppets mirroring their own system (handled by caller: 'mirror').
 */
export function chooseNewGovType(rng: Rng, ctx: { winner: string; violent: boolean; literacy: number; gdpPc: number; prev: GovType; backerGov?: GovType }): GovType {
  const rich = ctx.gdpPc > 12000 ? 1 : ctx.gdpPc > 4000 ? 0.5 : 0;
  const lit = ctx.literacy / 100;
  const W: Partial<Record<GovType, number>> = {};
  switch (ctx.winner) {
    case 'military':
      Object.assign(W, { military_junta: 70, authoritarian: 12, hybrid_regime: 12 + 10 * rich, electoral_democracy: 3 + 5 * rich }); break;
    case 'revolutionary':
      Object.assign(W, { revolutionary_state: ctx.violent ? 45 : 20, one_party_state: ctx.violent ? 30 : 15, authoritarian: 15, hybrid_regime: 7, electoral_democracy: ctx.violent ? 3 : 15 }); break;
    case 'democratic':
      Object.assign(W, { electoral_democracy: 30 + 30 * rich * lit + (ctx.violent ? -10 : 10), liberal_democracy: 5 + 20 * rich * lit, hybrid_regime: 30, authoritarian: ctx.violent ? 20 : 8 }); break;
    case 'religious':
      Object.assign(W, { theocracy: 50, authoritarian: 25, hybrid_regime: 15, electoral_democracy: 5 }); break;
    case 'ethnic': case 'separatist':
      Object.assign(W, { hybrid_regime: 35, electoral_democracy: 25 + 15 * rich, authoritarian: 25, military_junta: 10, liberal_democracy: 5 * rich }); break;
    default:
      Object.assign(W, { authoritarian: 40, hybrid_regime: 30, military_junta: 15, electoral_democracy: 15 });
  }
  if (ctx.backerGov) W[ctx.backerGov] = (W[ctx.backerGov] ?? 0) + 25; // backers push their own model
  W[ctx.prev] = (W[ctx.prev] ?? 0) * 0.6;                            // a revolution rarely restores what it overthrew
  return rng.weighted(W as Record<GovType, number>);
}

/** Polyarchy-equivalent used after regime change to recompute institutions. */
export const POLYARCHY_OF: Record<GovType, number> = {
  liberal_democracy: 0.8, electoral_democracy: 0.6, hybrid_regime: 0.4, authoritarian: 0.2,
  absolute_monarchy: 0.08, one_party_state: 0.08, theocracy: 0.15, military_junta: 0.12, revolutionary_state: 0.1,
};

/** Which blocs matter under which government (0..1 multipliers on population share). */
export function blocInfluence(gov: GovType, kind: Bloc['kind'], share: number): number {
  const dem = isDemocracy(gov);
  const base = dem ? share * 1.2 : share * 0.4;
  const elite: Record<string, number> = dem
    ? { business: 0.15, military: 0.05, religious: 0.05 }
    : gov === 'military_junta' ? { military: 0.55, business: 0.15, religious: 0.05 }
    : gov === 'theocracy' ? { religious: 0.4, military: 0.25, business: 0.1 }
    : gov === 'absolute_monarchy' ? { business: 0.3, military: 0.25, religious: 0.15 }
    : { military: 0.3, business: 0.25, religious: 0.05 };
  return Math.round(clamp(base + (elite[kind] ?? 0), 0.01, 1) * 1000) / 1000;
}

/** 4–7 population blocs adapted to the country. Starting approval comes from the caller. */
export function makeBlocs(gov: GovType, f: { urban: number; age014: number; age65: number; minorityShare: number; minorityName: string; religious: boolean }, approval: number): Bloc[] {
  const out: [Bloc['kind'], string, number][] = [];
  const rural = clamp((100 - f.urban) / 100 * 0.9, 0.02, 0.8);
  const youth = clamp(0.12 + f.age014 / 300, 0.08, 0.3);
  const retirees = f.age65 > 10 ? f.age65 / 100 : 0;
  const minority = f.minorityShare > 0.03 ? f.minorityShare : 0;
  const religious = f.religious ? 0.1 : 0;
  const business = 0.03, military = 0.02;
  const workers = Math.max(0.1, 1 - rural - youth - retirees - minority - religious - business - military);
  out.push(['workers', 'Urban workers', workers], ['business', 'Business elites', business], ['military', 'Military & security services', military]);
  if (rural > 0.05) out.push(['rural', 'Rural population', rural]);
  out.push(['youth', 'Urban youth', youth]);
  if (minority) out.push(['minority', f.minorityName || 'Ethnic & religious minorities', minority]);
  if (religious) out.push(['religious', 'Religious conservatives', religious]);
  if (retirees && out.length < 7) out.push(['retirees', 'Retirees', retirees]);
  const tot = out.reduce((s, b) => s + b[2], 0);
  return out.map(([kind, name, s]) => {
    const share = Math.round((s / tot) * 1000) / 1000;
    return { kind, name, share, approval, realApproval: approval, unrest: 0, influence: blocInfluence(gov, kind, share), grievances: [] };
  });
}
