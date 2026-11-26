// One-time enrichment: replace template constitutions in data/constitutions.json with LLM summaries of each
// country's real arrangements. Cached: countries already enriched are skipped, so it resumes across days.
// Usage: npm run constitutions [-- --only dev | --only USA,FRA] [--limit 20]
import fs from 'node:fs';
import path from 'node:path';
import { chat, config, QuotaExhausted } from '../agents/llm.ts';
import { validateConstitution } from '../agents/index.ts';
import { DEV_COUNTRIES } from '../engine/world.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const file = path.join(ROOT, 'data', 'constitutions.json');
const consts = JSON.parse(fs.readFileSync(file, 'utf8'));
const countries: any[] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'countries.json'), 'utf8'));
const tpl = fs.readFileSync(path.join(ROOT, 'prompts', 'constitution-summary.txt'), 'utf8');
const arg = (k: string) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const only = arg('only') === 'dev' ? DEV_COUNTRIES : arg('only')?.split(',');
const limit = Number(arg('limit') ?? 1e9);
if (config.provider === 'mock') { console.error('Set PROVIDER and API_KEY in .env first.'); process.exit(1); }

let done = 0;
for (const c of countries) {
  if (only && !only.includes(c.iso3)) continue;
  const k = consts[c.iso3];
  if (!k || k.source?.startsWith('LLM summary') || done >= limit) continue;
  const prompt = tpl.replace('{{country}}', c.name).replace('{{govType}}', c.govType.replace(/_/g, ' '));
  try {
    let parsed = null;
    for (let i = 0; i < 2 && !parsed; i++) parsed = validateConstitution((await chat([{ role: 'user', content: prompt }], m => process.stdout.write(`\r${c.iso3}: ${m}   `))).text);
    if (!parsed) { console.log(`${c.iso3}: invalid answer twice, template kept`); continue; }
    // keep the engine's notion of permanent leadership (validateConstitution appends it) and the version history
    Object.assign(k, parsed, { generated: true, source: `LLM summary (${config.provider}/${config.model}); verify against constituteproject.org` });
    fs.writeFileSync(file, JSON.stringify(consts, null, 1));
    done++; console.log(`${c.iso3}: enriched`);
  } catch (e) {
    if (e instanceof QuotaExhausted) { console.log(`\nstopped: ${(e as Error).message} (${done} enriched; rerun to continue)`); break; }
    throw e;
  }
}
console.log(`done: ${done} constitutions enriched. Start a new run to use them.`);
