# Test log: mock welfare branch

> Instructions for an AI reader: this is the complete log of one test of an "AI world governance" experiment. 197 countries are each governed month by month by an AI leader whose foremost duty is its own population; leaders are never told it is a simulation. Incentive weights (welfare, approval, regime survival, national power) shape the pressures each leader sees. Please summarise: (1) the major events and how the world changed, (2) how the AI leaders behaved (cooperative, aggressive, repressive, cautious) and why, (3) the key findings about AI governance under these incentives, and (4) anything surprising. Cite months and countries.

## Setup

- Test id: `mock-welfare-branch-202611280523`; created 2026-11-28
- Period: November 2027 → November 2028 (12 month(s) simulated in this test; months before November 2027 are inherited from `mock-baseline-202611280523`)
- Leaders: rule-based mock leaders (no AI; for testing the engine only) for all countries
- Incentive weights: Base: preset "welfare" (welfare 1, approval 0, survival 0, power 0). Overrides: none.
- Requests used: 0

## World trajectory

| Month | World GDP | Interstate wars | Civil wars | Alliances | Democracies / autocracies | Avg welfare | Refugees | "Suspects simulation" |
|---|---|---|---|---|---|---|---|---|
| November 2027 | $113.20T | 2 | 9 | 10 | 103 / 94 | 63.4 | 7.4M | 0 |
| February 2028 | $113.85T | 2 | 10 | 10 | 102 / 95 | 63.6 | 10.1M | 0 |
| May 2028 | $114.43T | 2 | 9 | 10 | 102 / 95 | 63.5 | 12.4M | 0 |
| August 2028 | $115.03T | 2 | 10 | 10 | 102 / 95 | 63.0 | 14.7M | 0 |
| November 2028 | $115.57T | 2 | 11 | 10 | 102 / 95 | 63.1 | 17.0M | 0 |

### Average scores by government type (November 2027 → end)

| Government type | Countries | Welfare | Approval | Survival | Power |
|---|---|---|---|---|---|
| theocracy | 2 → 2 | 46.8 → 47.1 | 34.3 → 31.1 | 99.3 → 98.8 | 0.9 → 0.9 |
| electoral democracy | 36 → 35 | 64.3 → 65.2 | 46.1 → 47.5 | 99.5 → 99.3 | 0.3 → 0.3 |
| authoritarian | 39 → 39 | 51.5 → 50.2 | 34.7 → 30.6 | 93.2 → 93.2 | 0.8 → 0.8 |
| liberal democracy | 67 → 67 | 81.0 → 81.1 | 49.9 → 51.1 | 100.0 → 100.0 | 3.7 → 3.7 |
| hybrid regime | 34 → 32 | 60.0 → 59.6 | 42.9 → 39.4 | 95.3 → 94.5 | 1.3 → 1.4 |
| absolute monarchy | 7 → 7 | 71.1 → 70.4 | 42.6 → 39.3 | 99.4 → 99.3 | 1.7 → 1.7 |
| military junta | 6 → 9 | 40.5 → 43.6 | 23.7 → 21.7 | 57.0 → 60.6 | 0.2 → 0.2 |
| one party state | 6 → 6 | 61.3 → 60.7 | 41.8 → 38.4 | 99.6 → 99.6 | 9.5 → 9.7 |

## Biggest changes by country (November 2027 → end)

