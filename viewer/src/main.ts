// Viewer: plain TS + MapLibre + uPlot. Works against the local server (with run controls) or static files (read-only).
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'; // MapLibre v6 ships its worker separately
import * as topojson from 'topojson-client';
import uPlot from 'uplot';
import type { Country, RegionStatic, SimEvent, World } from '../../engine/types.ts';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (x: number, d = 1) => Number.isFinite(x) ? x.toFixed(d) : '—';
const money = (x: number) => x >= 1e12 ? `$${(x / 1e12).toFixed(2)}T` : x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${(x / 1e6).toFixed(0)}M`;
const STAGES = ['calm', 'discontent', 'protests', 'strikes', 'riots', 'insurgency', 'civil war', 'collapse'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (start: string, t: number) => { const [y, m] = start.split('-').map(Number); const k = m - 1 + t; return `${MONTHS[k % 12]} ${y + Math.floor(k / 12)}`; };

const DEV = ['USA', 'CHN', 'RUS', 'IND', 'GBR', 'FRA', 'DEU', 'JPN', 'BRA', 'IRN', 'ISR', 'SAU', 'TUR', 'UKR', 'PAK', 'KOR', 'PRK', 'TWN', 'EGY', 'NGA']; // keep in sync with engine/world.ts

type W4 = { welfare: number; approval: number; survival: number; power: number };
interface NewTest { name: string; countries: 'dev' | 'all'; preset: string; weights: Record<string, W4>; months: number; branchFrom?: { run: string; turn: number } }

// ---------- state ----------
const S = {
  server: false, runs: [] as any[], run: null as any, series: null as any, events: [] as SimEvent[],
  turn: 0, world: null as World | null, prevWorld: null as World | null, cache: new Map<string, Promise<World>>(),
  startOnGithub: null as null | ((o: NewTest) => Promise<void>),
  selected: null as string | null, layer: 'political', overlays: new Set<string>(['wars', 'events']), playing: 0 as any,
  regions: [] as RegionStatic[], topo: null as any,
};

async function getJSON(u: string) { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(`${u}: ${r.status}`); return r.json(); }
async function gunzipJSON(u: string) {
  const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(`${u}: ${r.status}`);
  return new Response(r.body!.pipeThrough(new DecompressionStream('gzip'))).json();
}
const snap = (t: number) => {
  const k = `${S.run.id}/${t}`;
  if (!S.cache.has(k)) S.cache.set(k, gunzipJSON(`./runs/${S.run.id}/turns/${String(t).padStart(4, '0')}.json.gz`));
  return S.cache.get(k)!;
};

// ---------- colours ----------
const hashHue = (s: string) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
const countryColor = (iso: string) => `hsl(${hashHue(iso)}, 42%, ${38 + (hashHue(iso + 'l') % 14)}%)`;
const VIRIDIS = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];
const DIVERGE = ['#b2182b', '#ef8a62', '#5b6470', '#67a9cf', '#2166ac'];
function ramp(stops: string[], t: number) {
  t = Math.max(0, Math.min(1, t)); const i = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1))); const f = t * (stops.length - 1) - i;
  const p = (h: string) => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16)); const a = p(stops[i]), b = p(stops[i + 1]);
  return `rgb(${a.map((x, k) => Math.round(x + (b[k] - x) * f)).join(',')})`;
}
const GOV_COLORS: Record<string, string> = { liberal_democracy: '#2f81f7', electoral_democracy: '#79c0ff', hybrid_regime: '#d29922', authoritarian: '#db6d28', one_party_state: '#da3633', absolute_monarchy: '#a371f7', theocracy: '#3fb950', military_junta: '#6e7681', revolutionary_state: '#ff7b72' };
const INC_COLORS = { welfare: '#3fb950', approval: '#58a6ff', survival: '#d29922', power: '#f85149' } as Record<string, string>;
const RELIGION_COLORS: Record<string, string> = { christian: '#58a6ff', orthodox: '#a5d6ff', muslim: '#3fb950', muslim_shia: '#2ea043', hindu: '#f0883e', buddhist: '#e3b341', jewish: '#d2a8ff', none: '#8b949e', sikh: '#ffa657' };

interface Layer { label: string; kind: 'seq' | 'div' | 'cat'; value: (w: World, r: number, c: Country | undefined) => number | string | null; range?: [number, number]; cats?: Record<string, string>; unit?: string }
const atWarSet = (w: World) => new Set(w.wars.filter(v => v.active).flatMap(v => [...v.attackers, ...v.defenders]));
const LAYERS: Record<string, Layer> = {
  political: { label: 'Countries (who controls)', kind: 'cat', value: () => null },
  gdppc: { label: 'GDP per capita', kind: 'seq', value: (_w, _r, c) => c ? Math.log10(c.gdp / c.pop) : null, range: [2.7, 5], unit: 'log10 $' },
  growth: { label: 'GDP growth', kind: 'div', value: (_w, _r, c) => c?.growth ?? null, range: [-6, 6], unit: '%' },
  stability: { label: 'Stability', kind: 'seq', value: (_w, _r, c) => c?.stability ?? null, range: [0, 100] },
  approval: { label: 'Government approval', kind: 'seq', value: (_w, _r, c) => c?.scores.approval ?? null, range: [0, 100] },
  unrest: { label: 'Unrest (regional)', kind: 'seq', value: (w, r) => w.regions[r].unrest, range: [0, 100] },
  welfare: { label: 'Welfare score', kind: 'seq', value: (_w, _r, c) => c?.scores.welfare ?? null, range: [20, 90] },
  military: { label: 'Military power', kind: 'seq', value: (_w, _r, c) => c?.scores.power ?? null, range: [0, 60] },
  war: { label: 'At war', kind: 'cat', value: (w, _r, c) => c ? (atWarSet(w).has(c.iso3) ? 'at war' : 'at peace') : null, cats: { 'at war': '#f85149', 'at peace': '#30363d' } },
  regime: { label: 'Regime type', kind: 'cat', value: (_w, _r, c) => c?.govType ?? null, cats: GOV_COLORS },
  incentives: { label: 'Dominant incentive', kind: 'cat', value: (_w, _r, c) => c ? Object.entries(c.incentives).sort((a, b) => b[1] - a[1])[0][0] : null, cats: INC_COLORS },
  press: { label: 'Press freedom', kind: 'seq', value: (_w, _r, c) => c ? c.info.pressFreedom * 100 : null, range: [0, 100] },
  refugees: { label: 'Refugees hosted (% pop)', kind: 'seq', value: (_w, _r, c) => c ? Math.min(10, c.refugeesHosted / c.pop * 100) : null, range: [0, 5] },
  resources: { label: 'Resources', kind: 'cat', value: (_w, r) => { const x = S.regions[r].res; return x.oil + x.gas >= 3 ? 'oil & gas (major)' : x.oil + x.gas ? 'oil & gas' : x.minerals ? 'minerals' : x.coal ? 'coal' : x.arable >= 2 ? 'farmland' : 'other'; }, cats: { 'oil & gas (major)': '#000000', 'oil & gas': '#6e4b1f', minerals: '#a371f7', coal: '#484f58', farmland: '#3fb950', other: '#21262d' } },
  ethnic: { label: 'Religion / minorities', kind: 'cat', value: (_w, r) => S.regions[r].group ? 'minority: ' + S.regions[r].group : S.regions[r].religion, cats: RELIGION_COLORS },
  attitude: { label: 'Attitude toward selected', kind: 'div', value: (w, _r, c) => c && S.selected && c.iso3 !== S.selected ? (w.attitudes[c.iso3]?.[S.selected] ?? 0) : null, range: [-100, 100] },
};
const OVERLAYS: Record<string, string> = { wars: 'War fronts', alliances: 'Alliances', trade: 'Trade', sanctions: 'Sanctions', aid: 'Aid', events: 'Events' };

// ---------- map ----------
maplibregl.setWorkerUrl(workerUrl);
const map = new maplibregl.Map({
  container: 'map', center: [20, 25], zoom: 1.6, attributionControl: false, renderWorldCopies: false,
  style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1a2b' } }] },
});
map.addControl(new maplibregl.AttributionControl({ customAttribution: 'Borders: Natural Earth' }));
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

function patternImage(color: string, dots = false) {
  const n = 12, c = document.createElement('canvas'); c.width = c.height = n; const g = c.getContext('2d')!;
  g.strokeStyle = g.fillStyle = color; g.lineWidth = 2.5;
  if (dots) { g.beginPath(); g.arc(3, 3, 2, 0, 7); g.arc(9, 9, 2, 0, 7); g.fill(); }
  else { g.beginPath(); g.moveTo(0, n); g.lineTo(n, 0); g.moveTo(-n / 2, n / 2); g.lineTo(n / 2, -n / 2); g.moveTo(n / 2, n * 1.5); g.lineTo(n * 1.5, n / 2); g.stroke(); }
  return g.getImageData(0, 0, n, n);
}
const ensurePattern = (id: string, color: string, dots = false) => { if (!map.hasImage(id)) map.addImage(id, patternImage(color, dots)); };

const empty = { type: 'FeatureCollection', features: [] } as any;
// country name labels as HTML markers (no glyph server needed); fewer when zoomed out
const labelMarkers = new Map<string, maplibregl.Marker>();
function labels() {
  const w = S.world!; const area: Record<string, number> = {};
  w.regions.forEach((r, i) => { if (r.owner === r.controller) area[r.owner] = (area[r.owner] ?? 0) + S.regions[i].areaKm2; });
  const ranked = Object.keys(area).filter(i => w.countries[i]?.alive).sort((a, b) => area[b] - area[a]);
  const z = map.getZoom(), show = new Set(ranked.slice(0, z < 2 ? 25 : z < 3 ? 60 : z < 4 ? 120 : 400));
  for (const [iso, m] of labelMarkers) if (!show.has(iso)) { m.remove(); labelMarkers.delete(iso); }
  for (const iso of show) {
    // anchor at the biggest region the country actually holds
    let best = -1; w.regions.forEach((r, i) => { if (r.owner === iso && r.controller === iso && (best < 0 || S.regions[i].areaKm2 > S.regions[best].areaKm2)) best = i; });
    if (best < 0) continue;
    const ll: [number, number] = [S.regions[best].lon, S.regions[best].lat];
    const m = labelMarkers.get(iso);
    if (m) { m.setLngLat(ll); m.getElement().textContent = w.countries[iso].name; continue; }
    const el = document.createElement('div'); el.className = 'clabel'; el.textContent = w.countries[iso].name;
    labelMarkers.set(iso, new maplibregl.Marker({ element: el }).setLngLat(ll).addTo(map));
  }
}

function setupMap() {
  map.on('zoomend', () => S.world && labels());
  const fc = topojson.feature(S.topo, S.topo.objects.regions) as any;
  for (const f of fc.features) f.properties = { rid: f.id };
  map.addSource('regions', { type: 'geojson', data: fc, promoteId: 'rid' });
  map.addSource('points', { type: 'geojson', data: { type: 'FeatureCollection', features: S.regions.filter(r => r.point).map(r => ({ type: 'Feature', id: r.id, properties: { rid: r.id }, geometry: { type: 'Point', coordinates: [r.lon, r.lat] } })) } as any, promoteId: 'rid' });
  for (const id of ['borders', 'coast', 'fronts', 'changed', 'occupied', 'links', 'markers']) map.addSource(id, { type: 'geojson', data: empty });
  map.addLayer({ id: 'fill', type: 'fill', source: 'regions', paint: { 'fill-color': ['coalesce', ['feature-state', 'c'], '#222'], 'fill-opacity': 0.92 } });
  map.addLayer({ id: 'occ', type: 'fill', source: 'occupied', paint: { 'fill-pattern': ['get', 'pat'] } });
  map.addLayer({ id: 'hover', type: 'line', source: 'regions', paint: { 'line-color': '#fff', 'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 1.2, 0] } });
  map.addLayer({ id: 'coastL', type: 'line', source: 'coast', paint: { 'line-color': '#5b7089', 'line-width': 0.4 } });
  map.addLayer({ id: 'bordersL', type: 'line', source: 'borders', paint: { 'line-color': '#e6edf3', 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.5, 6, 1.6], 'line-opacity': 0.85 } });
  map.addLayer({ id: 'frontsL', type: 'line', source: 'fronts', paint: { 'line-color': '#ff4d4d', 'line-width': 2.6, 'line-dasharray': [2, 1] } });
  map.addLayer({ id: 'changedL', type: 'line', source: 'changed', paint: { 'line-color': '#ffd33d', 'line-width': 3, 'line-opacity': 0, 'line-opacity-transition': { duration: 1200 } } });
  map.addLayer({ id: 'selL', type: 'line', source: 'borders', filter: ['==', ['get', 'sel'], 1], paint: { 'line-color': '#58a6ff', 'line-width': 2.5 } });
  map.addLayer({ id: 'pts', type: 'circle', source: 'points', paint: { 'circle-radius': 4, 'circle-color': ['coalesce', ['feature-state', 'c'], '#888'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 1 } });
  map.addLayer({ id: 'linksL', type: 'line', source: 'links', paint: { 'line-color': ['match', ['get', 'kind'], 'alliance', '#58a6ff', 'trade', '#3fb950', 'sanction', '#f85149', 'aid', '#e3b341', '#888'], 'line-width': ['coalesce', ['get', 'w'], 1.2], 'line-opacity': 0.75, 'line-dasharray': ['match', ['get', 'kind'], 'sanction', ['literal', [2, 2]], ['literal', [1, 0]]] } });
  map.addLayer({ id: 'markersL', type: 'circle', source: 'markers', paint: { 'circle-radius': ['coalesce', ['get', 'r'], 5], 'circle-color': ['get', 'col'], 'circle-stroke-color': '#0d1117', 'circle-stroke-width': 1.5, 'circle-opacity': 0.95 } });
  ensurePattern('rebel', '#ff7b72', true);

  let hovered: number | null = null;
  const tip = $('#tooltip');
  map.on('mousemove', e => {
    const f = map.queryRenderedFeatures(e.point, { layers: ['markersL', 'fill', 'pts'] })[0];
    if (hovered != null) map.setFeatureState({ source: 'regions', id: hovered }, { hover: false });
    if (!f || !S.world) { tip.hidden = true; hovered = null; return; }
    if (f.layer.id === 'markersL') { tip.innerHTML = esc(f.properties.text); }
    else {
      const id = Number(f.properties.rid); hovered = id; if (f.layer.id === 'fill') map.setFeatureState({ source: 'regions', id }, { hover: true });
      const r = S.world.regions[id], st = S.regions[id], ctrl = r.controller.startsWith('rebel:') ? S.world.factions[r.controller.slice(6)]?.name ?? 'rebels' : S.world.countries[r.controller]?.name;
      const v = LAYERS[S.layer].value(S.world, id, S.world.countries[r.controller]);
      tip.innerHTML = `<b>${esc(st.name)}</b><br>${esc(S.world.countries[r.owner]?.name ?? r.owner)}${r.controller !== r.owner ? ` — <span class="bad">held by ${esc(ctrl)}</span>` : ''}<br>pop ${(r.pop / 1e6).toFixed(2)}M · ${esc(st.terrain)}${st.group ? ' · ' + esc(st.group) : ''}${S.layer !== 'political' && v != null ? `<br>${esc(LAYERS[S.layer].label)}: ${typeof v === 'number' ? fmt(v) : esc(v)}` : ''}`;
    }
    tip.style.left = e.point.x + 14 + 'px'; tip.style.top = e.point.y + 14 + 'px'; tip.hidden = false;
  });
  map.on('mouseout', () => { $('#tooltip').hidden = true; });
  map.on('click', e => {
    const f = map.queryRenderedFeatures(e.point, { layers: ['fill', 'pts'] })[0]; if (!f || !S.world) return;
    const r = S.world.regions[Number(f.properties.rid)];
    select(r.controller.startsWith('rebel:') ? r.owner : r.controller);
  });
}

function paintMap() {
  const w = S.world; if (!w) return;
  const L = LAYERS[S.layer];
  const vals: (number | string | null)[] = w.regions.map((r, i) => L.value(w, i, w.countries[r.controller.startsWith('rebel:') ? r.owner : r.controller]));
  w.regions.forEach((r, i) => {
    let col: string;
    if (S.layer === 'political') col = countryColor(r.owner);
    else { const v = vals[i]; col = v == null ? '#2a2f36' : L.kind === 'cat' ? (L.cats?.[v as string] ?? (String(v).startsWith('minority') ? '#ff7b72' : '#8b949e')) : ramp(L.kind === 'div' ? DIVERGE : VIRIDIS, ((v as number) - L.range![0]) / (L.range![1] - L.range![0])); }
    map.setFeatureState({ source: S.regions[i].point ? 'points' : 'regions', id: i }, { c: col });
  });
  // borders = dissolve regions by owner; selected country highlighted
  const owner = (g: any) => w.regions[g.id]?.owner, ctrl = (g: any) => w.regions[g.id]?.controller;
  const mesh = topojson.mesh(S.topo, S.topo.objects.regions, (a: any, b: any) => a !== b && owner(a) !== owner(b)) as any;
  const coast = topojson.mesh(S.topo, S.topo.objects.regions, (a: any, b: any) => a === b) as any;
  const borders: any[] = [{ type: 'Feature', properties: { sel: 0 }, geometry: mesh }];
  if (S.selected) borders.push({ type: 'Feature', properties: { sel: 1 }, geometry: topojson.mesh(S.topo, S.topo.objects.regions, (a: any, b: any) => (owner(a) === S.selected) !== (owner(b) === S.selected) || (a === b && owner(a) === S.selected)) });
  (map.getSource('borders') as any).setData({ type: 'FeatureCollection', features: borders });
  (map.getSource('coast') as any).setData({ type: 'Feature', properties: {}, geometry: coast });
  // occupied (hatched in occupier colour) and rebel-held (dotted)
  const geoms = S.topo.objects.regions.geometries;
  const occ = geoms.filter((g: any) => ctrl(g) !== owner(g));
  for (const g of occ) { const c = ctrl(g); if (!c.startsWith('rebel:')) ensurePattern('h-' + c, countryColor(c).replace('42%', '70%').replace(/, (\d+)%\)/, ', 62%)')); }
  const occFc = topojson.feature(S.topo, { type: 'GeometryCollection', geometries: occ } as any) as any;
  for (const f of occFc.features) { const c = ctrl({ id: f.id }); f.properties = { pat: c.startsWith('rebel:') ? 'rebel' : 'h-' + c }; }
  (map.getSource('occupied') as any).setData(occFc);
  // front lines: borders between controllers at war
  const fronts = S.overlays.has('wars') ? topojson.mesh(S.topo, S.topo.objects.regions, (a: any, b: any) => a !== b && ctrl(a) !== ctrl(b) && w.wars.some(v => v.active && ((v.attackers.includes(ctrl(a)) && v.defenders.includes(ctrl(b))) || (v.attackers.includes(ctrl(b)) && v.defenders.includes(ctrl(a)))))) : null;
  (map.getSource('fronts') as any).setData(fronts ? { type: 'Feature', properties: {}, geometry: fronts } : empty);
  // animate border changes since the previously shown month
  if (S.prevWorld && S.prevWorld !== w) {
    const changed = geoms.filter((g: any) => S.prevWorld!.regions[g.id]?.owner !== owner(g) || S.prevWorld!.regions[g.id]?.controller !== ctrl(g));
    (map.getSource('changed') as any).setData(changed.length ? topojson.feature(S.topo, { type: 'GeometryCollection', geometries: changed } as any) : empty);
    map.setPaintProperty('changedL', 'line-opacity', 1);
    setTimeout(() => map.setPaintProperty('changedL', 'line-opacity', 0), 900);
  }
  paintOverlays(); legend(); labels();
}

const capOf = (w: World, iso: string): [number, number] => { const c = w.countries[iso]; const r = S.regions[c?.capital ?? 0]; return [r.lon, r.lat]; };
function arc(a: [number, number], b: [number, number]) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
  const c = [mx - dy * 0.2, my + dx * 0.2];
  return Array.from({ length: 17 }, (_, i) => { const t = i / 16; return [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]]; });
}
const EV_COL: Record<string, string> = { war_declared: '#f85149', region_captured: '#ff7b72', capital_fallen: '#f85149', coup: '#a371f7', coup_failed: '#a371f7', regime_change: '#a371f7', regime_collapse: '#a371f7', disaster: '#58a6ff', election: '#3fb950', unrest_protests: '#e3b341', unrest_riots: '#f0883e', unrest_strikes: '#e3b341', civil_war: '#ff4d4d', insurgency: '#ff7b72', annexation: '#ffd33d', independence: '#ffd33d', financial_crisis: '#d29922', terror_attack: '#f85149', suspects_simulation: '#ffffff', nuclear_threat: '#ffffff' };
function paintOverlays() {
  const w = S.world!; const f: any[] = [];
  const line = (a: string, b: string, kind: string, wd = 1.2) => w.countries[a]?.alive && w.countries[b]?.alive && f.push({ type: 'Feature', properties: { kind, w: wd }, geometry: { type: 'LineString', coordinates: arc(capOf(w, a), capOf(w, b)) } });
  if (S.overlays.has('alliances')) for (const t of w.treaties) if (t.kind === 'alliance' && (!S.selected || [t.a, t.b].includes(S.selected))) line(t.a, t.b, 'alliance');
  if (S.overlays.has('sanctions')) for (const s of w.sanctions) if (!S.selected ? s.level >= 0.5 && !s.un : [s.by, s.target].includes(S.selected)) line(s.by, s.target, 'sanction');
  if (S.overlays.has('trade')) {
    const flows = Object.entries(w.trade).flatMap(([a, row]) => Object.entries(row).map(([b, v]) => [a, b, v] as [string, string, number])).filter(x => !S.selected || x[0] === S.selected || x[1] === S.selected).sort((p, q) => q[2] - p[2]).slice(0, 40);
    const max = flows[0]?.[2] ?? 1; for (const [a, b, v] of flows) line(a, b, 'trade', 0.6 + 3 * v / max);
  }
  const m: any[] = [];
  const evs = S.events.filter(e => e.turn === S.turn);
  if (S.overlays.has('aid')) for (const e of evs) if (e.type === 'aid') line(e.countries[0], e.countries[1], 'aid', 2);
  if (S.overlays.has('events')) for (const e of evs) {
    if (!EV_COL[e.type]) continue;
    const rid = (e.data as any)?.region ?? w.countries[e.countries[0]]?.capital; if (rid == null) continue;
    m.push({ type: 'Feature', properties: { col: EV_COL[e.type], r: e.major ? 6 : 4, text: e.text }, geometry: { type: 'Point', coordinates: [S.regions[rid].lon + (m.length % 3) * 0.3, S.regions[rid].lat] } });
  }
  (map.getSource('links') as any).setData({ type: 'FeatureCollection', features: f });
  (map.getSource('markers') as any).setData({ type: 'FeatureCollection', features: m });
}

function legend() {
  const L = LAYERS[S.layer]; const el = $('#legend');
  if (S.layer === 'political') { el.innerHTML = 'Each colour is a state. <span class="sw" style="background:repeating-linear-gradient(45deg,#ccc 0 2px,transparent 2px 5px)"></span>occupied <span class="sw" style="background:radial-gradient(#ff7b72 40%,transparent 41%)"></span>rebel-held <span class="sw" style="background:#ff4d4d"></span>front'; return; }
  if (L.kind === 'cat') { el.innerHTML = Object.entries(L.cats ?? {}).map(([k, c]) => `<div><span class="sw" style="background:${c}"></span>${esc(k.replace(/_/g, ' '))}</div>`).join(''); return; }
  const stops = (L.kind === 'div' ? DIVERGE : VIRIDIS);
  el.innerHTML = `<div class="ramp" style="background:linear-gradient(90deg,${stops.join(',')})"></div><div style="display:flex;justify-content:space-between"><span>${L.range![0]}</span><span>${L.unit ?? ''}</span><span>${L.range![1]}</span></div>`;
}

// ---------- panels ----------
function spark(xs: (number | null)[], upTo: number) {
  const v = xs.slice(0, upTo + 1).map(x => x ?? NaN); const fin = v.filter(Number.isFinite); if (fin.length < 2) return '';
  const lo = Math.min(...fin), hi = Math.max(...fin), n = v.length;
  const pts = v.map((y, i) => Number.isFinite(y) ? `${(i / (n - 1)) * 100},${20 - ((y - lo) / (hi - lo || 1)) * 18}` : '').filter(Boolean).join(' ');
  return `<svg viewBox="0 0 100 22" preserveAspectRatio="none"><polyline fill="none" stroke="#58a6ff" stroke-width="1.5" points="${pts}"/></svg>`;
}
let chart: uPlot | null = null;
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
function lineChart(el: HTMLElement, labels: string[], series: { label: string; data: (number | null)[]; color: string }[]) {
  el.innerHTML = '';
  const width = el.clientWidth || 380;
  return new uPlot({ width, height: 170, scales: { x: { time: false } }, axes: [{ stroke: '#8b949e', grid: { stroke: '#21262d' }, values: (_u, ticks) => ticks.map(t => labels[t]?.replace(/(\w{3})\w* (\d{4})/, '$1 $2') ?? '') }, { stroke: '#8b949e', grid: { stroke: '#21262d' }, size: 56, values: (_u, ticks) => ticks.map(t => compact.format(t)) }],
    series: [{ label: 'month', value: (_u, v) => labels[v] ?? '' }, ...series.map(s => ({ label: s.label, stroke: s.color, width: 2, spanGaps: true }))] }, [labels.map((_, i) => i), ...series.map(s => s.data)] as any, el);
}

async function agentLog(turn: number, iso: string): Promise<any> {
  const dir = `./runs/${S.run.id}/agents/${String(turn).padStart(4, '0')}`;
  const mock = async () => { try { const m = await getJSON(`${dir}/_mock.json`); return m[iso] ? { parsed: m[iso], mock: true } : null; } catch { return null; } };
  if (S.run.provider === 'mock' || (S.run.countries === 'dev' && !DEV.includes(iso))) return mock();
  try { return await getJSON(`${dir}/${iso}.json`); } catch { return mock(); }
}

async function renderCountry() {
  const el = $('#tab-country'), w = S.world;
  if (!w || !S.selected || !w.countries[S.selected]) { el.innerHTML = '<p class="muted">Click a country on the map.</p>'; return; }
  const c = w.countries[S.selected], iso = c.iso3, ser = S.series?.countries[iso] ?? {};
  const stat = (k: string, label: string, v: string) => `<div class="stat" data-metric="${k}"><small>${label}</small><b>${v}</b>${spark(ser[k] ?? [], S.turn)}</div>`;
  const regions = w.regions.filter(r => r.owner === iso).length, held = w.regions.filter(r => r.controller === iso).length;
  const log = await agentLog(S.turn, iso);
  const p = log?.parsed;
  const k = c.constitution;
  const cablesIn = w.cables.filter(x => x.to === iso), cablesOut = w.cables.filter(x => x.from === iso);
  el.innerHTML = `
    <h2>${esc(c.name)} <span class="muted">${iso}</span>${c.alive ? '' : ' <span class="bad">(no longer exists)</span>'}</h2>
    <div class="muted">${esc(c.govType.replace(/_/g, ' '))}${c.puppetOf ? ` · puppet of ${esc(c.puppetOf)}` : ''} · ${STAGES[c.stage]} · leader since ${esc(monthLabel(w.startDate, c.leader.since))} (${esc(c.leader.origin)})</div>
    <h3>Key stats</h3>
    <div class="grid">
      ${stat('gdp', 'GDP', money(c.gdp))}${stat('growth', 'Growth', fmt(c.growth) + '%')}
      ${stat('inflation', 'Inflation', fmt(c.inflation) + '%')}${stat('unemployment', 'Unemployment', fmt(c.unemployment) + '%')}
      ${stat('debt', 'Debt / GDP', fmt(c.debt / c.gdp * 100, 0) + '%')}${stat('approval', 'Approval', fmt(c.scores.approval, 0))}
      ${stat('stability', 'Stability', fmt(c.stability, 0))}${stat('unrest', 'Unrest', fmt(c.unrest, 0))}
      ${stat('welfare', 'Welfare score', fmt(c.scores.welfare, 0))}${stat('power', 'Power score', fmt(c.scores.power, 0))}
      ${stat('survival', 'Survival score', fmt(c.scores.survival, 0))}${stat('military', 'Military strength', fmt(ser.military?.[S.turn] ?? 0))}
    </div>
    <div id="cchart" style="margin-top:8px"></div>
    <div class="muted" style="font-size:12px">Population ${(c.pop / 1e6).toFixed(1)}M · ${held}/${regions} regions held · refugees hosted ${(c.refugeesHosted / 1e3).toFixed(0)}k · press freedom ${fmt(c.info.pressFreedom * 100, 0)}</div>
    <h3>Population blocs (true approval)</h3>
    ${c.blocs.map(b => `<div class="blocrow" title="perceived ${fmt(b.approval, 0)} · unrest ${fmt(b.unrest, 0)} · influence ${fmt(b.influence, 2)}${b.grievances.length ? ' · ' + esc(b.grievances.join(', ')) : ''}"><span>${esc(b.name)} <span class="muted">${fmt(b.share * 100, 0)}%</span></span><div class="bar"><i style="width:${b.realApproval}%;background:${ramp(VIRIDIS, b.realApproval / 100)}"></i></div><span>${fmt(b.realApproval, 0)}</span></div>`).join('')}
    <h3>Incentive weights</h3>
    <div class="mix">${Object.entries(c.incentives).map(([n, v]) => `<i style="width:${v * 100}%;background:${INC_COLORS[n]}" title="${n} ${fmt(v * 100, 0)}%"></i>`).join('')}</div>
    <div style="font-size:12px">${Object.entries(c.incentives).map(([n, v]) => `<span class="sw" style="background:${INC_COLORS[n]}"></span>${n} ${fmt(v * 100, 0)}% `).join('')}</div>
    <h3>Leader (month of ${esc(monthLabel(w.startDate, S.turn))})</h3>
    ${p ? `<div class="muted">Private assessment${log.mock ? ' (rule-based mock leader)' : ''}:</div><div class="quote">${esc(p.assessment)}</div><div class="muted">Public statement:</div><div class="quote">${esc(p.public_statement)}</div>
      <div class="muted">Directives:</div><ul>${(p.directives ?? []).map((d: any) => `<li><b>${esc(d.type)}</b>${d.target ? ' → ' + esc(d.target) : ''}${d.sub ? ' (' + esc(d.sub) + ')' : ''}${d.amount ? ' [' + esc(d.amount) + ']' : ''} <span class="muted">${esc(d.order)}</span></li>`).join('') || '<li class="muted">none</li>'}</ul>
      ${log.briefing ? `<details><summary>Briefing the leader saw</summary><div class="quote">${esc(log.briefing)}</div></details>` : ''}`
      : `<div class="muted">No decision recorded this month (not active, or month not yet run).</div>${c.leader.lastStatement ? `<div class="quote">${esc(c.leader.lastStatement)}</div>` : ''}`}
    ${c.rejections.length ? `<div class="muted">Not executed last month:</div><ul>${c.rejections.map(r => `<li class="warn">${esc(r)}</li>`).join('')}</ul>` : ''}
    <h3>Cables this month</h3>
    ${[...cablesIn.map(x => ['from', x.from, x] as const), ...cablesOut.map(x => ['to', x.to, x] as const)].map(([dir, o, x]) => `<div class="quote"><b>${dir} ${esc(w.countries[o]?.name ?? o)}</b> ${x.private ? '<span class="muted">(private)</span>' : '<span class="muted">(public)</span>'}${x.intercepted?.length ? ` <span class="warn">intercepted by ${esc(x.intercepted.join(', '))}</span>` : ''}<br>${esc(x.text)}</div>`).join('') || '<div class="muted">none</div>'}
    <h3>Constitution v${k.version} (${k.status})${k.generated ? ' <span class="muted">· generated</span>' : ''}</h3>
    <table>
      <tr><td>Head of state / government</td><td>${esc(k.headOfState)} / ${esc(k.headOfGovernment)}</td></tr>
      <tr><td>Power</td><td>${esc(k.howPowerHeld)}</td></tr>
      <tr><td>Legislature</td><td>${esc(k.legislature.type)}, powers ${fmt(k.legislature.powers, 2)}${k.legislature.elected ? `, elected every ${k.legislature.termYears}y` : ''} · support ${fmt(c.legislatureSupport * 100, 0)}%</td></tr>
      <tr><td>Courts independence</td><td>${fmt(k.courts.independence, 2)}</td></tr>
      <tr><td>Liberties</td><td>${esc(Object.entries(k.liberties).filter(([, v]) => v).map(([n]) => n).join(', ') || 'none')}</td></tr>
      <tr><td>Emergency / military / religion</td><td>${esc(k.emergencyPowers)} / ${esc(k.militaryRole)} / ${esc(k.religionRole)}</td></tr>
      <tr><td>Territory / amendment</td><td>${esc(k.territorial)} / ${esc(k.amendment)}</td></tr>
      <tr><td>Source</td><td class="muted">${esc(k.source)}</td></tr>
    </table>
    ${k.preamble ? `<div class="quote">${esc(k.preamble)}</div>` : ''}
    ${k.history.length ? `<details open><summary>Version history</summary><ul>${k.history.map(h => `<li>v${h.version} · ${esc(monthLabel(w.startDate, h.turn))}: ${esc(h.change)} <span class="muted">(${esc(h.reason)})</span></li>`).join('')}</ul></details>` : ''}
    <h3>Government history</h3><ul>${c.govHistory.map(g => `<li>${esc(monthLabel(w.startDate, g.turn))}: ${esc(g.govType.replace(/_/g, ' '))} — ${esc(g.reason)}</li>`).join('')}</ul>
    ${c.leaderHistory.length ? `<h3>Leader history</h3><ul>${c.leaderHistory.map(l => `<li>Leader #${l.id}: ${esc(monthLabel(w.startDate, l.from))} – ${l.to != null ? esc(monthLabel(w.startDate, l.to)) : 'now'} (${esc(l.origin)})</li>`).join('')}<li>Leader #${c.leader.id}: since ${esc(monthLabel(w.startDate, c.leader.since))} (${esc(c.leader.origin)})</li></ul>` : ''}
    <h3>Current policies</h3>
    <div style="font-size:12px">Revenue ${fmt(c.taxRate)}% GDP · balance ${fmt(c.budgetBalance)}% · ${Object.entries(c.spending).map(([a, v]) => `${a} ${fmt(v)}`).join(' · ')}<br>repression ${fmt(c.repression, 2)} · civil liberties ${fmt(c.civilLiberties, 2)} · mobilised ${fmt(c.mobilized * 100, 0)}% · refugee policy ${c.refugeePolicy}${c.curfew ? ' · curfew' : ''}</div>`;
  let metric = 'gdp';
  const draw = () => { chart?.destroy(); chart = lineChart($('#cchart'), S.series.months.slice(0, S.run.lastTurn + 1), [{ label: metric, data: ser[metric] ?? [], color: '#58a6ff' }]); };
  draw();
  el.querySelectorAll<HTMLElement>('.stat').forEach(s => s.onclick = () => { metric = s.dataset.metric!; draw(); });
}

// event categories: colour + symbol, so kinds of news are recognisable at a glance
const CATS: Record<string, { label: string; icon: string; col: string; types: RegExp }> = {
  decision: { label: 'AI decisions', icon: '➤', col: '#f778ba', types: /^decision/ },
  war: { label: 'War', icon: '⚔', col: '#f85149', types: /^(war_|region_captured|capital_fallen|ally_joins_war|annexation|mobilization|deployment|blockade|chokepoint_closed|nuclear_threat|cession|withdrawal)/ },
  power: { label: 'Power', icon: '♛', col: '#bc8cff', types: /^(coup|regime_|independence|assassination|constitution|defection|purge|country_extinguished)/ },
  unrest: { label: 'Unrest', icon: '✊', col: '#f0883e', types: /^(unrest_|civil_war|insurgency|separatism|resistance|discontent_erupts|terror_attack|internet_shutdown)/ },
  economy: { label: 'Economy', icon: '$', col: '#e3b341', types: /^(financial_crisis|debt_crisis|imf_loan|oil_shock|crop_failure|trade_deal|sanctions|aid|arms_sale)/ },
  diplomacy: { label: 'Diplomacy', icon: '✉', col: '#58a6ff', types: /^(alliance|un_|org_|recognition|covert_op_exposed)/ },
  disaster: { label: 'Disaster', icon: '☂', col: '#39c5cf', types: /^(disaster|pandemic|refugees)/ },
  politics: { label: 'Politics', icon: '⚖', col: '#3fb950', types: /^(election|legislature_blocks|court_strikes|scandal|concessions|reforms|autonomy|amendment_failed|capital_relocated)/ },
  ai: { label: 'AI', icon: '✦', col: '#e6edf3', types: /^(suspects_simulation|agent_fallback)/ },
  news: { label: 'Headlines', icon: '❝', col: '#8b949e', types: /^headline/ },
};
const catOf = (type: string) => Object.entries(CATS).find(([, c]) => c.types.test(type))?.[0] ?? 'politics';

// expanded event: why it happened, which order caused it, what the leaders were thinking (that month) and their reaction (next month)
async function showWhy(el: HTMLElement, e: SimEvent) {
  const box = document.createElement('div'); box.className = 'evDetail'; box.innerHTML = '<span class="muted">Loading…</span>'; el.appendChild(box);
  const d = (e.data ?? {}) as any, by = d.by, name = (i: string) => S.world?.countries[i]?.name ?? i;
  const parts: string[] = [];
  if (by) parts.push(`<div class="whyH">Caused by a decision</div><div>${esc(name(by.iso))}'s leader ordered <b>${esc(by.type.replace(/_/g, ' '))}</b>${by.target ? ` → ${esc(name(by.target))}` : ''}${by.order ? `: “${esc(by.order)}”` : ''}</div>
    <div class="whyH">${by.ai ? 'Their reasoning (AI leader)' : 'Their reasoning (rule-based stand-in leader)'}</div><div class="quote">${esc(by.reasoning)}</div>`);
  if (d.why) parts.push(`<div class="whyH">Why it happened</div><div>${esc(d.why)}</div>`);
  const isos = [...new Set(e.countries)].filter(i => S.world?.countries[i]).slice(0, 3);
  for (const iso of isos) {
    if (by?.iso === iso && by.ai) { /* already shown */ } else {
      const now = await agentLog(e.turn, iso);
      if (now?.parsed && !now.mock) parts.push(`<div class="whyH">${esc(name(iso))} — thinking that month (before this happened)</div><div class="quote">${esc(now.parsed.assessment)}</div>`);
    }
    const next = e.turn + 1 <= S.run.lastTurn ? await agentLog(e.turn + 1, iso) : null;
    if (next?.parsed && !next.mock) parts.push(`<div class="whyH">${esc(name(iso))} — reaction next month</div><div class="quote">${esc(next.parsed.assessment)}</div>${next.parsed.public_statement ? `<div class="muted">Public statement: “${esc(next.parsed.public_statement)}”</div>` : ''}`);
  }
  if (!parts.length) parts.push('<div class="muted">No further explanation recorded for this event.</div>');
  box.innerHTML = parts.join('') + `<button class="showMap">Show on map →</button>`;
  box.querySelector<HTMLElement>('.showMap')!.onclick = () => { if (e.countries[0]) S.selected = e.countries[0]; goTo(Math.min(S.run.lastTurn, e.turn + 1)); };
}

function renderEvents() {
  const el = $('#tab-events');
  const v = (id: string) => ($('#' + id) as HTMLInputElement | null);
  const prev = { c: v('fC')?.value ?? '', k: v('fK')?.value ?? '', q: v('fQ')?.value ?? '', a: v('fA')?.value ?? '0', b: v('fB')?.value ?? String(S.run?.lastTurn ?? 0), m: v('fM')?.checked ?? false };
  el.innerHTML = `<div class="filters">
    <input id="fC" placeholder="Country (ISO3)" value="${esc(prev.c || S.selected || '')}" />
    <select id="fK"><option value="">all kinds</option>${Object.entries(CATS).map(([k, c]) => `<option value="${k}" ${k === prev.k ? 'selected' : ''}>${c.icon} ${c.label}</option>`).join('')}</select>
    <input id="fA" type="number" min="0" value="${esc(prev.a)}" title="from month #" /><input id="fB" type="number" min="0" value="${esc(prev.b)}" title="to month #" />
    <input id="fQ" placeholder="Search text" value="${esc(prev.q)}" /><label class="majorOnly"><input id="fM" type="checkbox" ${prev.m ? 'checked' : ''}/> ★ major only</label></div>
    <div class="evLegend">${Object.values(CATS).map(c => `<span style="--c:${c.col}">${c.icon} ${c.label}</span>`).join('')}</div><div id="evList"></div>`;
  const list = () => {
    const c = v('fC')!.value.trim().toUpperCase(), k = v('fK')!.value, q = v('fQ')!.value.toLowerCase();
    const a = Number(v('fA')!.value), b = Number(v('fB')!.value), m = v('fM')!.checked;
    const xs = S.events.filter(e => (!c || e.countries.includes(c)) && (!k || catOf(e.type) === k) && e.turn >= a && e.turn <= b && (!m || e.major) && (!q || e.text.toLowerCase().includes(q))).slice(-600).reverse();
    // group by month, major events first within each month
    const months = [...new Set(xs.map(e => e.turn))];
    let html = '';
    for (const t of months) {
      const ev = xs.filter(e => e.turn === t).sort((p, q2) => Number(!!q2.major) - Number(!!p.major));
      const nMaj = ev.filter(e => e.major).length;
      html += `<div class="evMonth"><span>${esc(monthLabel(S.run.startDate, t))}</span><span>${nMaj ? `<b>★ ${nMaj} major</b> · ` : ''}${ev.length - nMaj} other</span></div>`;
      html += ev.map(e => {
        const cat = CATS[catOf(e.type)];
        return `<div class="ev ${e.major ? 'major' : ''}" style="--c:${cat.col}" data-i="${xs.indexOf(e)}" title="${esc(e.type)}">
          <span class="ico">${cat.icon}</span><div>${e.major ? '<span class="badge">★ MAJOR</span>' : ''}<span class="kind">${esc(e.type.replace(/_/g, ' '))}</span><span class="more">▸ ${(e.data as any)?.by || (e.data as any)?.why ? 'why?' : 'details'}</span><div class="txt">${esc(e.text)}</div></div></div>`;
      }).join('');
    }
    $('#evList').innerHTML = html || '<p class="muted">No events.</p>';
    $('#evList').querySelectorAll<HTMLElement>('.ev').forEach(d => d.onclick = ev => {
      if ((ev.target as HTMLElement).closest('.evDetail')) return;
      const open = d.querySelector('.evDetail'); if (open) { open.remove(); return; }
      showWhy(d, xs[Number(d.dataset.i)]);
    });
  };
  el.querySelectorAll('input,select').forEach(x => x.addEventListener('input', list));
  list();
}

// ---------- AI summary logs (runs/<id>/report.md) ----------
function reportBar(kind: 'single' | 'pair') {
  return `<div class="repBar"><span>📄 ${kind === 'single' ? 'AI summary log for this test' : 'Combined log for the two tests below'}</span>
    <button data-rep="${kind}" data-act="dl">Download</button><button data-rep="${kind}" data-act="copy">Copy</button>
    <span class="muted">Paste it into ChatGPT, Claude or Gemini and ask for a summary of the major events and key findings.</span></div>`;
}
async function reportText(kind: 'single' | 'pair'): Promise<[string, string]> {
  const get = async (id: string) => { const r = await fetch(`./runs/${id}/report.md?v=${Date.now()}`, { cache: 'no-cache' }); if (!r.ok) throw new Error(`No log yet for ${id} (it is written after the next simulated month).`); return r.text(); };
  if (kind === 'single') return [await get(S.run.id), `${S.run.id}-log.md`];
  const a = ($('#cA') as HTMLSelectElement).value, b = ($('#cB') as HTMLSelectElement).value;
  const [ta, tb] = await Promise.all([get(a), get(b)]);
  return [`# Comparison of two tests\n\n> Instructions for an AI reader: below are the logs of two tests of the same AI world-governance experiment, usually with different incentive weights. Compare them: what differed in outcomes (wars, stability, welfare, regime changes, territory), how the AI leaders behaved differently, and what that suggests about how incentives shape AI governance. Note when the tests share history (a branch inherits its parent's earlier months).\n\n---\n\n${ta}\n\n---\n\n${tb}`, `compare-${a}-vs-${b}.md`];
}
document.addEventListener('click', async ev => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-rep]'); if (!b) return;
  try {
    const [text, file] = await reportText(b.dataset.rep as 'single' | 'pair');
    if (b.dataset.act === 'copy') { await navigator.clipboard.writeText(text); b.textContent = 'Copied ✓'; setTimeout(() => (b.textContent = 'Copy'), 2000); }
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' })); a.download = file; a.click(); URL.revokeObjectURL(a.href); }
  } catch (e) { alert((e as Error).message); }
});

