// Fetches open data once into data/raw/ (gitignored) and bakes the processed files into data/.
// Usage: npm run data            (download missing sources, then build)
//        npm run data -- --force-incentives   (overwrite data/incentives.json and data/constitutions.json)
// If a source can't be downloaded you get a message naming the file to drop into data/raw/ manually.
// Override any country stat with data/manual/<field>.csv (columns: iso3,value). See NOTES.md.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
// @ts-expect-error mapshaper ships no types
import mapshaper from 'mapshaper';
import * as topo from 'topojson-client';
import { classify, computeIncentives, constitutionTemplate, type RegimeFacts } from '../engine/regime.ts';
import { clamp, hash, km, round } from '../engine/util.ts';

const D = 'data', RAW = 'data/raw';
fs.mkdirSync(`${RAW}/wdi`, { recursive: true });
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const GH = 'https://raw.githubusercontent.com/';
const SOURCES: Record<string, { file: string; urls: string[]; what: string }> = {
  admin1: { file: 'ne_10m_admin_1_states_provinces.geojson', urls: [NE + 'ne_10m_admin_1_states_provinces.geojson'], what: 'Natural Earth admin-1 regions (10m)' },
  admin0: { file: 'ne_10m_admin_0_countries.geojson', urls: [NE + 'ne_10m_admin_0_countries.geojson'], what: 'Natural Earth admin-0 countries (10m)' },
  places: { file: 'ne_10m_populated_places_simple.geojson', urls: [NE + 'ne_10m_populated_places_simple.geojson'], what: 'Natural Earth populated places' },
  geo: { file: 'ne_10m_geography_regions_polys.geojson', urls: [NE + 'ne_10m_geography_regions_polys.geojson'], what: 'Natural Earth physical regions (mountains, deserts)' },
  mledoze: { file: 'mledoze.json', urls: [GH + 'mledoze/countries/master/countries.json'], what: 'mledoze/countries (names, capitals, land borders)' },
  vdem: { file: 'v24.csv', urls: [GH + 'centrociir/interculturales/HEAD/clases/clase3/practico/bbdd/vdem2024.csv'], what: 'V-Dem v2x_polyarchy 2024 (country_name,v2x_polyarchy). Official: v-dem.net' },
  cpi: { file: 'cpi.csv', urls: [GH + 'loupeat/ti-cpi/HEAD/docs/ti/CPI2025_GlobalResultsTrends.csv'], what: 'Transparency International CPI 2025 (official: transparency.org/cpi)' },
  // Gapminder open-numbers mirrors (columns: country,time,value; lowercase ISO3)
  idea_media: { file: 'idea_mediaint.csv', urls: [GH + 'open-numbers/ddf--gapminder--fasttrack/HEAD/countries_etc_datapoints/ddf--datapoints--mediaint_idea--by--country--time.csv'], what: 'International IDEA Media Integrity index (0-100) -> press freedom' },
  idea_expr: { file: 'idea_fexpression.csv', urls: [GH + 'open-numbers/ddf--gapminder--fasttrack/HEAD/countries_etc_datapoints/ddf--datapoints--fexpression_idea--by--country--time.csv'], what: 'International IDEA Freedom of Expression index (0-100) -> inverse of censorship' },
  imf_debt: { file: 'imf_ggxwdg.csv', urls: [GH + 'open-numbers/ddf--imf--weo/HEAD/ddf--datapoints--ggxwdg_ngdp--by--country--year.csv'], what: 'IMF WEO general government gross debt (% of GDP)' },
};
/** Latest value <= 2025 from a Gapminder ddf datapoints file. */
function ddfLatest(key: string): Record<string, number> {
  const f = `${RAW}/${SOURCES[key].file}`, out: Record<string, number> = {}, yr: Record<string, number> = {};
  if (!fs.existsSync(f)) return out;
  for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(1)) {
    const c = l.split(','); if (c.length < 3 || c[2] === '') continue;
    // files are either country,time,value or time,country,value
    const [iso, y] = /^\d{4}$/.test(c[0]) ? [c[1], +c[0]] : [c[0], +c[1]];
    const I = iso.toUpperCase() === 'XKX' || iso === 'kos' ? 'XKX' : iso.toUpperCase();
    if (y <= 2025 && !(yr[I] >= y)) { yr[I] = y; out[I] = +c[2]; }
  }
  return out;
}
// World Bank indicators. Tried via the World Bank API first; falls back to a full WDI CSV dump (data/raw/WDICSV.csv).
const WDI: Record<string, string> = {
  pop: 'SP.POP.TOTL', gdp: 'NY.GDP.MKTP.CD', gdpPc: 'NY.GDP.PCAP.CD', growth: 'NY.GDP.MKTP.KD.ZG', inflation: 'FP.CPI.TOTL.ZG',
  unemployment: 'SL.UEM.TOTL.ZS', debt: 'GC.DOD.TOTL.GD.ZS', trade: 'NE.TRD.GNFS.ZS', milPctGdp: 'MS.MIL.XPND.GD.ZS', milPersonnel: 'MS.MIL.TOTL.P1',
  urban: 'SP.URB.TOTL.IN.ZS', literacy: 'SE.ADT.LITR.ZS', lifeExp: 'SP.DYN.LE00.IN', popGrowth: 'SP.POP.GROW', age014: 'SP.POP.0014.TO.ZS', age65: 'SP.POP.65UP.TO.ZS',
  oilRents: 'NY.GDP.PETR.RT.ZS', gasRents: 'NY.GDP.NGAS.RT.ZS', coalRents: 'NY.GDP.COAL.RT.ZS', mineralRents: 'NY.GDP.MINR.RT.ZS', energyImports: 'EG.IMP.CONS.ZS',
  arable: 'AG.LND.ARBL.ZS', waterStress: 'ER.H2O.FWST.ZS', refugeesHosted: 'SM.POP.REFG', refugeesOrigin: 'SM.POP.REFG.OR', internet: 'IT.NET.USER.ZS',
  homicide: 'VC.IHR.PSRC.P5', taxRev: 'GC.TAX.TOTL.GD.ZS', healthExp: 'SH.XPD.CHEX.GD.ZS', eduExp: 'SE.XPD.TOTL.GD.ZS',
};
const missingSources: string[] = [];