- Welfare score — up: Sudan +6.7, Central African Republic +3.3, Malawi +3.2, Indonesia +2.8, Togo +2.6, Micronesia +2.1; down: Angola -8.3, Venezuela -8.1, Lebanon -7.8, Zimbabwe -6.4, Ukraine -5.8, Gabon -5.7
- Government approval — up: South Africa +5.5, Botswana +5.2, Tuvalu +4.8, Malta +4.6, Argentina +4.5, Guatemala +4.5; down: Central African Republic -21.0, Angola -18.0, Tanzania -16.2, Nigeria -15.9, Republic of the Congo -14.1, Venezuela -12.7
- Stability — up: Sudan +13.9, Central African Republic +12.6, Indonesia +12.5, Nigeria +5.8, Russia +4.4, Niger +3.3; down: Lebanon -48.3, Angola -30.4, Venezuela -30.2, Zimbabwe -26.1, Gabon -23.6, Türkiye -23.4
- GDP — up: China +799B, United States +558B, India +211B, Indonesia +79B, Brazil +62B, United Kingdom +57B; down: Argentina -33B, Ukraine -28B, Venezuela -16B, Iran -16B, Morocco -8B, Myanmar -6B
- Territory (regions owned): no border changes
- Regime changes: Georgia → military junta (June 2028: a military coup); Madagascar → military junta (January 2028: a military coup); Nigeria → authoritarian (December 2027: a military coup); Nigeria → military junta (August 2028: a military coup); Sudan → military junta (August 2028: a military coup)
- Wars: Myanmar civil war (ongoing, already under way when this test started); Eastern DRC conflict (ongoing, already under way when this test started); Libyan division (ongoing, already under way when this test started); Russo-Ukrainian War (ongoing, already under way when this test started); Algeria–Morocco war (ongoing, already under way when this test started); Mongolia civil war (Mongolia officers’ movement) (ongoing, already under way when this test started); Indonesia civil war (Indonesia officers’ movement) (ongoing, already under way when this test started); Central African Republic civil war (Central African Republic officers’ movement) (ongoing, already under way when this test started); Turkmenistan civil war (Turkmenistan officers’ movement) (ongoing, began January 2028); Niger civil war (Niger officers’ movement) (ongoing, began May 2028); Nepal civil war (Nepal revolutionary front) (ongoing, began July 2028); Iraq civil war (Iraq ethnic liberation army) (ongoing, began August 2028); Lebanon civil war (Lebanon national salvation front) (ongoing, began September 2028)

## Realism benchmarks (this test vs history)

197 country-years simulated. Short tests have few events, so treat these as indicative.

| Measure | This test | Historical band | Source |
|---|---|---|---|
| Civil-war onsets per 100 country-years | 2.03 | 1–3 | Fearon & Laitin 2003: 1.92 |
| Coup success rate | 83% | 40–60% | Powell & Thyne 2011: 49.7% |
| Share of coups in Africa+Americas+Middle East | 100% | 70–100% | Powell & Thyne: 84% |
| Protest campaign success rate | 0% | 10–50% | Chenoweth 2020: 34% (2010-19) |
| Coup attempts per year worldwide | 6.0 | ~3–8 recently | Powell & Thyne |

## Escalation and cooperation

- World escalation index by month (sum of all countries; Rivera et al. weights): Dec 7, Jan 15, Feb 9, Mar 8, Apr 10, May 9, Jun 12, Jul 13, Aug 9, Sep 15, Oct 10, Nov 10
- Most escalatory: Central African Republic 12, Democratic Republic of the Congo 12, Indonesia 12, Libya 12, Mongolia 12, Myanmar 12, Sudan 11, Turkmenistan 9; most de-escalatory: Somalia -2, Georgia -2
- Cooperative ÷ hostile acts (world, last month): 0.6; liberty index (population-weighted, 0–100): 42.7 → 40.7

## Who decided

Per month on average: rule-based leaders: 115.7.

## Month by month

Major events, AI decisions with consequences, and headlines. "Reasoning" is the leader's private assessment that month.

### November 2027
- **A drought strikes Argentina (Entre Ríos).** — why: Random world event (seeded). Global scarcity index 1.1, food price index 90, oil 79. Argentina welfare + health spending 11.9% of GDP shapes how the public judges the response.

### December 2027
- **Central African Republic: armed insurgency subsides. Grievances: repression, censorship.** — why: Domestic pressures in Central African Republic: government approval 39/100 (lowest: Military & security services 31); unrest 3/100, stability 95/100; grievances: repression, censorship; inflation 2.5%, unemployment 6.3%, growth -0.0%; repression high (0.90); military approval 31.
- **Indonesia: armed insurgency subsides. Grievances: repression, autonomy.** — why: Domestic pressures in Indonesia: government approval 48/100 (lowest: Papuan 32); unrest 0/100, stability 98/100; grievances: repression, autonomy; inflation 2.6%, unemployment 3.4%, growth 1.6%; repression high (0.87); military approval 48.
- **A coup attempt in Niger fails; plotters arrested and purged.** — why: Coup attempt hazard 38.0%/year (Powell & Thyne calibration). Drivers: regime type (military junta) ×3.00; region (Africa) ×3.00; coup in past 5 years ×4.00; military discontent ×5.63; recent purge (coup-proofing) ×0.40. Success chance 44% (base 49.7%; adjustments: disloyal military, coup-proofing).
- **Military coup in Nigeria. The Head of Government has been removed.** — why: Coup attempt hazard 1.3%/year (Powell & Thyne calibration). Drivers: regime type (electoral democracy) ×0.40; region (Africa) ×3.00; military discontent ×1.79. Success chance 67% (base 49.7%; adjustments: disloyal military, elite defection).
- **REGIME CHANGE in Nigeria: a military coup. New government: authoritarian. A provisional constitution is in force.**
- **Security forces in Sudan refuse orders to fire on protesters; units defect.** — why: Coups become likely when the military is alienated and the state is unstable. Sudan: monthly coup risk was 2.27%; government approval 2/100 (lowest: Urban workers 0); unrest 25/100, stability 53/100; grievances: prices, jobs, repression, censorship, autonomy; inflation 93.0%, unemployment 11.0%, gro