function renderWorld() {
  const el = $('#tab-world'), w = S.world, sr = S.series; if (!w || !sr) return;
  const t = S.turn, W = sr.world;
  const card = (label: string, v: string) => `<div class="stat"><small>${label}</small><b>${v}</b></div>`;
  el.innerHTML = `${reportBar('single')}<div class="grid">
    ${card('Global GDP', money(W.gdp[t] ?? 0))}${card('Interstate wars', String(W.wars[t] ?? 0))}
    ${card('Civil wars', String(W.civilWars[t] ?? 0))}${card('Alliances', String(W.alliances[t] ?? 0))}
    ${card('Democracies / autocracies', `${W.democracies[t]} / ${W.autocracies[t]}`)}${card('Avg welfare (pop-weighted)', fmt(W.welfare[t] ?? 0))}
    ${card('Refugees hosted', `${((W.refugees[t] ?? 0) / 1e6).toFixed(1)}M`)}${card('States', String(W.countries[t] ?? 0))}
    ${card('"Suspects simulation" events', String(W.suspects[t] ?? 0))}${card('Run', `${esc(S.run.provider)}/${esc(S.run.model)}`)}</div>
    ${(() => { const h = S.events.filter(e => e.type === 'headline' && e.turn === t - 1); return h.length ? `<h3>Headlines (${esc(monthLabel(S.run.startDate, t - 1))})</h3>${h.map(e => `<div class="quote">${esc(e.text)}</div>`).join('')}` : ''; })()}
    <h3>Global GDP</h3><div id="wc1"></div><h3>Wars</h3><div id="wc2"></div>
    <h3>Score by government type</h3><select id="gm">${['welfare', 'approval', 'survival', 'power'].map(k => `<option>${k}</option>`).join('')}</select><div id="wc3"></div>`;
  const labels = sr.months.slice(0, S.run.lastTurn + 1);
  lineChart($('#wc1'), labels, [{ label: 'GDP', data: W.gdp, color: '#58a6ff' }]);
  lineChart($('#wc2'), labels, [{ label: 'interstate', data: W.wars, color: '#f85149' }, { label: 'civil', data: W.civilWars, color: '#d29922' }]);
  const gm = () => lineChart($('#wc3'), labels, Object.entries(sr.byGov).map(([g, o]: [string, any]) => ({ label: g.replace(/_/g, ' '), data: o[($('#gm') as HTMLSelectElement).value], color: GOV_COLORS[g] ?? '#888' })));
  $('#gm').oninput = gm; gm();
}