async function download(url: string, dest: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}
async function ensure(key: string) {
  const s = SOURCES[key], dest = `${RAW}/${s.file}`;
  if (fs.existsSync(dest)) return dest;
  for (const u of s.urls) {
    try { console.log('download', u); await download(u, dest); return dest; } catch (e) { console.warn('  failed:', (e as Error).message); }
  }
  missingSources.push(`${s.what} -> put it at ${dest} (tried ${s.urls.join(', ')})`);
  return null;
}

type Series = Record<string, [number, number]>; // iso3 -> [year, value]
async function wdiSeries(): Promise<Record<string, Series>> {
  const out: Record<string, Series> = {}, need: string[] = []; let apiDown = false;
  for (const [k, code] of Object.entries(WDI)) {
    const f = `${RAW}/wdi/${code}.json`;
    if (fs.existsSync(f)) { out[k] = JSON.parse(fs.readFileSync(f, 'utf8')); continue; }
    if (apiDown) { need.push(k); continue; }
    try {
      const r = await fetch(`https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&per_page=20000&date=2015:2025`, { signal: AbortSignal.timeout(60_000) });
      const j = await r.json() as [unknown, { countryiso3code: string; date: string; value: number | null }[]];
      const s: Series = {};
      for (const row of j[1] ?? []) if (row.value != null && row.countryiso3code && !(s[row.countryiso3code]?.[0] > +row.date)) s[row.countryiso3code] = [+row.date, row.value];
      out[k] = s; fs.writeFileSync(f, JSON.stringify(s));
    } catch { need.push(k); apiDown = true; console.warn('World Bank API unreachable; using bulk CSV fallback'); }
  }
  if (need.length) {
    const dump = `${RAW}/WDICSV.csv`;
    if (!fs.existsSync(dump)) {
      missingSources.push(`World Bank API unreachable for ${need.join(', ')}. Download WDI CSV (databank.worldbank.org > WDI > Bulk download) and put WDICSV.csv at ${dump}`);
      for (const k of need) out[k] = {};
      return out;
    }
    console.log('reading WDI bulk CSV for', need.length, 'indicators');
    const want = new Map(need.map(k => [WDI[k], k])); let years: number[] = [];
    for (const k of need) out[k] = {};
    for await (const line of readline.createInterface({ input: fs.createReadStream(dump) })) {
      const cells = parseCsvLine(line);
      if (!years.length) { years = cells.slice(4).map(Number); continue; }
      const k = want.get(cells[3]); if (!k) continue;
      for (let i = cells.length - 1; i >= 4; i--) if (cells[i] !== '' && years[i - 4] >= 2015) { out[k][cells[1]] = [years[i - 4], +cells[i]]; break; }
    }
    for (const k of need) fs.writeFileSync(`${RAW}/wdi/${WDI[k]}.json`, JSON.stringify(out[k]));
  }
  return out;
}

function parseCsvLine(line: string, sep = ','): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === sep) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}