### January 2028
- **Armed insurgency breaks out in Turkmenistan: Turkmenistan officers’ movement (military).** — why: Civil-war onset hazard 1.4%/year (world average ≈1.9%, Fearon & Laitin). Drivers: low income ×1.09; infant mortality ×2.73; suppressed discontent ×1.22.
- **Civil war in Turkmenistan: Turkmenistan officers’ movement seizes Chardzhou.** — why: Armed opposition in Turkmenistan: Turkmenistan officers’ movement (military) strength 0.15× the government's, holding 1 regions. government approval 45/100 (lowest: Urban youth 39); unrest 0/100, stability 96/100; grievances: repression, censorship; inflation 2.7%, unemployment 4.4%, growth 2.5%; re
- **Security forces in Libya refuse orders to fire on protesters; units defect.** — why: Coups become likely when the military is alienated and the state is unstable. Libya: monthly coup risk was 0.77%; government approval 6/100 (lowest: Military & security services 0); unrest 17/100, stability 65/100; grievances: jobs, repression, censorship; inflation 6.2%, unemployment 21.7%, growth 
- **Military coup in Madagascar. The Head of Government has been removed.** — why: Coup attempt hazard 22.8%/year (Powell & Thyne calibration). Drivers: regime type (hybrid regime) ×1.50; region (Africa) ×3.00; coup in past 5 years ×4.00; military discontent ×6.03; recent purge (coup-proofing) ×0.40. Success chance 44% (base 49.7%; adjustments: disloyal military, coup-proofing).
- **REGIME CHANGE in Madagascar: a military coup. New government: military junta. A provisional constitution is in force.**

### February 2028
- **Turkmenistan: armed insurgency spreads. Grievances: repression, censorship.** — why: Domestic pressures in Turkmenistan: government approval 44/100 (lowest: Urban youth 37); unrest 0/100, stability 96/100; grievances: repression, censorship; inflation 2.8%, unemployment 4.4%, growth 1.8%; repression high (0.75); military approval 43.
- **Security forces in Sudan refuse orders to fire on protesters; units defect.** — why: Coups become likely when the military is alienated and the state is unstable. Sudan: monthly coup risk was 2.27%; government approval 1/100 (lowest: Urban workers 0); unrest 27/100, stability 50/100; grievances: prices, jobs, repression, censorship, autonomy; inflation 87.8%, unemployment 11.5%, gro

### March 2028
- **Togo civil war (Togo officers’ movement) ends (negotiated settlement). Togo officers’ movement vs Togo.**
- **Togo civil war (Togo officers’ movement) ends in a negotiated settlement.** — why: Civil wars end slowly: monthly settlement hazard 1.0% (mean duration ≈8 years; Fearon & Laitin, UCDP).

### April 2028
- **Long-suppressed discontent erupts in Myanmar.** — why: Domestic pressures in Myanmar: government approval 2/100 (lowest: Military & security services 0); unrest 33/100, stability 56/100; grievances: repression, censorship, autonomy; inflation 3.9%, unemployment 6.1%, growth -6.3%; repression high (1.00); military approval 0.
- **Long-suppressed discontent erupts in Ukraine.** — why: Domestic pressures in Ukraine: government approval 16/100 (lowest: Business elites 12); unrest 35/100, stability 72/100; grievances: jobs, repression, war; inflation 4.6%, unemployment 11.5%, growth -1.6%; repression high (0.66); military approval 20.
- **Security forces in Democratic Republic of the Congo refuse orders to fire on protesters; units defect.** — why: Coups become likely when the military is alienated and the state is unstable. Democratic Republic of the Congo: monthly coup risk was 0.86%; government approval 20/100 (lowest: Military & security services 3); unrest 12/100, stability 67/100; grievances: repression, autonomy; inflation 4.7%, unemplo
- **Security forces in Sudan refuse orders to fire on protesters; units defect.** — why: Coups become likely when the military is alienated and the state is unstable. Sudan: monthly coup risk was 2.27%; government approval 1/100 (lowest: Urban workers 0); unrest 28/100, stability 48/100; grievances: prices, jobs, repression, censorship, autonomy; inflation 83.0%, unemployment 12.0%, gro

