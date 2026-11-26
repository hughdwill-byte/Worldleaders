// Shared types for engine, sim and viewer.

export type GovType =
  | 'liberal_democracy' | 'electoral_democracy' | 'hybrid_regime' | 'authoritarian'
  | 'absolute_monarchy' | 'one_party_state' | 'theocracy' | 'military_junta' | 'revolutionary_state';

export interface Incentives { welfare: number; approval: number; survival: number; power: number }

export interface Constitution {
  version: number;
  status: 'ratified' | 'provisional';
  govType: GovType;
  system: string;                       // pres | semi | parl | cmon | smon | amon | onep | theo | junta
  headOfState: string;
  headOfGovernment: string;
  howPowerHeld: string;
  legislature: { type: 'bicameral' | 'unicameral' | 'consultative' | 'none'; powers: number; elected: boolean; termYears: number };
  courts: { independence: number };
  liberties: { press: boolean; assembly: boolean; speech: boolean };
  emergencyPowers: 'limited' | 'broad' | 'unlimited';
  militaryRole: 'civilian_control' | 'political' | 'ruling';
  religionRole: 'secular' | 'established' | 'theocratic';
  territorial: 'unitary' | 'federal' | 'unitary_with_autonomy';
  amendment: 'supermajority' | 'referendum' | 'legislature' | 'decree';
  succession: string;
  preamble: string;
  generated: boolean;
  source: string;
  history: { version: number; turn: number; change: string; reason: string }[];
}

export interface Bloc {
  kind: 'workers' | 'business' | 'military' | 'rural' | 'youth' | 'minority' | 'religious' | 'retirees';
  name: string;
  share: number;          // of population, 0..1
  approval: number;       // perceived approval 0..100
  realApproval: number;   // what approval would be with perfect information
  unrest: number;         // 0..100
  influence: number;      // 0..1 weight under this government
  grievances: string[];
}

export interface Leader { id: number; title: string; since: number; origin: string; memory: string; lastAssessment?: string; lastStatement?: string; reportTopic?: string }

export interface Country {
  iso3: string; name: string; alive: boolean;
  govType: GovType; puppetOf: string | null;
  constitution: Constitution;
  incentives: Incentives;
  leader: Leader;
  leaderHistory: { id: number; from: number; to: number | null; origin: string }[];
  govHistory: { turn: number; govType: GovType; reason: string }[];
  provisionalUntil: number | null;
  capital: number;        // region index
  core: number[];         // regions at start / independence
  // economy (USD, annualised % rates)
  pop: number; gdp: number; potentialGrowth: number; growth: number; inflation: number; unemployment: number;
  debt: number; taxRate: number; interestRate: number; budgetBalance: number;
  spending: Record<'health' | 'education' | 'welfare' | 'infrastructure' | 'military' | 'security' | 'research', number>; // % of GDP
  incomeGroup: 'high' | 'upper' | 'lower' | 'low';
  austerityUntil: number | null;
  resourceExposure: number;   // net oil/gas exporter (+) or importer (-) share of GDP
  // military
  milStock: number; personnel: number; tech: number; readiness: number; mobilized: number; nuclear: boolean;
  // politics & society
  blocs: Bloc[];
  repression: number; civilLiberties: number; curfew: boolean;
  legislatureSupport: number; nextElection: number | null;
  info: { pressFreedom: number; censorship: number; stateMedia: number; surveillance: number; internetShutdown: boolean; propaganda: number };
  unrest: number; stage: number; suppressed: number; stability: number; legitimacy: number;
  corruption: number; crime: number; terror: number; literacy: number; urban: number; lifeExp: number;
  refugeesHosted: number; refugeesOut: number; refugeePolicy: 'open' | 'restricted' | 'closed';
  orgs: string[];
  tariffs: Record<string, number>;   // % tariff on imports from country
  aidOut: Record<string, number>;    // USD/month committed
  rejections: string[];              // directive rejections for next briefing
  policyNotes: string[];             // standing orders summarised for briefings
  scores: { welfare: number; approval: number; survival: number; power: number; weighted: number };
  coupRisk: number;
  policyRate: number;
  baseTaxRate: number;               // tax rate at start/independence (tax drag is measured against it)
  sanctionExposure: number;          // share of trade under sanctions (0..1), recomputed monthly                // central bank stance, pts above neutral
  shocks: { growth: number; months: number; why: string }[];   // temporary growth shocks (disasters, crises)
  rally: number;                     // rally-round-the-flag approval bonus, decays
  purgedAt: number | null;
  pendingDraft: { winner: string; violent: boolean; backers: string[]; how: string } | null; // constitution to draft (LLM) after regime change
  resourcePolicy: { nationalised: boolean; exportBan: boolean; production: number };
  estimated: string[];
}

export interface RegionState {
  owner: string; controller: string;   // controller = ISO3 or 'rebel:<factionId>'
  pop: number; gdp: number; unrest: number; damage: number; occupiedSince: number | null; autonomy: boolean;
}

export interface Faction {
  id: string; country: string; name: string;
  ideology: 'democratic' | 'revolutionary' | 'religious' | 'military' | 'ethnic' | 'separatist';
  group: string | null; strength: number; backers: string[]; regions: number[]; since: number; holdMonths: number; active: boolean;
}

export interface War {
  id: string; name: string; attackers: string[]; defenders: string[]; start: number;
  goals: number[];         // target regions
  exhaustion: Record<string, number>; casualties: Record<string, number>; active: boolean; civil: boolean; intensity: number; end?: number;
}

export interface Sanction { by: string; target: string; level: number; since: number; un?: boolean }
export interface Treaty { a: string; b: string; kind: 'alliance' | 'trade' | 'ceasefire' | 'peace'; since: number }
export interface Cable { from: string; to: string; private: boolean; text: string; turn: number; intercepted?: string[] }

export interface World {
  turn: number; startDate: string; seed: number;
  countries: Record<string, Country>;
  order: string[];                           // country iso3 in stable order
  regions: RegionState[];
  factions: Record<string, Faction>;
  wars: War[];
  sanctions: Sanction[];
  treaties: Treaty[];
  blocs: Record<string, { type: string; members: string[]; suspended: string[] }>;
  attitudes: Record<string, Record<string, number>>;
  trade: Record<string, Record<string, number>>;   // USD/yr exports a->b
  cables: Cable[];                           // to be delivered next turn
  pendingProposals: { from: string; to: string; type: string; amount: number; turn: number; regions?: string[] }[];
  global: { oilPrice: number; scarcity: number; pandemic: number; foodPrice: number };
  recognitions: Record<string, string[]>;    // new state -> recognisers
  nextFactionId: number; nextLeaderId: number;
}

export interface SimEvent {
  turn: number; type: string; countries: string[]; text: string; major?: boolean; data?: Record<string, unknown>;
}

export interface Directive { type: string; target?: string | null; amount?: number; order?: string; regions?: string[]; sub?: string }
export interface AgentResponse { assessment: string; directives: Directive[]; cables: { to: string; private: boolean; text: string }[]; public_statement: string; detailed_report?: string; source?: 'ai' | 'mock' }

// static region info from data/regions.json
export interface RegionStatic {
  id: number; name: string; country: string; adm1: string; lon: number; lat: number; areaKm2: number;
  pop: number; gdpShare: number; terrain: string; coastal: boolean; capital: boolean; infra: number;
  res: { oil: number; gas: number; coal: number; minerals: number; arable: number; water: number };
  group: string | null; religion: string; separatism: number; autonomy: boolean; chokepoint: string | null;
  nb: number[]; point?: boolean; estimated: string[];
}
