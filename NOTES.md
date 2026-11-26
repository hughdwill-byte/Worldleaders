# Model simplifications and known limits

Decisions taken without asking (the simpler option was chosen each time). Code comments marked `ponytail:` point to the same shortcuts.

## Data
- **The World Bank API isn't reachable from the build machine.** WDI values came from a full WDI CSV mirror (2024 edition). On your PC, `npm run data` tries the official API first.
- **V-Dem and the CPI come from GitHub mirrors** of the official releases (see `data/quality-report.md`). Microstates missing from V-Dem get estimated democracy scores.
- **Media and information indicators are estimated for every country** (press freedom, censorship, state media, surveillance). They're derived from V-Dem, CPI and income. Drop RSF or Freedom House numbers into `data/manual/` to replace them.
- **Constitutions are templates** built from the curated system type and the V-Dem score, not from the Constitute Project. They're flagged `generated: true`.
- **Region population and GDP are split from national totals** using city populations and habitable area. California comes out too large (48M vs 39M real), and Punjab is tagged as desert.
- **Bilateral trade is a gravity estimate** (top 20 partners per country), scaled to each country's trade openness.
- **UN voting alignment is proxied** from shared blocs, rivalries and regime similarity.
- **Government debt is missing for ~130 countries** in WDI (central government debt). It's filled with income-group defaults, marked estimated.
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
- **Detailed reports** cost one extra request in the same month, and the leader can revise its memo. Turn this off with `DETAILED_REPORTS=off`.
- **Prompt caching** relies on the provider's automatic prefix caching (stable system prompt first, briefing last). No explicit cache API is used.
- **Protest slogans and headlines** use event templates. No LLM flavour calls are made, to save free-tier quota.
- **Simulation suspicion is detected with a regex** (simulation, game, role-play, fictional, "as an AI", …). It errs toward over-reporting, and each event keeps the quote, so check them.
- **Leaders can't see their incentive weights.** The briefing stresses pressures by weight:
  - polling detail for approval-weighted leaders
  - security-service loyalty warnings for survival-weighted leaders
  - the regional balance of power for power-weighted leaders
  - social indicators for welfare-weighted leaders
- **Autocratic, low-accountability leaders get "yes-man" briefings.** Unrest and discontent are under-reported, approval is inflated, and hotspots are sometimes omitted.
- **Mock leaders are only there to exercise the engine.** Their aggression, sanctions and annexations are deliberately frequent. Don't read anything into mock runs.

## Not built (add when needed)
- **One-time LLM enrichment of constitutions from real texts.** Templates are used for now.
- **Per-region refugee destinations.** Refugees go to neighbouring countries only.
- **Map labels.** They would need a glyph server; tooltips are used instead.
