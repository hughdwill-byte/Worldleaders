// All tunable numbers in one place. Units noted per constant. Monthly unless stated.

export const REGIME_CAN_FALL = process.env.REGIME_CAN_FALL !== 'false';
export const QUARTERLY_REVIEW_EVERY = 3;            // every Nth turn all countries act
export const MAX_AGENTS_PER_TURN = Number(process.env.MAX_AGENTS_PER_TURN || 999);

// ---- Economy ----
export const ECON = {
  potentialGrowthPull: 0.15,      // monthly pull of growth toward the country's long-run potential
  taxDrag: 0.08,                  // growth pts lost per pt of tax above baseline
  investBoost: 0.25,              // growth pts per pt of GDP extra infrastructure/research spending
  unrestDrag: 4,                  // growth pts lost at unrest 100
  sanctionDrag: 5,                // growth pts lost at full sanctions weighted by trade exposure
  warDrag: 8,                     // growth pts lost at full-intensity war on own soil
  mobilizationDrag: 2,            // growth pts lost at full mobilisation
  inflationTarget: 3,
  inflationPull: 0.1,
  deficitInflation: 0.15,         // inflation pts per pt of GDP deficit when debt is high
  okun: 0.35,                     // unemployment change per growth gap pt (annual)
  interestBase: 0.03,             // nominal yield on debt at low debt
  interestDebtPenalty: 0.04,      // extra yield per 100% debt/GDP
  borrowLimitRich: 2.5,           // max debt/GDP before forced austerity (high income; Japan ~2.3)
  borrowLimitPoor: 1.1,           // (low/middle income)
  imfLoanPctGdp: 0.05,
  oilPriceVol: 0.06,              // monthly st.dev of oil price index
};

// ---- Population blocs ----
export const BLOCS = {
  approvalSpeed: 0.12,            // monthly fraction moved toward target approval
  unrestThreshold: 38,            // approval below which unrest grows
  unrestGrowth: 0.35,             // unrest gained per approval pt below threshold
  unrestDecay: 0.08,              // monthly decay fraction of unrest when content
  repressionUnrestCut: 0.5,       // unrest reduction fraction at full repression
  repressionBacklash: 0.6,        // suppressed discontent gained per pt of unrest suppressed
  propagandaBias: 18,             // max approval pts propaganda can add to perceived approval
  suppressedBurstBase: 0.004,     // monthly base chance of suppressed discontent bursting
};

// ---- Unrest ladder (national unrest thresholds) ----
export const LADDER = ['calm', 'discontent', 'protests', 'strikes', 'riots', 'insurgency', 'civil_war', 'collapse'] as const;
export const LADDER_THRESH = [0, 20, 35, 50, 62, 74];   // unrest needed for stage 0..5
export const STRIKE_GDP_HIT = 1.5;                      // annual growth pts lost during strikes
export const RIOT_DAMAGE = 0.003;                       // region damage per month of riots
export const INSURGENCY_SPAWN = 0.08;                   // monthly chance a faction forms at stage>=4 (scaled)
export const SEPARATIST_SPAWN = 0.03;
export const DEFECTION_BASE = 0.15;                     // chance per crackdown that forces refuse when military approval low
export const COUP_BASE = 0.012;                         // monthly coup chance at worst conditions
export const INDEPENDENCE_HOLD_MONTHS = 6;              // separatists must hold all their regions this long

// ---- War ----
export const WAR = {
  terrain: { flat: 1.0, mountain: 1.8, jungle: 1.5, desert: 1.1, urban: 1.6 } as Record<string, number>,
  captureSteep: 2.2,              // sigmoid steepness of capture probability vs strength ratio
  captureMid: 3.0,                // local strength ratio giving 50% capture chance (attackers need ~3:1)
  maxCapturesPerMonth: 2,
  supplyFalloffKm: 2500,          // strength halves per this distance from own capital
  casualtyRate: 0.0006,           // fraction of personnel lost per month at full intensity
  exhaustionPerMonth: 1.5,
  exhaustionCasualty: 40,         // exhaustion per 1% of personnel lost
  exhaustionCeasefire: 70,        // rule-based sides seek ceasefire above this
  nuclearDeterrence: 0.15,        // capture chance multiplier against a nuclear state's core
  allyJoinTreaty: 0.75,
  allyJoinNato: 0.9,
  occupationShare: 0.3,           // share of region GDP the occupier extracts
  occupationCostPerMillion: 5e7,  // USD/month per million people occupied
  refugeeRate: 0.004,             // fraction of a war region's people fleeing per month
  capitalFallSurrender: 0.35,     // monthly surrender chance once capital is lost
};

// ---- Information ----
export const INFO = {
  yesManMax: 0.5,                 // max share of bad news hidden from autocratic leaders
  leakChance: 0.01,
  interceptChance: 0.05,          // chance a private cable is intercepted by a capable third party
  covertDiscovery: 0.3,
};

// ---- Transitions ----
export const PROVISIONAL_MONTHS: [number, number] = [3, 12];
export const RATIFY_STABILITY = 55;

// ---- World events (monthly probabilities) ----
export const EVENTS = {
  disasterPerCountry: 0.004,
  pandemic: 0.002,
  financialCrisisPerHighDebt: 0.004,
  cropFailure: 0.003,
  climateStressPerYear: 0.01,     // global scarcity index increase per year
  scandal: 0.015,
};

// ---- Attitudes ----
export const ATT = {
  revert: 0.01, aid: 6, sanction: -15, war: -60, annexWorld: -12, annexBlocExtra: -15, cableTone: 3, alliance: 15, sharedBlocDrift: 0.05,
};
