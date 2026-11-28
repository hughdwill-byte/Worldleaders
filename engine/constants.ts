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
export const DEFECTION_BASE = 0.15;                     // chance per crackdown that forces refuse when military approval low
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

// ---- Empirical hazards (engine/hazards.ts). Annual base rates; converted to monthly with 1-(1-p)^(1/12). ----
// Odds ratios (OR) combine on the logit scale: logit(p) = logit(base) + Σ ln(OR_i)·x_i  (assumes independence; see NOTES.md)
export const HAZ = {
  // Fearon & Laitin 2003 (APSR 97:1): 1.92 civil-war onsets per 100 country-years 1945-99. Base below is for a reference
  // country (GDP pc $10k 2024 USD, no recent war, autocracy, 25th-percentile infant mortality); calibrated with
  // `npm run stylised` so the simulated world mean lands near 1.9 onsets per 100 country-years.
  CIVIL_WAR_ONSET_ANNUAL: 0.004,
  CIVIL_WAR_OR_PRIOR_WAR: 1.7,                 // F&L: onset odds ~70% higher after a recent war
  CIVIL_WAR_OR_PER_1000USD_1985_LESS: 1.45,    // F&L: $1,000 (1985 USD) lower GDP pc -> ~45% higher annual odds
  USD_1985_TO_2024: 2.9,                       // CPI-U ratio 2024/1985 ≈ 2.9 ($1,000 1985 ≈ $2,900 today)
  CIVIL_WAR_INCOME_REF_USD: 10000,
  CIVIL_WAR_MAX_ANNUAL: 0.20,                  // F&L: even the riskiest country-years rarely exceed ~0.2/yr
  // Goldstone et al. 2010 (AJPS 54:1, PITF): partial democracy with factionalism OR ≈30 vs full autocracy;
  // infant mortality 75th vs 25th percentile OR ≈7; 4+ neighbours in armed conflict sharply raise risk.
  INSTAB_OR_REGIME: { liberal_democracy: 0.3, electoral_democracy: 2, hybrid_regime: 4, authoritarian: 1, absolute_monarchy: 0.7, one_party_state: 0.7, theocracy: 1, military_junta: 1.5, revolutionary_state: 2 } as Record<string, number>,
  INSTAB_OR_FACTIONAL_PARTIAL_DEM: 30,         // applied (instead of the regime OR) to electoral/hybrid regimes with factional unrest (unrest>50)
  INSTAB_OR_INFANT_MORT_P75_VS_P25: 7,
  INSTAB_NEIGHBOURS_IN_CONFLICT_THRESHOLD: 4,
  INSTAB_OR_BAD_NEIGHBOURHOOD: 3,
  OR_UNREST_PER_20: 1.6,                       // engine-endogenous: present unrest above 40 (simplification, not from a study)
  OR_SUPPRESSED_PER_25: 1.3,                   // engine-endogenous: hidden (suppressed) discontent, lagged one month
  SEPARATIST_ONSET_ANNUAL: 0.01,               // per aggrieved minority group with separatism 1.0 (scaled by separatism)
  // Civil wars are sticky: F&L report ~2.3 onsets vs ~1.7-1.85 terminations per year, so conflicts accumulate.
  // Mean duration of civil wars ≈ 7-10 years (F&L median ~6y; UCDP mean higher) -> negotiated end hazard ≈ 1/(12*8)/month.
  CIVIL_WAR_END_MONTHLY: 1 / 96,
  // Powell & Thyne 2011 (JPR 48:2): 457 attempts 1950-2010, 227 succeeded (49.7%). Recent decades: ~3-8 attempts/yr worldwide.
  COUP_ATTEMPT_ANNUAL: 0.006,                  // reference country (authoritarian, Asia, military approval 50, no recent coup)
  COUP_SUCCESS_BASE: 0.497,
  COUP_OR_REGIME: { liberal_democracy: 0.05, electoral_democracy: 0.4, hybrid_regime: 1.5, authoritarian: 1, absolute_monarchy: 0.4, one_party_state: 0.3, theocracy: 0.5, military_junta: 3, revolutionary_state: 1.5 } as Record<string, number>,
  // regional priors chosen so attempts concentrate as in Powell & Thyne (Africa 36.5%, Americas 31.9%, Middle East 15.8%, Asia 13.1%, Europe 2.6%)
  COUP_OR_REGION: { Africa: 3, Americas: 1.5, 'Middle East': 1.8, Asia: 1, Europe: 0.15, Oceania: 0.6 } as Record<string, number>,
  COUP_OR_TRAP_5Y: 4,                          // "coup trap": a coup in the past 5 years
  COUP_OR_MIL_APPROVAL_PER_20_BELOW_50: 2.2,
  COUP_OR_GDP_SHOCK: 2,                        // growth < -2%
  COUP_OR_PROVISIONAL: 2,
  COUP_OR_COUP_PROOFED: 0.4,                   // purge within 6 months
  COUP_SUCCESS_OR_LOW_MIL_LOYALTY: 1.6,        // military approval < 40
  COUP_SUCCESS_OR_ELITE_DEFECTION: 1.3,        // business approval < 30
  COUP_SUCCESS_OR_COUP_PROOFED: 0.5,
  // Chenoweth & Stephan 2011; Chenoweth 2020 (J. of Democracy 31:3): nonviolent campaigns succeeded 53% (1900-2006) but only
  // 34% in 2010-2019; violent campaigns 26%. "3.5% rule" is a rule of thumb (avg peak participation since 2010 ≈ 1.3%).
  PROTEST_SUCCESS_NONVIOLENT: 0.34,
  PROTEST_SUCCESS_VIOLENT: 0.26,
  PROTEST_CAMPAIGN_MONTHS: 6,                  // calibrated (npm run stylised): typical length of a simulated campaign, used to turn campaign success into a monthly hazard
  PROTEST_TYPICAL_SHARE: 0.013,                // Chenoweth: average peak participation since 2010 ≈1.3% (the base rate applies here)
  PROTEST_TIPPING_SHARE: 0.035,
  PROTEST_MAX_PARTICIPATION: 0.05,             // participation share at unrest 100
  PROTEST_OR_AT_TIPPING: 4,                    // odds multiplier per +1 x (participation/tipping - 1)
  PROTEST_OR_DEFECTION: 3,                     // security-force defection (Chenoweth & Belgioioso: momentum + defection predict collapse)
  PROTEST_OR_MOMENTUM: 1.5,                    // unrest rising for 3+ months
};

// ---- Escalation index (Rivera et al., FAccT 2024 style weights) and CAMEO-like decision codes ----
export const ESCALATION_WEIGHTS = { deescalate: -2, posture: 1, nonviolent_coercion: 3, violent: 10, nuclear: 60 };
