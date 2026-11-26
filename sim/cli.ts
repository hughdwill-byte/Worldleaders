// npm run sim -- --new --name "baseline" [--seed 42] [--countries dev] [--preset welfare] [--turns 12]
// npm run sim -- --run <id> --turns 12        (or --turns quota: keep going until the daily quota is used)
// npm run sim -- --branch <id> --from 24 --preset welfare [--weights file.json] [--turns 6]
// npm run sim -- --list | --estimate <id>     Flags: --force (ignore lock), --hours 5.5 (stop before a deadline)
import { branchRun, createRun, estimate, listRuns, step } from './run.ts';

const a = process.argv.slice(2);
const flag = (k: string) => a.includes('--' + k);
const val = (k: string) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };

let id = val('run');
if (flag('list')) { for (const m of listRuns()) console.log(`${m.id}  months=${m.lastTurn}  ${m.provider}/${m.model}${m.parent ? `  branch of ${m.parent.id}@${m.parent.turn}` : ''}${m.lock ? '  LOCKED' : ''}`); process.exit(0); }
if (val('estimate')) { console.log(estimate(val('estimate')!)); process.exit(0); }
if (flag('new')) {
  const m = createRun({ name: val('name') ?? 'run', seed: val('seed') ? Number(val('seed')) : undefined, countries: val('countries') as 'all' | 'dev' | undefined, preset: val('preset') ?? null, weightsFile: val('weights'), startDate: val('start') });
  console.log('created run', m.id); id = m.id;
}
if (val('branch')) {
  const m = branchRun(val('branch')!, Number(val('from') ?? 0), { name: val('name'), preset: val('preset') ?? null, weightsFile: val('weights') });
  console.log('created branch', m.id, 'from', m.parent); id = m.id;
}
const turnsArg = val('turns');
if (id && turnsArg) {
  const turns = turnsArg === 'quota' ? 100000 : Number(turnsArg);
  const e = estimate(id);
  console.log(`${e.month}: ${e.active} leaders act; ~${e.requests} requests needed; ${e.quotaLeft === Infinity ? 'unlimited (mock)' : e.quotaLeft + ' left today'}`);
  let stop = false;
  process.on('SIGINT', () => { console.log('\npausing after the current call…'); stop = true; });
  const hours = Number(val('hours') ?? 0);
  let last = '';
  const reason = await step(id, {
    turns, force: flag('force'), shouldStop: () => stop, deadline: hours ? Date.now() + hours * 3600_000 : undefined,
    onProgress: p => { const line = `${p.month}: ${p.done}/${p.total} leaders decided — ${p.message}`; if (line !== last) { process.stdout.write((process.stdout.isTTY ? '\r\x1b[K' : '') + line + (process.stdout.isTTY ? '' : '\n')); last = line; } },
  });
  console.log(`\nstopped: ${reason}`);
} else if (!flag('new') && !val('branch')) console.log('Nothing to do. See the header of sim/cli.ts for usage.');