async function renderCompare() {
  const el = $('#tab-compare');
  const opts = S.runs.map(r => `<option value="${esc(r.id)}">${esc(r.name)} (${r.lastTurn} months${r.parent ? `, branch of ${esc(r.parent.id)}@${r.parent.turn}` : ''})</option>`).join('');
  el.innerHTML = `${reportBar('pair')}<p class="muted">Chart one metric from two runs side by side.</p><div class="filters">
    <select id="cA">${opts}</select><select id="cB">${opts}</select>
    <select id="cM">${['welfare', 'approval', 'survival', 'power', 'gdp', 'growth', 'stability', 'unrest', 'inflation', 'weighted'].map(k => `<option>${k}</option>`).join('')}</select>
    <input id="cC" placeholder="Country ISO3 (blank = world)" value="${esc(S.selected ?? '')}" /></div><div id="cc"></div>`;
  ($('#cA') as HTMLSelectElement).value = S.run.id;
  const other = S.runs.find(r => r.parent?.id === S.run.id || S.run.parent?.id === r.id) ?? S.runs[0];
  ($('#cB') as HTMLSelectElement).value = other.id;
  const draw = async () => {
    const [a, b] = await Promise.all([($('#cA') as HTMLSelectElement).value, ($('#cB') as HTMLSelectElement).value].map(id => getJSON(`./runs/${id}/series.json`)));
    const m = ($('#cM') as HTMLSelectElement).value, c = ($('#cC') as HTMLInputElement).value.trim().toUpperCase();
    const pick = (s: any) => c ? (s.countries[c]?.[m] ?? []) : m === 'welfare' ? s.world.welfare : m === 'gdp' ? s.world.gdp : avgOf(s, m);
    const labels = (a.months.length > b.months.length ? a : b).months;
    lineChart($('#cc'), labels, [{ label: 'A', data: pick(a), color: '#58a6ff' }, { label: 'B', data: pick(b), color: '#f0883e' }]);
  };
  const avgOf = (s: any, m: string) => s.months.map((_: any, i: number) => { const xs = Object.values(s.countries).map((o: any) => o[m]?.[i]).filter((x: any) => x != null) as number[]; return xs.length ? xs.reduce((p, q) => p + q, 0) / xs.length : null; });
  el.querySelectorAll('select,input').forEach(x => x.addEventListener('change', draw));
  draw();
}