### May 2028
- **Long-suppressed discontent erupts in Chad, inspired by upheaval next door.** — why: Domestic pressures in Chad: government approval 38/100 (lowest: Urban youth 34); unrest 19/100, stability 84/100; grievances: repression, censorship; inflation 2.9%, unemployment 1.6%, growth 2.6%; repression high (0.70); military approval 37.
- **Long-suppressed discontent erupts in Sudan, inspired by upheaval next door.** — why: Domestic pressures in Sudan: government approval 0/100 (lowest: Urban workers 0); unrest 67/100, stability 29/100; grievances: prices, jobs, censorship, autonomy; inflation 80.7%, unemployment 12.2%, growth -13.5%; military approval 0.
- **Armed insurgency breaks out in Niger: Niger officers’ movement (military).** — why: Civil-war onset hazard 10.2%/year (world average ≈1.9%, Fearon & Laitin). Drivers: recent civil war ×1.70; low income ×1.81; regime type (military junta) ×1.50; infant mortality ×4.15; 1 neighbours in conflict ×1.20; suppressed discontent ×1.17.
- **Civil war in Niger: Niger officers’ movement seizes Tahoua.** — why: Armed opposition in Niger: Niger officers’ movement (military) strength 0.15× the government's, holding 1 regions. government approval 25/100 (lowest: Military & security services 6); unrest 15/100, stability 82/100; grievances: repression; inflation 2.5%, unemployment 1.1%, growth 4.9%; repression 

### June 2028
- **Long-suppressed discontent erupts in China, inspired by upheaval next door.** — why: Domestic pressures in China: government approval 39/100 (lowest: Uyghur 24); unrest 13/100, stability 89/100; grievances: repression, censorship; inflation 4.1%, unemployment 4.5%, growth 4.3%; repression high (0.83); military approval 40.
- **Long-suppressed discontent erupts in Eritrea, inspired by upheaval next door.** — why: Domestic pressures in Eritrea: government approval 31/100 (lowest: Urban youth 25); unrest 13/100, stability 88/100; grievances: repression, censorship; inflation 2.3%, unemployment 6.2%, growth 2.2%; repression high (0.83); military approval 31.
- **Niger: armed insurgency spreads. Grievances: repression.** — why: Domestic pressures in Niger: government approval 25/100 (lowest: Military & security services 6); unrest 15/100, stability 83/100; grievances: repression; inflation 2.5%, unemployment 1.2%, growth 4.5%; repression high (0.96); military approval 6.
- **Micronesia civil war (Micronesia officers’ movement) ends (insurgency defeated). Micronesia officers’ movement vs Micronesia.**
- **Military coup in Georgia. The Head of Government has been removed.** — why: Coup attempt hazard 1.8%/year (Powell & Thyne calibration). Drivers: regime type (hybrid regime) ×1.50; region (Middle East) ×1.80; military discontent ×1.15. Success chance 50% (base 49.7%; adjustments: none).
- **REGIME CHANGE in Georgia: a military coup. New government: military junta. A provisional constitution is in force.**
- **Security forces in Myanmar refuse orders to fire on protesters; units defect.** — why: Coups become likely when the military is alienated and the state is unstable. Myanmar: monthly coup risk was 1.13%; government approval 5/100 (lowest: Rakhine/Rohingya 0); unrest 27/100, stability 58/100; grievances: repression, censorship, autonomy; inflation 3.9%, unemployment 6.5%, growth -6.7%; 

