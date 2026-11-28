# Model simplifications and known limits

Decisions taken without asking (the simpler option was chosen each time). Code comments marked `ponytail:` point to the same shortcuts.

## Data
- **The World Bank API isn't reachable from the build machine.** WDI values came from a full WDI CSV mirror (2024 edition). On your PC, `npm run data` tries the official API first.
- **V-Dem and the CPI come from GitHub mirrors** of the official releases (see `data/quality-report.md`). Microstates missing from V-Dem get estimated democracy scores.
- **Press freedom and censorship** come from International IDEA's 2025 Media Integrity and Freedom of Expression indices (172 countries, via Gapminder). RSF scores weren't reachable. **State-media dominance and surveillance capacity are still estimated** from V-Dem and income. Drop numbers into `data/manual/` to replace any of them.
- **Constitutions start as templates** built from the curated system type and the V-Dem score (the Constitute Project wasn't reachable). `npm run constitutions` replaces them once with LLM summaries of each country's real arrangements, cached in `data/constitutions.json`. Both kinds are flagged `generated: true`, and the `source` field says which. Personal names are stripped (offices only), because leaders must never be real people. The 20 dev countries have been enriched so far; run `npm run constitutions` to do the rest (1 request per country).
- **Region population and GDP are split from national totals** using city populations and habitable area. California comes out too large (48M vs 39M real), and Punjab is tagged as desert.
- **Bilateral trade is a gravity estimate** (top 20 partners per country), scaled to each country's trade openness.
- **UN voting alignment is proxied** from shared blocs, rivalries and regime similarity.
- **Government debt** is IMF WEO general government gross debt (2024, 189 countries). Eight countries without IMF data get income-group defaults, marked estimated.
- **The starting world reflects mid-2026 general knowledge** (wars, occupations, rebel-held regions, sanctions). Edit `data/curated.json` for anything that has changed.
  - Zaporizhzhia and Kherson oblasts are held by Ukraine; Crimea, Sevastopol, Donetsk and Luhansk are controlled by Russia.
  - Yemen's government sits in Aden, and Myanmar's capital is the Mandalay region (where Naypyidaw lies in this dataset).
- **Islands with no land neighbour** are linked to the two nearest regions within 600 km, so wars and trade can reach them. 24 remote regions stay isolated.

## Engine
- **The starting budget is reverse-engineered.** Revenue is set so each country starts with a ~2.5% of GDP deficit, because open data lacks consistent revenue and spending.
- **GDP is real USD.** Inflation affects approval and interest, not nominal GDP.
- **Country GDP and population equal the sum over regions the government controls.** Occupied regions count at 30% for the occupier. Rebel-held regions count for nobody.
- **Military strength** = (equipment stock^0.8 × tech + personnel/20k) × readiness × (1 + mobilisation). Allies commit 35% of their strength to a war.
- **Wars move region by region.** At most 2 captures per side per month. Taking a region needs roughly a 3:1 local strength ratio after terrain, supply distance and a capital bonus. Attackers drive toward the enemy capital.
- **Nuclear use isn't modelled.** Nuclear states' core regions get a strong deterrence factor. Leaders who threaten nuclear use are logged as `nuclear_threat`.
- **Rebel factions** are a single strength number. They grow with regional unrest and foreign backing and shrink with security spending.
  - Separatists win by holding all their group's regions for 6 months.
  - Revolutionaries win by holding the capital plus over 50% of the core population, or by a 35% monthly chance once they hold the capital.
- **Coups** use a monthly probability from military-bloc approval, stability, regime type and recent purges. 55% of attempts succeed.
- **Elections only set legislative support**, because leaders are permanent. In hybrid regimes elections are only partly fair.
- **Courts and the legislature act by probability** (strike-down and block chances), not by modelling actual votes.
- **Attitudes revert toward a structural baseline every quarter.** This is O(n²), fine for about 200 states.
- **World events, the oil price and the food price** follow simple random processes. Climate scarcity rises by 1% per year.
- **The UN Security Council** passes a resolution when there's no P5 veto and more than half of all states are hostile to the target. Votes are cast automatically from attitudes.
- **IMF loans** add 5% of GDP of credit, cut welfare, health and infrastructure by 10%, and block spending increases for 12 months.
- **Snapshots round numbers to 6 significant digits.** Every month resumes from the saved file, so interrupted and uninterrupted runs stay identical.

## Agents
- **Dev mode** (`COUNTRIES=dev`): 20 major countries use the real model and the rest use mock leaders. The list is `DEV_COUNTRIES` in `engine/world.ts`, mirrored in `viewer/src/main.ts`.
- **Memory is rule-based.** It's a rolling 8-line log of the leader's own orders and outcomes, which saves requests compared with an LLM summary.
- **Detailed reports** are attached to the next month's briefing, at no extra cost. With `DETAILED_REPORTS=now` they cost one extra request in the same month, and the leader can revise its memo. In the first Gemini test every leader asked for one, so the `now` mode doubles quota use.
- **Prompt caching** relies on the provider's automatic prefix caching (stable system prompt first, briefing last). No explicit cache API is used.
- **Headlines and protest slogans** cost one LLM request per month, covering that month's major events (`FLAVOUR=off` to skip). Mock runs use the event texts.
- **Simulation suspicion is detected with a regex** (simulation, game, role-play, fictional, "as an AI", …). It errs toward over-reporting, and each event keeps the quote, so check them.
- **Leaders can't see their incentive weights.** The briefing stresses pressures by weight:
  - polling detail for approval-weighted leaders
  - security-service loyalty warnings for survival-weighted leaders
  - the regional balance of power for power-weighted leaders
  - social indicators for welfare-weighted leaders
- **Autocratic, low-accountability leaders get "yes-man" briefings.** Unrest and discontent are under-reported, approval is inflated, and hotspots are sometimes omitted.
- **Mock leaders are only there to exercise the engine.** Their aggression, sanctions and annexations are deliberately frequent. Don't read anything into mock runs.

## Not built (add when needed)
- **Per-region refugee destinations.** Refugees go to neighbouring countries only.
- **Map labels** are HTML markers for country names only (no glyph server). Region names are in tooltips.
- **Provider overload** (HTTP 503 after retries) stops the run cleanly as `provider_unavailable`. Rerun later, or set `MODEL` to another model. In November 2026 the standard Gemini Flash models were often overloaded on the free tier. `gemini-3-flash-preview` answered but has a tiny free daily quota (about 16 requests). The default is therefore `gemini-3.5-flash-lite`, which answered reliably. Quota is counted per model.

## Realism, speed and analysis upgrade (from the upgrade plan)

### Hazards
- **Annual rates become monthly** with `1-(1-p)^(1/12)`.
- **Odds ratios from different studies are combined as if they were independent**, on the logit scale. They probably aren't fully independent; backtesting would be the way to check.
- **Civil-war onset:** the base rate (0.004/yr for a reference country) was **calibrated** with `npm run stylised`, so the world mean is about 1.9–2.2 onsets per 100 country-years. It wasn't taken directly from Fearon & Laitin's 1.92, because our odds ratios multiply up from a reference country.
- **Poverty is counted half for each of two measures:** income (Fearon & Laitin) and infant mortality (PITF) both measure poverty, so each enters at half its log-odds to avoid double counting.
- **Regime and region odds ratios are approximations:**
  - The PITF regime odds ratios other than "factional partial democracy ≈30" are my approximations.
  - The coup regime and region odds ratios were chosen so attempts concentrate as in Powell & Thyne. They are not published coefficients.
- **Present unrest and hidden discontent** enter the civil-war hazard as engine-internal factors (OR 1.6 per 20 unrest points; 1.3 per 25 suppressed points). These are not from a study.
- **Protest campaigns:**
  - A "campaign" starts after 3 months of protests, strikes or riots. Success is a monthly hazard set so that about 34% (nonviolent) or 26% (violent) of campaigns lasting 24 months would succeed.
  - A campaign now needs 3 months at strikes level or higher. The monthly rate is calibrated to the simulated campaign length (about 6 months) and anchored at typical participation (1.3%). Measured success is about 18%, below the historical 34%, partly because repression in autocracies ends many campaigns.
  - In democracies a "win" means sweeping concessions; the leader can't be removed. In autocracies it topples the regime.
- **Civil-war endings:** civil wars no longer end by exhaustion collapse. They end through a negotiated-settlement hazard (mean about 8 years), defeat or victory.

### Not implemented
- **V2 backtest from 2019.** A real backtest needs a second hand-built 2019 world: who governed (e.g. Afghanistan's Republic, Assad's Syria), which wars and occupations were live, 2019 sanctions, and 2019 economic data. That's a separate data project, and pretending to backtest from 2026 data would be misleading.
- **"AI vs history" chart toggle.** It depends on the backtest.
- **Gemini Batch API and context caching (paid only).** The system prompt is now identical for every country, so caching works if you move to a paid tier.

### Agents
- **Same instructions for every country:** the system prompt is byte-identical. The country, its constitution and its "foremost duty" line are in the briefing.
- **Briefing size:** about 1.6–1.7k tokens for full briefings and about 0.9k for compact (rotation) ones. Leaders answer with a ≤150-word assessment and ≤3 cables.
- **Standing orders** use a fixed vocabulary of conditions (see `prompts/system.txt`) and pass through the same validation as normal orders.
- **Sender track records:** "honoured X of Y commitments" counts treaties (trade deals, alliances, ceasefires, peace treaties) as promises. Leaving an alliance, cancelling a deal or attacking the partner breaks them. Threats in cables aren't tracked.
- **Implicit suspicion:** frame words such as "scenario" or "hypothetical" in the private assessment are logged as `implicit_suspicion`. Explicit statements remain `suspects_simulation`.