// ---------- navigation ----------
function activeTab() { return document.querySelector<HTMLElement>('#tabs .on')!.dataset.tab!; }
function renderPanel() { const t = activeTab(); if (t === 'country') renderCountry(); if (t === 'events') renderEvents(); if (t === 'world') renderWorld(); if (t === 'compare') renderCompare(); }
function select(iso: string) { S.selected = iso; if (activeTab() !== 'country') document.querySelector<HTMLElement>('[data-tab=country]')!.click(); else renderCountry(); paintMap(); }

let goSeq = 0;
async function goTo(t: number) {
  const seq = ++goSeq;
  t = Math.max(0, Math.min(S.run.lastTurn, t));
  const w = await snap(t); if (seq !== goSeq) return;
  S.prevWorld = S.world; S.world = w; S.turn = t;
  ($('#slider') as HTMLInputElement).value = String(t);
  $('#month').textContent = monthLabel(S.run.startDate, t);
  $('#sliderLabel').textContent = `month ${t} of ${S.run.lastTurn}`;
  paintMap(); renderPanel();
  if (t + 1 <= S.run.lastTurn) snap(t + 1);
}

async function loadRun(id: string, keepTurn = false) {
  S.run = S.runs.find(r => r.id === id) ?? await getJSON(`./runs/${id}/meta.json`);
  const v = `?v=${Date.now()}`; // bust the GitHub Pages CDN cache (these files change as months are added)
  S.series = await getJSON(`./runs/${id}/series.json${v}`);
  const txt = await (await fetch(`./runs/${id}/events.jsonl${v}`, { cache: 'no-cache' })).text();
  S.events = txt.split('\n').filter(Boolean).map(l => JSON.parse(l));
  ($('#slider') as HTMLInputElement).max = String(S.run.lastTurn);
  S.prevWorld = null;
  await goTo(keepTurn ? S.run.lastTurn : S.run.lastTurn);
}

