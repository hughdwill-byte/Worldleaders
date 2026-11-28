// Used by .github/workflows/simulate.yml: converts the SETUP JSON input into sim CLI flags.
// Prints flags like: --new --countries dev --preset welfare --weights /tmp/w.json   or   --branch <id> --from 3 ...
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const s = process.env.SETUP ? JSON.parse(process.env.SETUP) : {};
const q = v => `'${String(v).replace(/'/g, "'\\''")}'`;
const out = [];
if (s.branchFrom?.run) out.push('--branch', q(s.branchFrom.run), '--from', q(Number(s.branchFrom.turn) || 0));
else out.push('--new', '--countries', q(s.countries === 'dev' ? 'dev' : process.env.COUNTRIES || 'all'));
if (s.preset) out.push('--preset', q(s.preset));
if (s.weights && Object.keys(s.weights).length) {
  const f = path.join(os.tmpdir(), 'weights.json'); fs.writeFileSync(f, JSON.stringify(s.weights)); out.push('--weights', q(f));
}
if (s.seed) out.push('--seed', q(Number(s.seed)));
console.log(out.join(' '));