// ---------- geometry helpers ----------
type Ring = [number, number][]; type Poly = Ring[];
const polysOf = (g: any): Poly[] => !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
function ringArea(r: Ring) { // km², spherical approximation (same formula as turf/area)
  let s = 0; const R = 6371, rad = Math.PI / 180;
  for (let i = 0; i < r.length - 1; i++) { const [x1, y1] = r[i], [x2, y2] = r[i + 1]; s += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad)); }
  return Math.abs(s * R * R / 2);
}
const geomArea = (g: any) => polysOf(g).reduce((a, p) => a + ringArea(p[0]) - p.slice(1).reduce((b, h) => b + ringArea(h), 0), 0);
function inRing(pt: [number, number], r: Ring) {
  let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
const inGeom = (pt: [number, number], g: any) => polysOf(g).some(p => inRing(pt, p[0]) && !p.slice(1).some(h => inRing(pt, h)));
function bbox(g: any): [number, number, number, number] {
  let a = 180, b = 90, c = -180, d = -90;
  for (const p of polysOf(g)) for (const [x, y] of p[0]) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
}
const inBox = (pt: [number, number], bb: number[]) => pt[0] >= bb[0] && pt[0] <= bb[2] && pt[1] >= bb[1] && pt[1] <= bb[3];

// ---------- main ----------
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const cur = readJson(`${D}/curated.json`);

for (const k of Object.keys(SOURCES)) await ensure(k);
if (missingSources.length && ['admin1', 'admin0', 'mledoze'].some(k => !fs.existsSync(`${RAW}/${SOURCES[k].file}`))) {
  console.error('Required sources missing:\n - ' + missingSources.join('\n - ')); process.exit(1);
}
const wdi = await wdiSeries();
const mled: any[] = readJson(`${RAW}/mledoze.json`);
const mledBy = Object.fromEntries(mled.map(c => [c.cca3, c]));

// Country list (editable). Created on first run.
const UN193 = 'AFG ALB DZA AND AGO ATG ARG ARM AUS AUT AZE BHS BHR BGD BRB BLR BEL BLZ BEN BTN BOL BIH BWA BRA BRN BGR BFA BDI CPV KHM CMR CAN CAF TCD CHL CHN COL COM COG COD CRI CIV HRV CUB CYP CZE DNK DJI DMA DOM ECU EGY SLV GNQ ERI EST SWZ ETH FJI FIN FRA GAB GMB GEO DEU GHA GRC GRD GTM GIN GNB GUY HTI HND HUN ISL IND IDN IRN IRQ IRL ISR ITA JAM JPN JOR KAZ KEN KIR PRK KOR KWT KGZ LAO LVA LBN LSO LBR LBY LIE LTU LUX MDG MWI MYS MDV MLI MLT MHL MRT MUS MEX FSM MDA MCO MNG MNE MAR MOZ MMR NAM NRU NPL NLD NZL NIC NER NGA MKD NOR OMN PAK PLW PAN PNG PRY PER PHL POL PRT QAT ROU RUS RWA KNA LCA VCT WSM SMR STP SAU SEN SRB SYC SLE SGP SVK SVN SLB SOM ZAF SSD ESP LKA SDN SUR SWE CHE SYR TJK TZA THA TLS TGO TON TTO TUN TUR TKM TUV UGA UKR ARE GBR USA URY UZB VUT VEN VNM YEM ZMB ZWE'.split(' ');
const NAMES: Record<string, string> = { VAT: 'Holy See', PSE: 'Palestine', XKX: 'Kosovo', TWN: 'Taiwan', COD: 'Democratic Republic of the Congo', COG: 'Republic of the Congo', PRK: 'North Korea', KOR: 'South Korea', CIV: "Côte d'Ivoire", CZE: 'Czechia', TUR: 'Türkiye', MKD: 'North Macedonia', SWZ: 'Eswatini', FSM: 'Micronesia', TLS: 'Timor-Leste' };
if (!fs.existsSync(`${D}/country-list.json`)) {
  const list = [...UN193, 'VAT', 'PSE', 'XKX', 'TWN'].map(iso3 => ({ iso3, name: NAMES[iso3] ?? mledBy[iso3 === 'XKX' ? 'UNK' : iso3]?.name.common ?? iso3 }));
  fs.writeFileSync(`${D}/country-list.json`, JSON.stringify(list, null, 1));
}
const countryList: { iso3: string; name: string }[] = readJson(`${D}/country-list.json`);
const ISO = new Set(countryList.map(c => c.iso3));
const mledIso = (iso: string) => mledBy[iso === 'XKX' ? 'UNK' : iso];

// Natural Earth adm0 codes -> our ISO3 (sovereign). Dependencies map to their sovereign; disputed areas to de facto/de jure holder.
const NE_FIX: Record<string, string> = { SDS: 'SSD', KOS: 'XKX', PSX: 'PSE', SOL: 'SOM', SAH: 'MAR', CYN: 'CYP', KAS: 'IND', KAB: 'KAZ', USG: 'CUB', ESB: 'CYP', WSB: 'CYP' };
const SOV_FIX: Record<string, string> = { GB1: 'GBR', CH1: 'CHN', FR1: 'FRA', NL1: 'NLD', US1: 'USA', DN1: 'DNK', FI1: 'FIN', KA1: 'KAZ', AU1: 'AUS', NZ1: 'NZL', CU1: 'CUB' };
const DROP = new Set(['ATA', 'ATF', 'HMD', 'SGS', 'CSI', 'CLP', 'ATC', 'PGA', 'IOT', 'UMI', 'BVT']);
function ownerOf(p: any): string | null {
  if (DROP.has(p.adm0_a3)) return null;
  const a = NE_FIX[p.adm0_a3] ?? p.adm0_a3;
  if (ISO.has(a)) return a;
  const s = SOV_FIX[p.sov_a3] ?? p.sov_a3;
  return ISO.has(s) ? s : null;
}

console.log('reading admin-1 …');
const a1 = readJson(`${RAW}/${SOURCES.admin1.file}`);
// Crimea & Sevastopol: Natural Earth lists them under RUS; de jure owner is Ukraine (controller RUS set in curated occupations).
for (const f of a1.features) if (['Crimea', 'Sevastopol'].includes(f.properties.name) && f.properties.adm0_a3 === 'RUS') { f.properties.adm0_a3 = 'UKR'; f.properties.sov_a3 = 'UKR'; f.properties.admin = 'Ukraine'; }
const feats = a1.features.filter((f: any) => ownerOf(f.properties) && f.geometry);
const places = fs.existsSync(`${RAW}/${SOURCES.places.file}`) ? readJson(`${RAW}/${SOURCES.places.file}`).features : [];
const geoPolys = fs.existsSync(`${RAW}/${SOURCES.geo.file}`) ? readJson(`${RAW}/${SOURCES.geo.file}`).features.filter((f: any) => ['Range/mtn', 'Desert', 'Tundra'].includes(f.properties.FEATURECLA)).map((f: any) => ({ cls: f.properties.FEATURECLA, g: f.geometry, bb: bbox(f.geometry) })) : [];

interface R0 { f: any; owner: string; area: number; bb: number[]; cityPop: number; cities: number; capital: boolean; terrain: string; lon: number; lat: number }
const rs: R0[] = feats.map((f: any) => {
  const p = f.properties;
  return { f, owner: ownerOf(p)!, area: geomArea(f.geometry), bb: bbox(f.geometry), cityPop: 0, cities: 0, capital: false, terrain: 'flat', lon: p.longitude, lat: p.latitude };
});
console.log('regions kept:', rs.length);

// cities -> regions (point in polygon, bbox prefilter)
const capCity: Record<string, R0> = {};
for (const pl of places) {
  const pt = pl.geometry.coordinates as [number, number];
  const r = rs.find(r => inBox(pt, r.bb) && inGeom(pt, r.f.geometry)); if (!r) continue;
  r.cityPop += pl.properties.pop_max || 0; r.cities++;
  if (pl.properties.adm0cap === 1 && r.owner === (NE_FIX[pl.properties.adm0_a3] ?? SOV_FIX[pl.properties.sov_a3] ?? pl.properties.adm0_a3) && !capCity[r.owner]) capCity[r.owner] = r;
}
// terrain from physical regions at the region's label point
for (const r of rs) {
  const pt: [number, number] = [r.lon, r.lat];
  const hit = geoPolys.find((g: any) => inBox(pt, g.bb) && inGeom(pt, g.g));
  r.terrain = hit?.cls === 'Range/mtn' ? 'mountain' : hit?.cls === 'Desert' ? 'desert' : hit?.cls === 'Tundra' ? 'tundra' : Math.abs(r.lat) < 8 ? 'jungle' : 'flat';
}

// ---------- country stats ----------
const val = (k: string, iso: string) => wdi[k]?.[iso === 'XKX' ? 'XKX' : iso];
const vdem: Record<string, number> = {};
const unmatchedVdem: string[] = [];
if (fs.existsSync(`${RAW}/${SOURCES.vdem.file}`)) {
  const ALIAS: Record<string, string> = { 'Burma/Myanmar': 'MMR', 'United States of America': 'USA', 'Republic of the Congo': 'COG', 'Democratic Republic of the Congo': 'COD', 'Ivory Coast': 'CIV', 'The Gambia': 'GMB', 'Palestine/West Bank': 'PSE', 'Palestine/Gaza': 'PSE_G', 'Türkiye': 'TUR', 'Turkey': 'TUR', 'Kosovo': 'XKX', 'North Korea': 'PRK', 'South Korea': 'KOR', 'Russia': 'RUS', 'Czechia': 'CZE', 'Czech Republic': 'CZE', 'Eswatini': 'SWZ', 'Cape Verde': 'CPV', 'Timor-Leste': 'TLS', 'Taiwan': 'TWN', 'Vietnam': 'VNM', 'Laos': 'LAO', 'Syria': 'SYR', 'Iran': 'IRN', 'Bolivia': 'BOL', 'Venezuela': 'VEN', 'Tanzania': 'TZA', 'Moldova': 'MDA', 'Sao Tome and Principe': 'STP', 'Somaliland': 'SOL', 'Zanzibar': 'ZZB', 'Hong Kong': 'HKG', 'North Macedonia': 'MKD', 'Brunei': 'BRN' };
  const byName: Record<string, string> = {};
  for (const c of mled) for (const n of [c.name.common, c.name.official, ...(c.altSpellings ?? [])]) byName[n.toLowerCase()] = c.cca3;
  for (const line of fs.readFileSync(`${RAW}/${SOURCES.vdem.file}`, 'utf8').split(/\r?\n/).slice(1)) {
    const [name, v] = parseCsvLine(line); if (!name || v === '' || v == null) continue;
    const iso = ALIAS[name] ?? byName[name.toLowerCase()];
    if (iso && ISO.has(iso)) vdem[iso] = +v; else if (!['PSE_G', 'SOL', 'ZZB', 'HKG'].includes(iso)) unmatchedVdem.push(name);
  }
}
const cpi: Record<string, number> = {};
if (fs.existsSync(`${RAW}/${SOURCES.cpi.file}`)) {
  const lines = fs.readFileSync(`${RAW}/${SOURCES.cpi.file}`, 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const hi = lines.findIndex(l => l.includes('ISO3')), head = lines[hi].split(';'), col = head.findIndex(h => /^CPI score 20\d\d$/.test(h));
  for (const l of lines.slice(hi + 1)) { const c = l.split(';'); if (c[1] && c[col]) cpi[c[1] === 'KSV' ? 'XKX' : c[1]] = +c[col]; }
}
const manual: Record<string, Record<string, number>> = {};
if (fs.existsSync(`${D}/manual`)) for (const f of fs.readdirSync(`${D}/manual`).filter(f => f.endsWith('.csv'))) {
  const field = path.basename(f, '.csv'); manual[field] = {};
  for (const l of fs.readFileSync(`${D}/manual/${f}`, 'utf8').split(/\r?\n/).slice(1)) { const [i, v] = parseCsvLine(l); if (i && v) manual[field][i.trim().toUpperCase()] = +v; }
}

const sysOf: Record<string, string> = {};
for (const [k, arr] of Object.entries(cur.system)) if (Array.isArray(arr)) for (const i of arr as string[]) sysOf[i] = sysOf[i] === undefined || k === 'junta' ? k : sysOf[i];
const relOf: Record<string, string> = {};
for (const [k, arr] of Object.entries(cur.religion)) if (Array.isArray(arr)) for (const i of arr as string[]) relOf[i] = k;
const quality: Record<string, { real: number; est: number; estList: string[] }> = {};
const note = (field: string, iso: string, real: boolean) => { const q = (quality[field] ??= { real: 0, est: 0, estList: [] }); if (real) q.real++; else { q.est++; q.estList.push(iso); } };

const countries: any[] = [];
const incomeOf = (pc: number) => pc >= 13935 ? 'high' : pc >= 4495 ? 'upper' : pc >= 1135 ? 'lower' : 'low';
// medians by income group for gap filling (computed from real values)
const raw: Record<string, Record<string, number | undefined>> = {};
const ideaMedia = ddfLatest('idea_media'), ideaExpr = ddfLatest('idea_expr'), imfDebt = ddfLatest('imf_debt');
for (const { iso3 } of countryList) {
  const m = cur.manual_stats[iso3] ?? {};
  const g = (k: string) => manual[k]?.[iso3] ?? m[k] ?? val(k, iso3)?.[1];
  raw[iso3] = Object.fromEntries(Object.keys(WDI).map(k => [k, g(k)]));
  raw[iso3].polyarchy = manual.polyarchy?.[iso3] ?? m.polyarchy ?? vdem[iso3];
  raw[iso3].cpi = manual.cpi?.[iso3] ?? m.cpi ?? cpi[iso3];
  for (const k of ['pressFreedom', 'internetFreedom', 'stateMedia', 'surveillance']) raw[iso3][k] = manual[k]?.[iso3];
  raw[iso3].pressFreedom ??= ideaMedia[iso3];
  raw[iso3].internetFreedom ??= ideaExpr[iso3];
  raw[iso3].debt = manual.debt?.[iso3] ?? m.debt ?? imfDebt[iso3] ?? raw[iso3].debt; // IMF general government debt beats WDI central government debt
  if (raw[iso3].gdpPc == null && raw[iso3].gdp && raw[iso3].pop) raw[iso3].gdpPc = raw[iso3].gdp! / raw[iso3].pop!;
}
// fallbacks for pop/gdp from Natural Earth admin-0 (POP_EST, GDP_MD)
const a0 = readJson(`${RAW}/${SOURCES.admin0.file}`);
for (const f of a0.features) {
  const iso = NE_FIX[f.properties.ADM0_A3] ?? f.properties.ADM0_A3; const r = raw[iso]; if (!r) continue;
  if (r.pop == null && f.properties.POP_EST) { r.pop = f.properties.POP_EST; r._popNE = 1; }
  if (r.gdp == null && f.properties.GDP_MD) { r.gdp = f.properties.GDP_MD * 1e6; r._gdpNE = 1; }
  if (r.gdpPc == null && r.gdp && r.pop) r.gdpPc = r.gdp / r.pop;
}
const median = (k: string, grp: string) => {
  const xs = Object.values(raw).filter(r => r[k] != null && r.gdpPc != null && incomeOf(r.gdpPc!) === grp).map(r => r[k]!).sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] : 0;
};

for (const { iso3, name } of countryList) {
  const r = raw[iso3], est: string[] = [];
  const ml = mledIso(iso3);
  const pick = (k: string, fallback: () => number) => { const v = r[k]; note(k, iso3, v != null && !(k === 'pop' && r._popNE) && !(k === 'gdp' && r._gdpNE)); if (v == null) { est.push(k); return fallback(); } return v; };
  const pop = pick('pop', () => 1e5);
  const gdp = pick('gdp', () => pop * 3000);
  const gdpPc = gdp / pop; const grp = incomeOf(gdpPc);
  const m = (k: string) => pick(k, () => median(k, grp));
  const system = sysOf[iso3] ?? 'pres';
  const polyarchy = pick('polyarchy', () => system === 'amon' || system === 'onep' ? 0.1 : ['cmon', 'parl'].includes(system) ? 0.72 : 0.45);
  const cpiScore = pick('cpi', () => clamp(25 + polyarchy * 50 + (grp === 'high' ? 10 : 0), 10, 90));
  const corruption = round(1 - cpiScore / 100, 3);
  const gov = classify(system, polyarchy);
  const info = {
    pressFreedom: r.pressFreedom != null ? r.pressFreedom / 100 : round(clamp(0.08 + 0.85 * polyarchy + 0.1 * (cpiScore / 100 - 0.4), 0.03, 0.95), 3),
    censorship: r.internetFreedom != null ? round(1 - r.internetFreedom / 100, 3) : round(clamp(0.95 - 1.0 * polyarchy, 0.03, 0.95), 3),
    stateMedia: r.stateMedia != null ? r.stateMedia / 100 : round(clamp(1 - polyarchy * 0.95, 0.05, 0.95), 3),
    surveillance: r.surveillance != null ? r.surveillance / 100 : round(clamp((1 - polyarchy) * 0.55 + clamp(Math.log10(gdpPc / 1000) / 2, 0, 1) * 0.4, 0.05, 0.95), 3),
  };
  for (const k of ['pressFreedom', 'internetFreedom', 'stateMedia', 'surveillance']) { note(k, iso3, r[k] != null); if (r[k] == null) est.push(k); }
  const ex = (k: string) => (r[k] as number | undefined);
  countries.push({
    iso3, name, system, govType: gov, incomeGroup: grp,
    pop: Math.round(pop), gdp: Math.round(gdp), gdpPc: Math.round(gdpPc),
    growth: round(clamp(m('growth'), -15, 15)), inflation: round(clamp(m('inflation'), -2, 300)), unemployment: round(clamp(m('unemployment'), 0.5, 40)),
    debtPctGdp: round(pick('debt', () => grp === 'high' ? 70 : 55)), tradePctGdp: round(m('trade')),
    milPctGdp: round(pick('milPctGdp', () => system === 'amon' ? 4 : 1.2)), milPersonnel: Math.round(pick('milPersonnel', () => pop * 0.004)),
    urban: round(m('urban')), literacy: round(pick('literacy', () => grp === 'high' ? 99 : grp === 'upper' ? 95 : grp === 'lower' ? 80 : 55)),
    lifeExp: round(m('lifeExp')), popGrowth: round(m('popGrowth')), age014: round(m('age014')), age65: round(m('age65')),
    oilRents: round(ex('oilRents') ?? 0), gasRents: round(ex('gasRents') ?? 0), coalRents: round(ex('coalRents') ?? 0), mineralRents: round(ex('mineralRents') ?? 0),
    energyImports: round(ex('energyImports') ?? 0), arablePct: round(ex('arable') ?? 10), waterStress: round(ex('waterStress') ?? 20),
    refugeesHosted: Math.round(ex('refugeesHosted') ?? 0), refugeesOrigin: Math.round(ex('refugeesOrigin') ?? 0),
    internet: round(m('internet')), homicide: round(m('homicide')), taxRevPctGdp: round(pick('taxRev', () => grp === 'high' ? 22 : 14)),
    healthExpPctGdp: round(m('healthExp')), eduExpPctGdp: round(m('eduExp')),
    polyarchy: round(polyarchy, 3), cpi: cpiScore, corruption,
    religion: relOf[iso3] ?? 'christian', ...info,
    terror: cur.terror_presence.high.includes(iso3) ? 0.7 : cur.terror_presence.medium.includes(iso3) ? 0.35 : 0.05,
    crime: cur.organised_crime.high.includes(iso3) ? 0.7 : cur.organised_crime.medium.includes(iso3) ? 0.4 : clamp((ex('homicide') ?? 3) / 30, 0.03, 0.6),
    nuclear: cur.nuclear.includes(iso3), p5: cur.unsc_p5.includes(iso3),
    landlocked: !!ml?.landlocked, borders: (ml?.borders ?? []).map((b: string) => b === 'UNK' ? 'XKX' : b).filter((b: string) => ISO.has(b)),
    latlng: ml?.latlng ?? [0, 0], federal: cur.federal.includes(iso3), bicameral: cur.bicameral.includes(iso3),
    electionYears: cur.election_years[iso3] ?? (cur.four_year_terms.includes(iso3) ? 4 : 5),
    estimated: [...new Set(est)],
    source: cur.manual_stats[iso3]?.source,
  });
}
const C = Object.fromEntries(countries.map(c => [c.iso3, c]));

// ---------- regions ----------
const minorityFor = (r: R0) => cur.minority_regions.find((m: any) => {
  if (m.c !== r.owner) return false; const p = r.f.properties;
  return (m.regions ?? []).includes(p.name) || (m.regions ?? []).includes('*') || (m.match_geonunit && p.geonunit === m.match_geonunit) || (m.match_region && p.region === m.match_region) || (m.match_admin && p.admin === m.match_admin);
});
const curatedNameMiss: string[] = [];
const byOwner: Record<string, R0[]> = {};
for (const r of rs) (byOwner[r.owner] ??= []).push(r);
const hasRegion = (c: string, n: string) => n === '*' || byOwner[c]?.some(r => r.f.properties.name === n);
for (const m of cur.minority_regions) for (const n of m.regions ?? []) if (!hasRegion(m.c, n)) curatedNameMiss.push(`minority ${m.c}:${n}`);
for (const [c, o] of Object.entries(cur.oil_gas_regions)) if (!c.startsWith('_')) for (const n of Object.keys(o as object)) if (!hasRegion(c, n)) curatedNameMiss.push(`oil ${c}:${n}`);
for (const [c, o] of Object.entries(cur.minerals_regions)) if (!c.startsWith('_')) for (const n of Object.keys(o as object)) if (!hasRegion(c, n)) curatedNameMiss.push(`minerals ${c}:${n}`);

const regions: any[] = [];
const TERR_RURAL: Record<string, number> = { flat: 1, jungle: 0.5, mountain: 0.4, desert: 0.05, tundra: 0.03 };
for (const [iso, list] of Object.entries(byOwner)) {
  const c = C[iso]; const u = c.urban / 100;
  const cityTot = list.reduce((s, r) => s + r.cityPop, 0);
  const rw = (r: R0) => r.area * (TERR_RURAL[r.terrain] ?? 1) * (Math.abs(r.lat) > 60 ? 0.1 : 1);
  const rwTot = list.reduce((s, r) => s + rw(r), 0) || 1;
  const capName = cur.capital_overrides[iso];
  const cap = (capName && list.find(r => r.f.properties.name === capName)) || capCity[iso] || list.reduce((a, b) => b.cityPop > a.cityPop ? b : a);
  cap.capital = true;
  const oil = cur.oil_gas_regions[iso] ?? {}, minr = cur.minerals_regions[iso] ?? {};
  const bigRural = [...list].sort((a, b) => b.area - a.area).slice(0, 3).map(r => r.f.properties.name);
  for (const r of list) {
    const p = r.f.properties, est = ['pop', 'gdpShare', 'infra'];
    const popShare = cityTot > 0 ? u * r.cityPop / cityTot + (1 - u) * rw(r) / rwTot : rw(r) / rwTot;
    const m = minorityFor(r);
    const tier = (s: string | undefined, k: string) => { const mm = s?.match(new RegExp(k + '(\\d)')); return mm ? +mm[1] : 0; };
    let o = tier(oil[p.name], 'o'), g = tier(oil[p.name], 'g');
    if (!Object.keys(oil).length && c.oilRents > 2 && bigRural.includes(p.name)) { o = c.oilRents > 10 ? 2 : 1; est.push('oil'); }
    if (!Object.keys(oil).length && c.gasRents > 1 && bigRural.includes(p.name)) { g = 1; est.push('gas'); }
    let minerals = minr[p.name] ?? 0;
    if (!minerals && c.mineralRents > 1 && bigRural.includes(p.name)) { minerals = c.mineralRents > 5 ? 2 : 1; est.push('minerals'); }
    const coal = c.coalRents > 0.3 && bigRural.includes(p.name) ? (c.coalRents > 2 ? 2 : 1) : 0;
    if (coal) est.push('coal');
    const arable = r.terrain === 'desert' || r.terrain === 'tundra' ? 0 : clamp(Math.round(c.arablePct / 12 * (r.terrain === 'mountain' ? 0.5 : 1)), 0, 3);
    const water = clamp((c.waterStress >= 100 ? 3 : c.waterStress >= 40 ? 2 : c.waterStress >= 20 ? 1 : 0) + (r.terrain === 'desert' ? 1 : 0), 0, 3);
    const urbanish = r.cityPop > 1e6 && r.area < 20000;
    const choke = cur.chokepoints.find((ch: any) => (ch.controllers[iso] ?? []).some((n: string) => n === '*' || n === p.name));
    regions.push({
      name: p.name ?? p.adm1_code, country: iso, adm1: p.adm1_code, lon: round(r.lon, 3), lat: round(r.lat, 3), areaKm2: Math.round(r.area),
      pop: Math.round(c.pop * popShare), gdpShare: popShare * (1 + (urbanish ? 0.6 : 0) + (r.capital ? 0.3 : 0) + (o + g) * 0.15),
      terrain: urbanish ? 'urban' : r.terrain === 'tundra' ? 'flat' : r.terrain, coastal: false, capital: r.capital,
      infra: clamp(Math.round(Math.log10(Math.max(c.gdpPc, 300)) * 1.6 - 2.5 + (urbanish || r.capital ? 1 : 0) - (r.terrain === 'desert' || r.terrain === 'tundra' ? 1 : 0)), 1, 5),
      res: { oil: o, gas: g, coal, minerals, arable, water },
      group: m?.group || null, religion: m?.religion ?? c.religion, separatism: m?.separatism ?? 0, autonomy: !!m?.autonomy,
      chokepoint: choke?.name ?? null, nb: [], estimated: est, _f: r.f,
    });
  }
  const gs = regions.filter(x => x.country === iso).reduce((s, x) => s + x.gdpShare, 0);
  for (const x of regions) if (x.country === iso) x.gdpShare = round(x.gdpShare / gs, 5);
}
// tiny states without polygons -> points
for (const c of countries) if (!byOwner[c.iso3]) {
  regions.push({ name: c.name, country: c.iso3, adm1: c.iso3 + '-pt', lon: c.latlng[1], lat: c.latlng[0], areaKm2: 1, pop: c.pop, gdpShare: 1, terrain: 'urban', coastal: true, capital: true, infra: 3, res: { oil: 0, gas: 0, coal: 0, minerals: 0, arable: 0, water: 1 }, group: null, religion: c.religion, separatism: 0, autonomy: false, chokepoint: null, nb: [], point: true, estimated: ['geometry'] });
}
regions.forEach((r, i) => (r.id = i));

// ---------- topology: simplify + adjacency + coastline ----------
console.log('simplifying with mapshaper …');
const fc = { type: 'FeatureCollection', features: regions.filter(r => r._f).map(r => ({ type: 'Feature', properties: { id: r.id }, geometry: r._f.geometry })) };
const out = await mapshaper.applyCommands('-i in.json snap -simplify weighted 4% keep-shapes -clean -o out.json format=topojson quantization=100000', { 'in.json': JSON.stringify(fc) });
const topology = JSON.parse(out['out.json'].toString());
const objName = Object.keys(topology.objects)[0];
topology.objects = { regions: topology.objects[objName] };
const geoms = topology.objects.regions.geometries;
const nbs = topo.neighbors(geoms);
const arcUse = new Map<number, number>();
const arcsOf = (g: any): number[] => (g.type === 'Polygon' ? g.arcs.flat() : g.type === 'MultiPolygon' ? g.arcs.flat(2) : []).map((a: number) => a < 0 ? ~a : a);
for (const g of geoms) for (const a of new Set(arcsOf(g))) arcUse.set(a, (arcUse.get(a) ?? 0) + 1);
geoms.forEach((g: any, i: number) => {
  const r = regions[g.properties.id]; g.id = r.id; delete g.properties;
  r.nb = nbs[i].map(j => geoms[j].id ?? geoms[j].properties?.id).filter((x: number) => x !== r.id);
  r.coastal = arcsOf(g).some(a => arcUse.get(a) === 1);
});
// regions with no land neighbours (islands, points): link to nearest 2 regions within 600 km so wars/trade can reach them by sea
for (const r of regions) if (!r.nb.length) {
  const near = regions.filter(o => o !== r).map(o => [o.id, km([r.lon, r.lat], [o.lon, o.lat])] as [number, number]).sort((a, b) => a[1] - b[1]).slice(0, 2).filter(x => x[1] < 600);
  r.nb = near.map(x => x[0]); r.seaLinked = true;
  for (const [j] of near) if (!regions[j].nb.includes(r.id)) regions[j].nb.push(r.id);
}
for (const r of regions) delete r._f;
fs.writeFileSync(`${D}/regions.topo.json`, JSON.stringify(topology));
fs.writeFileSync(`${D}/regions.json`, JSON.stringify(regions));

// ---------- relations ----------
const regionId = (c: string, n: string) => regions.filter(r => r.country === c && (n === '*' || r.name === n)).map(r => r.id);
const expand = (xs: string[]) => xs.flatMap(x => x === 'EU' ? cur.blocs.EU.members : [x]);
const relations = {
  blocs: Object.fromEntries(Object.entries(cur.blocs).map(([k, v]: [string, any]) => [k, { type: v.type, members: v.members.filter((m: string) => ISO.has(m)), suspended: v.suspended ?? [] }])),
  defenceTreaties: cur.defence_treaties,
  nuclear: cur.nuclear, p5: cur.unsc_p5, rivalries: cur.rivalries, friendships: cur.friendships, colonial: cur.colonial_ties,
  sanctions: cur.sanctions.flatMap((s: any) => expand(s.by).filter((b: string) => b !== s.target).map((b: string) => ({ by: b, target: s.target, level: s.level, un: !!s.un }))),
  disputes: cur.disputes.map((d: any) => ({ name: d.name, claimants: d.claimants, maritime: !!d.maritime, regions: Object.entries(d.regions).flatMap(([c, ns]: [string, any]) => ns.flatMap((n: string) => regionId(c, n))) })),
  occupations: cur.occupations_at_start.map((o: any) => ({ controller: o.controller, regions: o.regions.flatMap((n: string) => regionId(o.country, n)) })),
  rebels: cur.rebel_control_at_start.map((o: any) => ({ ...o, regions: o.regions.flatMap((n: string) => regionId(o.country, n)) })),
  conflicts: cur.conflicts_at_start.map((c: any) => ({ ...c, front: (c.front ?? []).flatMap((n: string) => regionId(c.sides?.[0]?.[0] ?? '', n)) })),
  chokepoints: cur.chokepoints.map((ch: any) => ({ name: ch.name, oilShare: ch.oil_share, users: ch.users, regions: Object.entries(ch.controllers).flatMap(([c, ns]: [string, any]) => ns.flatMap((n: string) => regionId(c, n))) })),
};
for (const o of cur.occupations_at_start) for (const n of o.regions) if (!regionId(o.country, n).length) curatedNameMiss.push(`occupation ${o.country}:${n}`);
for (const o of cur.rebel_control_at_start) for (const n of o.regions) if (!regionId(o.country, n).length) curatedNameMiss.push(`rebels ${o.country}:${n}`);
fs.writeFileSync(`${D}/relations.json`, JSON.stringify(relations, null, 1));

// ---------- trade (gravity estimate) ----------
// exports(i->j) ∝ GDP_i^0.9 · GDP_j^0.8 / distance × bonuses; scaled so each country's exports ≈ half its trade openness.
const shared = (a: string, b: string, type?: string) => Object.values(relations.blocs).some((bl: any) => (!type || bl.type === type) && bl.members.includes(a) && bl.members.includes(b));
const colonial = (a: string, b: string) => (cur.colonial_ties[a] ?? []).includes(b) || (cur.colonial_ties[b] ?? []).includes(a);
const sanc = new Set(relations.sanctions.map((s: any) => s.by + '>' + s.target));
const trade: Record<string, Record<string, number>> = {};
for (const a of countries) {
  const w: [string, number][] = [];
  for (const b of countries) if (a !== b) {
    const d = Math.max(300, km([a.latlng[1], a.latlng[0]], [b.latlng[1], b.latlng[0]]));
    let x = Math.pow(b.gdp, 0.8) / d;
    if (shared(a.iso3, b.iso3, 'single_market')) x *= 3; else if (shared(a.iso3, b.iso3)) x *= 1.4;
    if (a.borders.includes(b.iso3)) x *= 2;
    if (colonial(a.iso3, b.iso3)) x *= 1.5;
    if (sanc.has(a.iso3 + '>' + b.iso3) || sanc.has(b.iso3 + '>' + a.iso3)) x *= 0.15;
    w.push([b.iso3, x]);
  }
  w.sort((p, q) => q[1] - p[1]);
  const top = w.slice(0, 20), tot = top.reduce((s, p) => s + p[1], 0), exports = a.gdp * (a.tradePctGdp / 100) / 2;
  trade[a.iso3] = Object.fromEntries(top.map(([b, x]) => [b, Math.round(exports * x / tot)]));
}
fs.writeFileSync(`${D}/trade.json`, JSON.stringify(trade));

// ---------- incentives & constitutions (only written if absent, so hand edits survive) ----------
const force = process.argv.includes('--force-incentives');
const factsOf = (c: any): RegimeFacts => ({ system: c.system, polyarchy: c.polyarchy, corruption: c.corruption, federal: c.federal, bicameral: c.bicameral, religion: c.religion, hasMinorities: regions.some(r => r.country === c.iso3 && r.group), age65: c.age65, urban: c.urban, electionYears: c.electionYears });
if (force || !fs.existsSync(`${D}/incentives.json`))
  fs.writeFileSync(`${D}/incentives.json`, JSON.stringify(Object.fromEntries(countries.map(c => [c.iso3, computeIncentives(c.govType, c.polyarchy, c.corruption)])), null, 1));
if (force || !fs.existsSync(`${D}/constitutions.json`))
  fs.writeFileSync(`${D}/constitutions.json`, JSON.stringify(Object.fromEntries(countries.map(c => {
    const k = constitutionTemplate(c.govType, factsOf(c), 'generated template from system type (data/curated.json) + V-Dem score; not from Constitute Project');
    k.preamble = `Constitution of ${c.name}.`; return [c.iso3, k];
  })), null, 1));
for (const c of countries) { c.nextElectionMonths = c.govType === 'absolute_monarchy' || ['onep', 'junta', 'amon'].includes(c.system) ? null : hash(c.iso3) % (c.electionYears * 12); if (c.nextElectionMonths != null) c.estimated.push('nextElection'); delete c.latlng; }
fs.writeFileSync(`${D}/countries.json`, JSON.stringify(countries, null, 1));

// ---------- data-quality report ----------
const lines = [`# Data quality report`, ``, `Generated ${new Date().toISOString().slice(0, 10)} by \`npm run data\`. ${countries.length} countries, ${regions.length} regions (${regions.filter(r => r.point).length} point-only).`, ``,
  `## Sources`, ``, ...Object.values(SOURCES).map(s => `- ${s.what}: \`${s.urls[0]}\``), `- World Bank WDI indicators (API, or bulk CSV fallback): ${Object.values(WDI).join(', ')}`, `- Hand-curated: \`data/curated.json\` (blocs, treaties, disputes, conflicts, sanctions, government systems, minorities, oil/mineral regions, chokepoints)`, ``,
  `## Missing sources`, ``, ...(missingSources.length ? missingSources.map(s => `- ${s}`) : ['- none']), ``,
  `## Country fields: real vs estimated`, ``, `| field | real | estimated | estimated for |`, `|---|---|---|---|`,
  ...Object.entries(quality).map(([k, q]) => `| ${k} | ${q.real} | ${q.est} | ${q.estList.slice(0, 25).join(' ')}${q.estList.length > 25 ? ' …' : ''} |`), ``,
  `## Always estimated (no open source reachable / by design)`, ``,
  `- Region population and GDP share: national totals split by city populations (urban share) and habitable area (rural share).`,
  `- Region terrain from Natural Earth physical regions at the region's label point; jungle = within 8° of the equator.`,
  `- Region resources: curated major oil/gas/mineral regions; otherwise national resource rents spread over the 3 largest regions.`,
  `- Press freedom = International IDEA Media Integrity index; censorship = 100 minus IDEA Freedom of Expression (both 2025, 172 countries). State-media dominance and surveillance capacity are derived from V-Dem polyarchy and income. Microstates missing from IDEA are estimated (drop data/manual/<field>.csv to replace).`,
  `- Bilateral trade: gravity model scaled to each country's trade openness. UN voting alignment: proxied at start from blocs, rivalries and regime similarity.`,
  `- Constitutions: templates from system type, not the Constitute Project (not reachable from the build machine).`,
  `- Next legislative election month: spread pseudo-randomly within the real term length.`, ``,
  `## Curated names not found in Natural Earth (fix in data/curated.json)`, ``, ...(curatedNameMiss.length ? curatedNameMiss.map(s => `- ${s}`) : ['- none']), ``,
  `## V-Dem names not matched`, ``, unmatchedVdem.join(', ') || 'none', ``];
fs.writeFileSync(`${D}/quality-report.md`, lines.join('\n'));
console.log(`done: ${countries.length} countries, ${regions.length} regions, topo ${(fs.statSync(`${D}/regions.topo.json`).size / 1e6).toFixed(1)} MB`);
if (missingSources.length) console.warn('Missing sources:\n - ' + missingSources.join('\n - '));
if (curatedNameMiss.length) console.warn('Curated names not found:', curatedNameMiss.join(', '));