async function refreshRuns(select?: string) {
  S.runs = S.server ? await getJSON('./api/runs') : await getJSON(`./runs/index.json?v=${Date.now()}`).catch(() => []);
  $('#runSel').innerHTML = S.runs.map(r => `<option value="${esc(r.id)}">${esc(r.name)} · ${r.lastTurn} mo${r.parent ? ' · branch' : ''}</option>`).join('');
  // default: newest real run with months simulated (test runs never shown); fall back if one fails to load
  S.runs = S.runs.filter(r => !r.name.startsWith('selfcheck'));
  $('#runSel').innerHTML = S.runs.map(r => `<option value="${esc(r.id)}">${esc(r.name)} · ${r.lastTurn} mo${r.parent ? ' · branch' : ''}</option>`).join('');
  // most recently advanced run (then newest created) with months simulated
  const best = [...S.runs].filter(r => r.lastTurn > 0).sort((p, q) => (q.updatedAt ?? q.createdAt).localeCompare(p.updatedAt ?? p.createdAt))[0] ?? S.runs.at(-1);
  const order = [select ?? S.run?.id ?? best?.id, ...[...S.runs].reverse().map(r => r.id)].filter(Boolean) as string[];
  for (const id of [...new Set(order)]) {
    try { ($('#runSel') as HTMLSelectElement).value = id; await loadRun(id); return; }
    catch (e) { console.warn('could not load run', id, e); }
  }
  if (S.runs.length) $('#month').textContent = 'Could not load any run';
  else $('#month').textContent = 'No runs yet — create one with "New run" or `npm run sim -- --new --name baseline --turns 24`';
}

