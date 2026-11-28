// npm run export -- --run <id>   → runs/<id>/csv/{country_month,decisions,events,cables}.csv (tidy: one row per observation)
// The viewer's "Download CSV" builds the same country_month/events/decisions files in the browser.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { RUNS, readMeta } from './run.ts';
import { cameoOf } from '../engine/cameo.ts';
import type { SimEvent, World } from '../engine/types.ts';

const q = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (rows: Record<string, unknown>[]) => rows.length ? '\uFEFF' + [Object.keys(rows[0]).join(','), ...rows.map(r => Object.values(r).map(q).join(','))].join('\r\n') + '\r\n' : '';

export function exportRun(id: string) {
  const m = readMeta(id), dir = path.join(RUNS, id), out = path.join(dir, 'csv');
  fs.mkdirSync(out, { recursive: true });
  const series = JSON.parse(fs.readFileSync(path.join(dir, 'series.json'), 'utf8'));
  const events: SimEvent[] = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const snap = (t: number): World => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'turns', String(t).padStart(4, '0') + '.json.gz'))).toString());
  const last = snap(m.lastTurn);
  const name = (i: string) => last.countries[i]?.name ?? i;

  const cm: Record<string, unknown>[] = [];
  for (const [iso, o] of Object.entries<any>(series.countries)) series.months.forEach((mo: string, t: number) => {
    if (o.gdp?.[t] == null) return;
    cm.push({ run: id, month_index: t, month: mo, iso3: iso, country: name(iso), ...Object.fromEntries(Object.keys(o).map(k => [k, o[k][t]])) });
  });
  fs.writeFileSync(path.join(out, 'country_month.csv'), toCsv(cm));

  // decisions: AI and standing-order decisions from events; rule-based decisions from the mock logs
  const dec: Record<string, unknown>[] = events.filter(e => e.type.startsWith('decision')).map(e => {
    const by = (e.data as any).by;
    return { run: id, month_index: e.turn, month: series.months[e.turn], iso3: by.iso, decided_by: by.standing ? 'standing_order' : 'ai', type: by.type, cameo: by.cameo ?? cameoOf(by.type), target: by.target ?? '', executed: e.type === 'decision', order: by.order };
  });
  for (let t = 0; t < m.lastTurn; t++) {
    const f = path.join(dir, 'agents', String(t).padStart(4, '0'), '_mock.json'); if (!fs.existsSync(f)) continue;
    for (const [iso, r] of Object.entries<any>(JSON.parse(fs.readFileSync(f, 'utf8')))) if (r.source !== 'standing') for (const d of r.directives ?? [])
      dec.push({ run: id, month_index: t, month: series.months[t], iso3: iso, decided_by: 'rule_based', type: d.type, cameo: cameoOf(d.type), target: d.target ?? '', executed: '', order: d.order ?? '' });
  }
  fs.writeFileSync(path.join(out, 'decisions.csv'), toCsv(dec));

  fs.writeFileSync(path.join(out, 'events.csv'), toCsv(events.map(e => ({ run: id, month_index: e.turn, month: series.months[e.turn], type: e.type, major: !!e.major, countries: e.countries.join(' '), text: e.text, why: (e.data as any)?.why ?? '', caused_by_order: (e.data as any)?.by?.order ?? '' }))));

  const cables: Record<string, unknown>[] = [];
  for (let t = 1; t <= m.lastTurn; t++) for (const c of snap(t).cables) cables.push({ run: id, month_index: c.turn, month: series.months[c.turn], from: c.from, to: c.to, private: c.private, intercepted_by: (c.intercepted ?? []).join(' '), text: c.text });
  fs.writeFileSync(path.join(out, 'cables.csv'), toCsv(cables));
  return { dir: out, rows: { country_month: cm.length, decisions: dec.length, events: events.length, cables: cables.length } };
}

if (process.argv[1]?.endsWith('export.ts')) {
  const i = process.argv.indexOf('--run');
  if (i < 0) { console.log('Usage: npm run export -- --run <id>'); process.exit(1); }
  const r = exportRun(process.argv[i + 1]); console.log(r.dir, r.rows);
}
