# Data quality report

Generated 2026-11-26 by `npm run data`. 197 countries, 4575 regions (0 point-only).

## Sources

- Natural Earth admin-1 regions (10m): `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson`
- Natural Earth admin-0 countries (10m): `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson`
- Natural Earth populated places: `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson`
- Natural Earth physical regions (mountains, deserts): `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_geography_regions_polys.geojson`
- mledoze/countries (names, capitals, land borders): `https://raw.githubusercontent.com/mledoze/countries/master/countries.json`
- V-Dem v2x_polyarchy 2024 (country_name,v2x_polyarchy). Official: v-dem.net: `https://raw.githubusercontent.com/centrociir/interculturales/HEAD/clases/clase3/practico/bbdd/vdem2024.csv`
- Transparency International CPI 2025 (official: transparency.org/cpi): `https://raw.githubusercontent.com/loupeat/ti-cpi/HEAD/docs/ti/CPI2025_GlobalResultsTrends.csv`
- World Bank WDI indicators (API, or bulk CSV fallback): SP.POP.TOTL, NY.GDP.MKTP.CD, NY.GDP.PCAP.CD, NY.GDP.MKTP.KD.ZG, FP.CPI.TOTL.ZG, SL.UEM.TOTL.ZS, GC.DOD.TOTL.GD.ZS, NE.TRD.GNFS.ZS, MS.MIL.XPND.GD.ZS, MS.MIL.TOTL.P1, SP.URB.TOTL.IN.ZS, SE.ADT.LITR.ZS, SP.DYN.LE00.IN, SP.POP.GROW, SP.POP.0014.TO.ZS, SP.POP.65UP.TO.ZS, NY.GDP.PETR.RT.ZS, NY.GDP.NGAS.RT.ZS, NY.GDP.COAL.RT.ZS, NY.GDP.MINR.RT.ZS, EG.IMP.CONS.ZS, AG.LND.ARBL.ZS, ER.H2O.FWST.ZS, SM.POP.REFG, SM.POP.REFG.OR, IT.NET.USER.ZS, VC.IHR.PSRC.P5, GC.TAX.TOTL.GD.ZS, SH.XPD.CHEX.GD.ZS, SE.XPD.TOTL.GD.ZS
- Hand-curated: `data/curated.json` (blocs, treaties, disputes, conflicts, sanctions, government systems, minorities, oil/mineral regions, chokepoints)

## Missing sources

- none

## Country fields: real vs estimated

| field | real | estimated | estimated for |
|---|---|---|---|
| pop | 197 | 0 |  |
| gdp | 194 | 3 | ERI PRK VEN |
| polyarchy | 176 | 21 | AND ATG BHS BLZ BRN DMA GRD KIR LIE MHL FSM MCO NRU PLW KNA LCA VCT WSM SMR TON TUV |
| cpi | 181 | 16 | AND ATG KIR PRK KOR LIE MHL FSM MCO NRU PLW KNA WSM SMR TON TUV |
| pressFreedom | 0 | 197 | AFG ALB DZA AND AGO ATG ARG ARM AUS AUT AZE BHS BHR BGD BRB BLR BEL BLZ BEN BTN BOL BIH BWA BRA BRN … |
| internetFreedom | 0 | 197 | AFG ALB DZA AND AGO ATG ARG ARM AUS AUT AZE BHS BHR BGD BRB BLR BEL BLZ BEN BTN BOL BIH BWA BRA BRN … |
| stateMedia | 0 | 197 | AFG ALB DZA AND AGO ATG ARG ARM AUS AUT AZE BHS BHR BGD BRB BLR BEL BLZ BEN BTN BOL BIH BWA BRA BRN … |
| surveillance | 0 | 197 | AFG ALB DZA AND AGO ATG ARG ARM AUS AUT AZE BHS BHR BGD BRB BLR BEL BLZ BEN BTN BOL BIH BWA BRA BRN … |
| growth | 193 | 4 | ERI PRK LIE VEN |
| inflation | 184 | 13 | AND COM CUB ERI PRK LIE MHL MCO NRU SOM TKM TUV YEM |
| unemployment | 181 | 16 | AND ATG DMA GRD KIR LIE MHL FSM MCO NRU PLW KNA SMR SYC TUV XKX |
| debt | 67 | 130 | AFG DZA AND AGO ATG ARG AUT BGD BEL BLZ BEN BOL BRN BGR BDI CPV CMR CAF TCD CHL CHN COM COG CRI CIV … |
| trade | 175 | 22 | AND BRB DMA ERI GRD GUY PRK LBR LIE MWI MCO MMR NGA PNG KNA LCA VCT STP SUR TTO TUV VEN |
| milPctGdp | 156 | 41 | AND ATG BHS BRB BTN COM CRI DJI DMA ERI GRD ISL KIR PRK LAO LBY LIE MDV MHL FSM MCO NRU PLW PAN KNA … |
| milPersonnel | 172 | 25 | AND BTN COM DMA SWZ GRD KIR LIE MDV MHL FSM MCO NRU PLW KNA LCA VCT WSM SMR STP SLB TON TUV VUT XKX |
| urban | 196 | 1 | XKX |
| literacy | 118 | 79 | DZA AND ATG AUS AUT BHS BRB BEL BIH BWA BRN BGR CAN COG CRI HRV CYP CZE DNK DJI DMA GNQ ERI EST FJI … |
| lifeExp | 197 | 0 |  |
| popGrowth | 197 | 0 |  |
| age014 | 197 | 0 |  |
| age65 | 197 | 0 |  |
| internet | 193 | 4 | PRK PLW VAT TWN |
| homicide | 152 | 45 | BRN KHM TCD COM COG COD CIV DJI GNQ ERI ETH GAB GMB GIN IRN IRQ KIR PRK LAO LSO LBR LBY MDG MWI MLI … |
| taxRev | 148 | 49 | DZA ATG BEN BOL BRN TCD COM CUB DJI DMA ERI GMB GRD GIN GUY HTI IDN IRN JPN PRK KWT LBR LBY LIE MRT … |
| healthExp | 192 | 5 | PRK LIE VAT XKX TWN |
| eduExp | 181 | 16 | EGY GNQ ERI GNB IRQ PRK LBY LIE MNE MKD SDN SYR YEM VAT XKX TWN |

## Always estimated (no open source reachable / by design)

- Region population and GDP share: national totals split by city populations (urban share) and habitable area (rural share).
- Region terrain from Natural Earth physical regions at the region's label point; jungle = within 8° of the equator.
- Region resources: curated major oil/gas/mineral regions; otherwise national resource rents spread over the 3 largest regions.
- Press freedom, internet censorship, state-media dominance, surveillance: derived from V-Dem polyarchy, CPI and income (drop data/manual/pressFreedom.csv etc. to replace).
- Bilateral trade: gravity model scaled to each country's trade openness. UN voting alignment: proxied at start from blocs, rivalries and regime similarity.
- Constitutions: templates from system type, not the Constitute Project (not reachable from the build machine).
- Next legislative election month: spread pseudo-randomly within the real term length.

## Curated names not found in Natural Earth (fix in data/curated.json)

- none

## V-Dem names not matched

none