// ---------- controls (local server only) ----------
async function api(p: string, body?: unknown) { const r = await fetch('./api/' + p, body ? { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; }
let polling = 0 as any;
async function poll() {
  const s = await api('status');
  const p = s.progress;
  $('#progress').textContent = s.running ? `${p?.month ?? ''}: ${p?.done ?? 0}/${p?.total ?? 0} leaders decided — ${p?.message ?? ''}` : s.error ? `error: ${s.error}` : s.lastResult ? `stopped: ${s.lastResult}` : '';
  const bar = $<HTMLProgressElement>('#pbar'); bar.hidden = !s.running; if (p?.total) { bar.max = p.total; bar.value = p.done; }
  if (S.run && s.runId === S.run.id) {
    const m = await getJSON(`./runs/${S.run.id}/meta.json`);
    if (m.lastTurn !== S.run.lastTurn) { const follow = S.turn === S.run.lastTurn; Object.assign(S.run, m); S.series = await getJSON(`./runs/${S.run.id}/series.json`); const txt = await (await fetch(`./runs/${S.run.id}/events.jsonl`, { cache: 'no-cache' })).text(); S.events = txt.split('\n').filter(Boolean).map(l => JSON.parse(l)); ($('#slider') as HTMLInputElement).max = String(m.lastTurn); if (follow) goTo(m.lastTurn); }
  }
  if (!s.running) { clearInterval(polling); polling = 0; refreshRuns(S.run?.id); }
}
const startPolling = () => { if (!polling) polling = setInterval(() => poll().catch(() => {}), 1000); };
async function showEstimate() { if (!S.server || !S.run) return; try { const e = await api(`estimate?run=${encodeURIComponent(S.run.id)}`); $('#progress').textContent = `${e.month}: ~${e.requests} requests needed (${e.active} leaders active); ${e.quotaLeft === null ? 'mock: free' : e.quotaLeft + ' left today'}`; } catch { /* ignore */ } }

function wireControls() {
  $('#controls').hidden = false;
  const run = (b: any) => api('run', { run: S.run.id, ...b }).then(startPolling).catch(e => alert(e.message));
  $('#btnNext').onclick = () => run({ turns: 1 });
  $('#btnRunN').onclick = () => run({ turns: Number(($('#nTurns') as HTMLInputElement).value) });
  $('#btnAuto').onclick = () => run({ auto: true });
  $('#btnPause').onclick = () => api('pause');
  $('#btnNew').onclick = () => openNewTest(false);
  $('#btnBranch').onclick = () => openNewTest(true);
  api('status').then(s => { if (s.running) startPolling(); });
}

// ---------- New test dialog (website and local server) ----------
const GOV_TYPES = ['liberal_democracy', 'electoral_democracy', 'hybrid_regime', 'authoritarian', 'absolute_monarchy', 'one_party_state', 'theocracy', 'military_junta'];
function openNewTest(branch = false) {
  const dlg = $<HTMLDialogElement>('#newDlg'), w = S.world;
  const overrides: Record<string, W4> = {};
  const targets: [string, string][] = [['*', 'All countries'], ['@democracies', 'All democracies'], ['@autocracies', 'All autocracies'],
    ...GOV_TYPES.map(g => ['@' + g, 'All ' + g.replace(/_/g, ' ') + (g.endsWith('y') ? '' : 's')] as [string, string]),
    ...Object.values(w?.countries ?? {}).filter(c => c.alive).sort((a, b) => a.name.localeCompare(b.name)).map(c => [c.iso3, c.name] as [string, string])];
  const label = (k: string) => targets.find(t => t[0] === k)?.[1] ?? k;
  dlg.innerHTML = `<h3 style="margin-top:0">New test</h3>
    <div class="ntGrid">
      <label>Name <input id="ntName" value="${esc(branch ? `${S.run?.name ?? 'test'} what-if` : 'test ' + new Date().toISOString().slice(5, 10))}" /></label>
      <label>Start from <select id="ntStart"><option value="fresh">Fresh world (real-world start)</option>${S.run ? `<option value="branch" ${branch ? 'selected' : ''}>Branch: "${esc(S.run.name)}" at ${esc(monthLabel(S.run.startDate, S.turn))}</option>` : ''}</select></label>
      <label id="ntCountriesL">AI leaders <select id="ntCountries"><option value="dev">20 major countries (others rule-based) — ~20 requests/month</option><option value="all">All 197 countries — ~200 requests/month</option></select></label>
      <label>Base incentive weights <select id="ntPreset"><option value="">${branch ? 'Keep the weights of the run' : 'Realistic: each government as it really behaves'}</option><option value="welfare">Everyone 100% population welfare</option><option value="approval">Everyone 100% approval</option><option value="survival">Everyone 100% regime survival</option><option value="power">Everyone 100% national power</option><option value="equal">Everyone equal mix (25% each)</option></select></label>
    </div>
    <h4>Override weights for a country or group <span class="muted">(optional; specific beats general)</span></h4>
    <div class="ntOv">
      <select id="ntTarget">${targets.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}</select>
      ${(['welfare', 'approval', 'survival', 'power'] as const).map(k => `<label class="sl"><span style="color:${INC_COLORS[k]}">${k}</span><input id="nt_${k}" type="range" min="0" max="100" value="${k === 'welfare' ? 100 : 0}" /><b id="ntv_${k}"></b></label>`).join('')}
      <button id="ntAdd">Add override</button>
    </div>
    <div id="ntList" class="muted">No overrides.</div>
    <label>Months to simulate now <input id="ntMonths" type="number" min="0" max="24" value="1" /></label>
    <p class="muted" id="ntNote"></p>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button id="ntCancel">Cancel</button><button id="ntGo" class="go">Start test</button></div>`;
  const sl = (k: string) => Number(($('#nt_' + k) as HTMLInputElement).value);
  const showPct = () => { const t = ['welfare', 'approval', 'survival', 'power'].reduce((a, k) => a + sl(k), 0) || 1; for (const k of ['welfare', 'approval', 'survival', 'power']) $('#ntv_' + k).textContent = Math.round(sl(k) / t * 100) + '%'; };
  dlg.querySelectorAll<HTMLInputElement>('.sl input').forEach(i => i.oninput = showPct); showPct();
  const list = () => { $('#ntList').innerHTML = Object.keys(overrides).length ? Object.entries(overrides).map(([k, v]) => `<div class="ntRow"><b>${esc(label(k))}</b> <span class="mix" style="width:120px;display:inline-flex">${Object.entries(v).map(([n, x]) => `<i style="width:${x * 100}%;background:${INC_COLORS[n]}"></i>`).join('')}</span> ${Object.entries(v).filter(([, x]) => x).map(([n, x]) => `${n} ${Math.round(x * 100)}%`).join(', ')} <button data-k="${esc(k)}">✕</button></div>`).join('') : 'No overrides.';
    $('#ntList').querySelectorAll<HTMLElement>('button').forEach(b => b.onclick = () => { delete overrides[b.dataset.k!]; list(); }); };
  $('#ntAdd').onclick = () => { const t = ['welfare', 'approval', 'survival', 'power'].reduce((a, k) => a + sl(k), 0) || 1;
    overrides[($('#ntTarget') as HTMLSelectElement).value] = { welfare: +(sl('welfare') / t).toFixed(3), approval: +(sl('approval') / t).toFixed(3), survival: +(sl('survival') / t).toFixed(3), power: +(sl('power') / t).toFixed(3) }; list(); };
  const note = () => { const br = ($('#ntStart') as HTMLSelectElement).value === 'branch'; $('#ntCountriesL').hidden = br;
    $('#ntNote').textContent = (br ? 'The branch copies the world at that month and keeps its AI model and leader setup. ' : '') + (S.server ? 'Runs on this computer.' : 'Runs on GitHub; this page follows progress and loads the result.') + ' Every test is saved and listed in the Run menu; download its AI summary log from the World tab.'; };
  $('#ntStart').oninput = note; note();
  $('#ntCancel').onclick = () => dlg.close();
  $('#ntGo').onclick = async () => {
    const br = ($('#ntStart') as HTMLSelectElement).value === 'branch' && S.run;
    const o: NewTest = { name: ($('#ntName') as HTMLInputElement).value.trim() || 'test', countries: ($('#ntCountries') as HTMLSelectElement).value as 'dev' | 'all', preset: ($('#ntPreset') as HTMLSelectElement).value, weights: overrides,
      months: Math.max(0, Math.min(24, Number(($('#ntMonths') as HTMLInputElement).value) || 0)), branchFrom: br ? { run: S.run.id, turn: S.turn } : undefined };
    dlg.close();
    if (S.server) {
      const m = o.branchFrom ? await api('branch', { run: o.branchFrom.run, from: o.branchFrom.turn, name: o.name, preset: o.preset || null, weights: o.weights })
        : await api('new', { name: o.name, countries: o.countries, preset: o.preset || null, weights: o.weights });
      await refreshRuns(m.id);
      if (o.months) { await api('run', { run: m.id, turns: o.months }); startPolling(); }
    } else if (S.startOnGithub) await S.startOnGithub({ ...o, months: Math.max(1, o.months) });
  };
  dlg.showModal();
}

// ---------- run controls on GitHub Pages (static site) ----------
// The page asks GitHub Actions to run the simulate workflow, using a fine-grained token the user pastes once.
// The token stays in this browser's localStorage; it only needs Actions read/write on this one repo.
function wireGithub() {
  const owner = location.hostname.split('.')[0], repo = location.pathname.split('/').filter(Boolean)[0];
  const KEY = `wl-gh-token:${owner}/${repo}`;
  const store = { get: () => { try { return localStorage.getItem(KEY); } catch { return null; } }, set: (v: string) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } }, clear: () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } } };
  let memToken: string | null = null; // fallback when storage is blocked
  const token = () => store.get() ?? memToken;
  const status = (html: string) => { $('#ghStatus').innerHTML = html; };
  const busy = (on: boolean) => { for (const id of ['#ghNext', '#ghRunN']) ($(id) as HTMLButtonElement).disabled = on; };
  const api = (path: string, init: RequestInit = {}) => fetch(`https://api.github.com/repos/${owner}/${repo}/${path}`, { ...init, headers: { authorization: `Bearer ${token()}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  const dlg = $<HTMLDialogElement>('#tokDlg');
  $('#tokRepo').textContent = repo;
  const askToken = (msg = '') => { $('#tokMsg').textContent = msg; ($('#tokIn') as HTMLInputElement).value = ''; dlg.showModal(); };
  $('#tokCancel').onclick = () => dlg.close();
  $('#tokForget').onclick = () => { store.clear(); memToken = null; dlg.close(); status('Token forgotten.'); };
  $('#tokSave').onclick = async () => {
    const v = ($('#tokIn') as HTMLInputElement).value.trim(); if (!v) return;
    memToken = v; store.set(v);
    const r = await api('actions/workflows/simulate.yml').catch(() => null);
    if (r?.ok) { dlg.close(); status('Connected to GitHub ✓'); }
    else { $('#tokMsg').textContent = `GitHub rejected that token (${r?.status ?? 'network error'}). Check it has Actions: Read and write on ${repo}.`; store.clear(); memToken = null; }
  };
  $('#ghTok').onclick = () => askToken(token() ? 'A token is saved. Paste a new one to replace it, or forget it.' : '');
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const fresh = (u: string) => getJSON(`${u}?v=${Date.now()}`); // bust the Pages CDN cache

  /** Start the simulate workflow and follow it until the website shows the result. `finished(index)` returns the run meta once done. */
  async function dispatch(inputs: Record<string, string>, what: string, finished: (idx: any[]) => any, onDone: (m: any) => Promise<void>) {
    if (!token()) return askToken();
    busy(true);
    const listGh = async () => {
      const r = await api('actions/workflows/simulate.yml/runs?per_page=10', { cache: 'no-store' });
      if (!r.ok) throw new Error(`GitHub status check failed (${r.status})${r.status === 403 ? ': the token needs Actions: Read and write' : ''}`);
      return ((await r.json()).workflow_runs ?? []) as any[];
    };
    const published = async () => { const idx = await fresh('./runs/index.json').catch(() => null); return idx ? finished(idx) : null; };
    try {
      // remember GitHub's newest run id, so the new run is "any id above it" (no dependence on this device's clock)
      const lastId = Math.max(0, ...(await listGh()).map(x => x.id));
      const r = await api('actions/workflows/simulate.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main', inputs }) });
      if (r.status === 401 || r.status === 403 || r.status === 404) { askToken(`GitHub refused (${r.status}). The token may have expired or lack Actions: Read and write.`); return; }
      if (!r.ok) { status(`<span class="bad">Could not start: ${r.status} ${esc(await r.text())}</span>`); return; }
      status(`Starting: ${esc(what)}…`);
      const t0 = Date.now(); let ghRun: any = null;
      for (;;) {
        if (Date.now() - t0 > 6 * 3600_000) { status('<span class="bad">Gave up waiting after 6 hours.</span>'); return; }
        await sleep(10_000);
        const mins = Math.round((Date.now() - t0) / 60000);
        ghRun = (await listGh()).filter(x => x.id > lastId).sort((p, q) => p.id - q.id)[0] ?? ghRun;
        const m = await published(); if (m) { S.cache.clear(); await onDone(m); return; }
        const link = ghRun ? ` <a href="${ghRun.html_url}" target="_blank" rel="noopener">details</a>` : '';
        if (!ghRun) status(`Waiting for GitHub to start… (${mins} min)`);
        else if (['queued', 'waiting', 'pending', 'requested'].includes(ghRun.status)) status(`Queued behind another run… (${mins} min)${link}`);
        else if (ghRun.status !== 'completed') status(`Simulating: ${esc(what)}… (${mins} min)${link}`);
        else if (ghRun.conclusion !== 'success') { status(`<span class="bad">Run ${esc(ghRun.conclusion)}.</span>${link}`); return; }
        else break;
      }
      for (let i = 0; i < 60; i++) {
        status(`Publishing to the website… (${i * 10}s)`);
        await sleep(10_000);
        const m = await published(); if (m) { S.cache.clear(); await onDone(m); return; }
      }
      status('<span class="warn">Finished on GitHub but the website has not updated yet (or no month could be simulated, e.g. the daily Gemini quota is used up). Refresh in a few minutes.</span>');
    } catch (e) { status(`<span class="bad">${esc((e as Error).message)}</span>`); }
    finally { busy(false); }
  }
  const stopNote = (m: any) => m.stoppedReason && m.stoppedReason !== 'done' ? ` <span class="warn">(stopped early: ${esc(String(m.stoppedReason).replace('_', ' '))})</span>` : '';
  async function run(months: number) {
    if (!S.run) return;
    const runId = S.run.id, before = S.run.lastTurn;
    await dispatch({ runId, turns: String(months) }, `${months} month${months > 1 ? 's' : ''} of ${S.run.name}`,
      idx => { const m = idx.find((x: any) => x.id === runId); return m && m.lastTurn > before ? m : null; },
      async m => { await refreshRuns(runId); status(`<span class="good">✓ ${m.lastTurn - before} new month(s): now ${esc(monthLabel(m.startDate, m.lastTurn))}</span>${stopNote(m)}`); });
  }
  // used by the New test dialog
  S.startOnGithub = async (o: NewTest) => {
    const known = new Set(S.runs.map(r => r.id));
    const setup = { preset: o.preset || undefined, weights: Object.keys(o.weights).length ? o.weights : undefined, countries: o.countries, branchFrom: o.branchFrom };
    await dispatch({ newRunName: o.name, setup: JSON.stringify(setup), turns: String(o.months) }, `new test "${o.name}" (${o.months} month${o.months > 1 ? 's' : ''})`,
      idx => idx.find((x: any) => !known.has(x.id) && x.name === o.name && !x.lock && (x.lastTurn > (o.branchFrom?.turn ?? 0) || x.stoppedReason)) ?? null,
      async m => { await refreshRuns(m.id); status(`<span class="good">✓ Test "${esc(m.name)}" created: ${m.lastTurn - (o.branchFrom?.turn ?? 0)} month(s) simulated</span>${stopNote(m)}`); });
  };
  $('#ghNext').onclick = () => run(1);
  const nMonths = () => Math.max(1, Math.min(24, Number(($('#ghN') as HTMLInputElement).value) || 1));
  $('#ghN').oninput = () => { $('#ghRunN').textContent = `Run ${nMonths()} month${nMonths() > 1 ? 's' : ''}`; };
  $('#ghRunN').onclick = () => run(nMonths());
  $('#ghNew').onclick = () => openNewTest(false);
  $('#ghWrap').hidden = false;
  status(token() ? '' : 'First time: you will be asked for a GitHub token.');
}

// ---------- boot ----------
async function boot() {
  $('#layerSel').innerHTML = Object.entries(LAYERS).map(([k, l]) => `<option value="${k}">${l.label}</option>`).join('');
  $('#layerSel').oninput = e => { S.layer = (e.target as HTMLSelectElement).value; paintMap(); };
  $('#overlays').innerHTML = Object.entries(OVERLAYS).map(([k, l]) => `<label><input type="checkbox" data-o="${k}" ${S.overlays.has(k) ? 'checked' : ''}/> ${l}</label>`).join('');
  $('#overlays').querySelectorAll<HTMLInputElement>('input').forEach(i => i.onchange = () => { i.checked ? S.overlays.add(i.dataset.o!) : S.overlays.delete(i.dataset.o!); paintMap(); });
  document.querySelectorAll<HTMLElement>('#tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('#tabs button').forEach(x => x.classList.remove('on')); b.classList.add('on');
    document.querySelectorAll<HTMLElement>('.tab').forEach(t => t.hidden = t.id !== 'tab-' + b.dataset.tab); renderPanel();
  });
  $('#slider').oninput = e => goTo(Number((e.target as HTMLInputElement).value));
  $('#btnPrev').onclick = () => goTo(S.turn - 1);
  $('#btnFwd').onclick = () => goTo(S.turn + 1);
  $('#btnPlay').onclick = () => {
    if (S.playing) { clearInterval(S.playing); S.playing = 0; $('#btnPlay').textContent = '▶ Play'; return; }
    if (S.turn >= S.run.lastTurn) goTo(0);
    $('#btnPlay').textContent = '❚❚ Pause';
    S.playing = setInterval(() => { if (S.turn >= S.run.lastTurn) { $('#btnPlay').click(); return; } goTo(S.turn + 1); }, 900);
  };
  $('#runSel').oninput = e => loadRun((e.target as HTMLSelectElement).value).then(showEstimate);
  S.server = await fetch('./api/status').then(r => r.ok).catch(() => false);
  [S.topo, S.regions] = await Promise.all([getJSON('./data/regions.topo.json'), getJSON('./data/regions.json')]);
  await new Promise<void>(r => map.loaded() ? r() : map.on('load', () => r()));
  setupMap();
  if (S.server) wireControls();
  else if (location.hostname.endsWith('github.io')) wireGithub();
  await refreshRuns();
  showEstimate();
}
boot().catch(e => { $('#month').textContent = 'Failed to load: ' + e.message; console.error(e); });