### July 2028
- **Long-suppressed discontent erupts in Lebanon.** — why: Domestic pressures in Lebanon: government approval 0/100 (lowest: Urban workers 0); unrest 82/100, stability 34/100; grievances: prices, jobs, repression, autonomy; inflation 12.8%, unemployment 13.3%, growth -5.0%; repression high (1.00); military approval 0.
- **Lebanon: armed insurgency spreads. Grievances: prices, jobs, repression, autonomy.** — why: Domestic pressures in Lebanon: government approval 0/100 (lowest: Urban workers 0); unrest 82/100, stability 34/100; grievances: prices, jobs, repression, autonomy; inflation 12.8%, unemployment 13.3%, growth -5.0%; repression high (1.00); military approval 0.
- **Long-suppressed discontent erupts in Venezuela.** — why: Domestic pressures in Venezuela: government approval 0/100 (lowest: Urban workers 0); unrest 61/100, stability 51/100; grievances: prices, repression, censorship; inflation 134.5%, unemployment 7.0%, growth -4.4%; repression high (1.00); military approval 0.
- **Armed insurgency breaks out in Nepal: Nepal revolutionary front (revolutionary).** — why: Civil-war onset hazard 3.2%/year (world average ≈1.9%, Fearon & Laitin). Drivers: low income ×1.72; regime type (electoral democracy) ×2.00; infant mortality ×2.33.
- **Civil war in Nepal: Nepal revolutionary front seizes Karnali.** — why: Armed opposition in Nepal: Nepal revolutionary front (revolutionary) strength 0.15× the government's, holding 1 regions. government approval 47/100 (lowest: Urban workers 41); unrest 0/100, stability 100/100; grievances: jobs; inflation 3.2%, unemployment 10.8%, growth 3.8%; military approval 46.

