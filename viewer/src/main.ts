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

// ---------- state ----------
const S = {
  server: false, runs: [] as any[], run: null as any, series: null as any, events: [] as SimEvent[],
  turn: 0, world: null as World | null, prevWorld: null as World | null, cache: new Map<string, Promise<World>>(),
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

function renderEvents() {
  const el = $('#tab-events');
  const types = [...new Set(S.events.map(e => e.type))].sort();
  const prev = { c: ($('#fC') as HTMLInputElement | null)?.value ?? '', t: ($('#fT') as HTMLSelectElement | null)?.value ?? '', q: ($('#fQ') as HTMLInputElement | null)?.value ?? '', a: ($('#fA') as HTMLInputElement | null)?.value ?? '0', b: ($('#fB') as HTMLInputElement | null)?.value ?? String(S.run?.lastTurn ?? 0), m: ($('#fM') as HTMLInputElement | null)?.checked ?? false };
  el.innerHTML = `<div class="filters">
    <input id="fC" placeholder="Country (ISO3)" value="${esc(prev.c || S.selected || '')}" /><select id="fT"><option value="">all types</option>${types.map(t => `<option ${t === prev.t ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <input id="fA" type="number" min="0" value="${esc(prev.a)}" title="from month #" /><input id="fB" type="number" min="0" value="${esc(prev.b)}" title="to month #" />
    <input id="fQ" placeholder="Search text" value="${esc(prev.q)}" /><label><input id="fM" type="checkbox" ${prev.m ? 'checked' : ''}/> major only</label></div><div id="evList"></div>`;
  const list = () => {
    const c = ($('#fC') as HTMLInputElement).value.trim().toUpperCase(), t = ($('#fT') as HTMLSelectElement).value, q = ($('#fQ') as HTMLInputElement).value.toLowerCase();
    const a = Number(($('#fA') as HTMLInputElement).value), b = Number(($('#fB') as HTMLInputElement).value), m = ($('#fM') as HTMLInputElement).checked;
    const xs = S.events.filter(e => (!c || e.countries.includes(c)) && (!t || e.type === t) && e.turn >= a && e.turn <= b && (!m || e.major) && (!q || e.text.toLowerCase().includes(q))).slice(-400).reverse();
    $('#evList').innerHTML = xs.map((e, i) => `<div class="ev ${e.major ? 'major' : ''}" data-i="${i}"><div class="t">${esc(monthLabel(S.run.startDate, e.turn))} · ${esc(e.type)}</div>${esc(e.text)}</div>`).join('') || '<p class="muted">No events.</p>';
    $('#evList').querySelectorAll<HTMLElement>('.ev').forEach(d => d.onclick = () => { const e = xs[Number(d.dataset.i)]; if (e.countries[0]) S.selected = e.countries[0]; goTo(Math.min(S.run.lastTurn, e.turn + 1)); });
  };
  el.querySelectorAll('input,select').forEach(x => x.addEventListener('input', list));
  list();
}

function renderWorld() {
  const el = $('#tab-world'), w = S.world, sr = S.series; if (!w || !sr) return;
  const t = S.turn, W = sr.world;
  const card = (label: string, v: string) => `<div class="stat"><small>${label}</small><b>${v}</b></div>`;
  el.innerHTML = `<div class="grid">
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
  el.innerHTML = `<p class="muted">Chart one metric from two runs side by side.</p><div class="filters">
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
  S.series = await getJSON(`./runs/${id}/series.json`);
  const txt = await (await fetch(`./runs/${id}/events.jsonl`, { cache: 'no-cache' })).text();
  S.events = txt.split('\n').filter(Boolean).map(l => JSON.parse(l));
  ($('#slider') as HTMLInputElement).max = String(S.run.lastTurn);
  S.prevWorld = null;
  await goTo(keepTurn ? S.run.lastTurn : S.run.lastTurn);
}

async function refreshRuns(select?: string) {
  S.runs = S.server ? await getJSON('./api/runs') : await getJSON('./runs/index.json').catch(() => []);
  $('#runSel').innerHTML = S.runs.map(r => `<option value="${esc(r.id)}">${esc(r.name)} · ${r.lastTurn} mo${r.parent ? ' · branch' : ''}</option>`).join('');
  const id = select ?? S.run?.id ?? S.runs.at(-1)?.id;
  if (id) { ($('#runSel') as HTMLSelectElement).value = id; await loadRun(id); }
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
  $('#btnNew').onclick = async () => { const name = prompt('Name for the new run?', 'baseline'); if (!name) return; const m = await api('new', { name }); await refreshRuns(m.id); };
  $('#btnBranch').onclick = async () => { const preset = ($('#presetSel') as HTMLSelectElement).value; const m = await api('branch', { run: S.run.id, from: S.turn, preset }); await refreshRuns(m.id); };
  api('status').then(s => { if (s.running) startPolling(); });
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
  await refreshRuns();
  showEstimate();
}
boot().catch(e => { $('#month').textContent = 'Failed to load: ' + e.message; console.error(e); });
