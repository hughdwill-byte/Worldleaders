// npm start: serves the built viewer + data/ + runs/, and a tiny JSON API to step / auto-run / pause / branch.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, type ProgressInfo, branchRun, createRun, estimate, listRuns, readMeta, step } from './run.ts';

const PORT = Number(process.env.PORT || 5173);
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jsonl': 'text/plain', '.gz': 'application/gzip', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown' };
const state = { running: false, stop: false, runId: '', progress: null as ProgressInfo | null, lastResult: '', error: '' };

async function body(req: http.IncomingMessage): Promise<any> {
  let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {};
}
function send(res: http.ServerResponse, code: number, data: unknown) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }

function start(runId: string, turns: number) {
  if (state.running) throw new Error('A run is already in progress');
  Object.assign(state, { running: true, stop: false, runId, error: '', lastResult: '' });
  step(runId, { turns, shouldStop: () => state.stop, onProgress: p => { state.progress = p; } })
    .then(r => { state.lastResult = r; }).catch(e => { state.error = String(e.message ?? e); }).finally(() => { state.running = false; });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const api = url.pathname.slice(5);
      if (api === 'status') return send(res, 200, state);
      if (api === 'runs') return send(res, 200, listRuns());
      if (api === 'estimate') return send(res, 200, estimate(url.searchParams.get('run')!));
      if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
      const b = await body(req);
      if (api === 'new') return send(res, 200, createRun({ name: b.name || 'run', seed: b.seed, countries: b.countries, preset: b.preset || null }));
      if (api === 'branch') return send(res, 200, branchRun(b.run, Number(b.from), { preset: b.preset || null, name: b.name }));
      if (api === 'run') { readMeta(b.run); start(b.run, b.auto ? 100000 : Number(b.turns || 1)); return send(res, 200, { ok: true }); }
      if (api === 'pause') { state.stop = true; return send(res, 200, { ok: true }); }
      return send(res, 404, { error: 'unknown endpoint' });
    }
    // static files: /data/*, /runs/* from the repo; everything else from the built viewer
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const base = rel.startsWith('data/') || rel.startsWith('runs/') ? ROOT : path.join(ROOT, 'viewer', 'dist');
    let f = path.resolve(base, rel || 'index.html');
    if (!f.startsWith(base)) return send(res, 403, { error: 'forbidden' });
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { send(res, 500, { error: (e as Error).message }); }
}).listen(PORT, () => console.log(`World governance viewer: http://localhost:${PORT}`));