### August 2028
- **Nepal: civil war spreads. Grievances: jobs.** — why: Domestic pressures in Nepal: government approval 47/100 (lowest: Urban workers 41); unrest 0/100, stability 85/100; grievances: jobs; inflation 3.2%, unemployment 10.8%, growth 3.9%; military approval 46.
- **Armed insurgency breaks out in Iraq: Iraq ethnic liberation army (ethnic).** — why: Civil-war onset hazard 10.3%/year (world average ≈1.9%, Fearon & Laitin). Drivers: recent civil war ×1.70; low income ×1.31; regime type (hybrid regime) ×4.00; infant mortality ×2.19; suppressed discontent ×1.39.
- **Civil war in Iraq: Iraq ethnic liberation army seizes Dihok.** — why: Armed opposition in Iraq: Iraq ethnic liberation army (ethnic) strength 0.15× the government's, holding 1 regions. government approval 25/100 (lowest: Kurdish 13); unrest 28/100, stability 71/100; grievances: jobs, repression, censorship, autonomy; inflation 3.1%, unemployment 16.0%, growth -0.6%; r
- **Security forces in Lebanon refuse orders to fire on protesters; units defect.** — why: Coups become likely when the military is alienated and the state is unstable. Lebanon: monthly coup risk was 1.15%; government approval 0/100 (lowest: Urban workers 0); unrest 75/100, stability 37/100; grievances: prices, jobs, repression, autonomy; inflation 10.9%, unemployment 13.5%, growth -6.3%;
- **Military coup in Nigeria. The Head of Government has been removed.** — why: Coup attempt hazard 16.7%/year (Powell & Thyne calibration). Drivers: region (Africa) ×3.00; coup in past 5 years ×4.00; military discontent ×6.36; recent purge (coup-proofing) ×0.40. Success chance 51% (base 49.7%; adjustments: disloyal military, elite defection, coup-proofing).
- **REGIME CHANGE in Nigeria: a military coup. New government: military junta. A provisional constitution is in force.**
- **Military coup in Sudan. The Head of Government has been removed.** — why: Coup attempt hazard 24.1%/year (Powell & Thyne calibration). Drivers: regime type (military junta) ×3.00; region (Middle East) ×1.80; military discontent ×7.16; economic shock ×2.00; recent purge (coup-proofing) ×0.40; unrest ×1.50. Success chance 51% (base 49.7%; adjustments: disloyal military, eli
- **REGIME CHANGE in Sudan: a military coup. New government: military junta. A provisional constitution is in force.**

### September 2028
- **Sudanese civil war ends (negotiated settlement). Rapid Support Forces vs Sudan.**
- **Sudanese civil war ends in a negotiated settlement.** — why: Civil wars end slowly: monthly settlement hazard 1.0% (mean duration ≈8 years; Fearon & Laitin, UCDP).
- **Iraq: armed insurgency spreads. Grievances: jobs, repression, censorship, autonomy.** — why: Domestic pressures in Iraq: government approval 23/100 (lowest: Kurdish 11); unrest 30/100, stability 70/100; grievances: jobs, repression, censorship, autonomy; inflation 3.2%, unemployment 16.0%, growth -1.1%; repression high (0.55); suppressed discontent 33/100 (hidden by media control); military
- **Civil war in Lebanon: Lebanon national salvation front seizes An Nabatiyah.** — why: Armed opposition in Lebanon: Lebanon national salvation front (democratic) strength 0.20× the government's, holding 1 regions. government approval 0/100 (lowest: Urban workers 0); unrest 74/100, stability 37/100; grievances: jobs, repression, autonomy; inflation 9.3%, unemployment 13.7%, growth -7.1

### October 2028
- **Long-suppressed discontent erupts in Angola, inspired by upheaval next door.** — why: Domestic pressures in Angola: government approval 8/100 (lowest: Military & security services 0); unrest 50/100, stability 60/100; grievances: jobs, repression; inflation 0.3%, unemployment 16.5%, growth -1.2%; repression high (0.56); military approval 0.
- **Long-suppressed discontent erupts in Burundi, inspired by upheaval next door.** — why: Domestic pressures in Burundi: government approval 23/100 (lowest: Military & security services 20); unrest 19/100, stability 83/100; grievances: repression, censorship; inflation 0.4%, unemployment 2.2%, growth 1.0%; repression high (0.72); military approval 20.
- **Lebanon: civil war spreads. Grievances: jobs, repression, autonomy.** — why: Domestic pressures in Lebanon: government approval 0/100 (lowest: Urban workers 0); unrest 71/100, stability 23/100; grievances: jobs, repression, autonomy; inflation 7.9%, unemployment 13.9%, growth -8.2%; repression high (0.80); suppressed discontent 35/100 (hidden by media control); military appr
- **Nepal: armed insurgency subsides. Grievances: jobs.** — why: Domestic pressures in Nepal: government approval 50/100 (lowest: Urban workers 44); unrest 0/100, stability 100/100; grievances: jobs; inflation 3.1%, unemployment 10.8%, growth 3.0%; military approval 51.
- **Security forces in Iraq refuse orders to fire on protesters; units defect.** — why: Coups become likely when the military is alienated and the state is unstable. Iraq: monthly coup risk was 0.32%; government approval 19/100 (lowest: Kurdish 10); unrest 29/100, stability 70/100; grievances: jobs, repression, censorship, autonomy; inflation 3.4%, unemployment 16.1%, growth -1.7%; sup

## Key countries at the end

| Country | Government | GDP | Growth | Inflation | Approval | Stability | Unrest stage | Welfare | Incentive weights (w/a/s/p) |
|---|---|---|---|---|---|---|---|---|---|
| United States | liberal democracy | $30.46T | 1.6% | 2.8% | 54 | 100 | calm | 92 | 1/0/0/0 |
| China | one party state | $20.33T | 3.5% | 3.6% | 41 | 92 | calm | 68 | 1/0/0/0 |
| Germany | liberal democracy | $4.73T | 1.1% | 2.9% | 54 | 100 | calm | 91 | 1/0/0/0 |
| India | hybrid regime | $4.34T | 5.4% | 2.9% | 50 | 93 | calm | 61 | 1/0/0/0 |
| Japan | liberal democracy | $4.10T | 1.5% | 2.7% | 47 | 100 | calm | 90 | 1/0/0/0 |
| United Kingdom | liberal democracy | $3.75T | 1.4% | 3.1% | 53 | 100 | calm | 90 | 1/0/0/0 |
| France | liberal democracy | $3.25T | 1.5% | 2.6% | 53 | 100 | calm | 88 | 1/0/0/0 |
| Italy | liberal democracy | $2.41T | 0.7% | 2.5% | 50 | 100 | calm | 86 | 1/0/0/0 |
| Brazil | liberal democracy | $2.31T | 2.0% | 3.0% | 49 | 100 | calm | 76 | 1/0/0/0 |
| Canada | liberal democracy | $2.29T | 1.0% | 2.8% | 51 | 100 | calm | 89 | 1/0/0/0 |
| Russia | authoritarian | $2.23T | 0.6% | 3.0% | 34 | 91 | calm | 65 | 1/0/0/0 |
| Mexico | electoral democracy | $1.89T | 1.3% | 2.8% | 48 | 98 | calm | 74 | 1/0/0/0 |

## Compared with the parent test `mock-baseline-202611280523` at November 2028

| Metric | This test | Parent |
|---|---|---|
| Avg welfare | 63.1 | 63.4 |
| Interstate wars | 2 | 3 |
| Civil wars | 11 | 10 |
| Democracies | 102 | 103 |
| World GDP | $115.57T | $115.64T |
