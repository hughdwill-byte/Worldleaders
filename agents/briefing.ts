// Builds the in-world system prompt and monthly briefing. Never mentions simulation, turns, scores or AI.
// Incentive weights are never shown as numbers: they decide which pressures the briefing stresses.
// Autocratic, low-accountability governments get "yes-man" briefings that under-report bad news.
import fs from 'node:fs';
import path from 'node:path';
import type { Country, World } from '../engine/types.ts';
import type { Statics } from '../engine/world.ts';
import { strength } from '../engine/world.ts';
import { enemies, regionsOf, warsOf } from '../engine/ops.ts';
import { avgApproval } from '../engine/turn.ts';
import { isDemocracy } from '../engine/regime.ts';
import { INFO, LADDER } from '../engine/constants.ts';
import { reliability } from '../engine/directives.ts';
import { Rng, clamp, hash, monthLabel } from '../engine/util.ts';

const PROMPTS = path.resolve(import.meta.dirname, '..', 'prompts');
const tpl = (f: string) => fs.readFileSync(path.join(PROMPTS, f), 'utf8');
const fill = (t: string, v: Record<string, string>) => t.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');
const pct = (x: number, d = 1) => `${x.toFixed(d)}%`;
const usd = (x: number) => x >= 1e12 ? `$${(x / 1e12).toFixed(2)} trillion` : x >= 1e9 ? `$${(x / 1e9).toFixed(1)} billion` : `$${(x / 1e6).toFixed(0)} million`;
const nm = (w: World, i: string) => i.startsWith('rebel:') ? (w.factions[i.slice(6)]?.name ?? 'rebel forces') : `${w.countries[i]?.name ?? i} (${i})`;

export function describeConstitution(c: Country) {
  const k = c.constitution;
  return [
    `Form of government: ${k.govType.replace(/_/g, ' ')} (${k.status}). Head of State: ${k.headOfState}. Head of Government: ${k.headOfGovernment}.`,
    k.howPowerHeld,
    `Legislature: ${k.legislature.type}${k.legislature.elected ? `, elected every ${k.legislature.termYears} years` : ''}; its powers over budgets and laws are ${k.legislature.powers > 0.6 ? 'strong' : k.legislature.powers > 0.3 ? 'moderate' : 'weak'}.`,
    `Courts: ${k.courts.independence > 0.6 ? 'independent and able to strike down executive measures' : k.courts.independence > 0.3 ? 'partly independent' : 'subordinate to the executive'}.`,
    `Guaranteed liberties: ${Object.entries(k.liberties).filter(([, v]) => v).map(([n]) => n).join(', ') || 'none entrenched'}. Emergency powers: ${k.emergencyPowers}. Armed forces: ${k.militaryRole.replace('_', ' ')}. Religion: ${k.religionRole}. State structure: ${k.territorial.replace(/_/g, ' ')}. Amendment by: ${k.amendment}.`,
    `Succession: ${k.succession}.`,
  ].join('\n');
}

/** Identical for every country (cacheable prefix); the country and its constitution are in the briefing. */
export function systemPrompt(_c?: Country) { return tpl('system.txt'); }

const delta = (now: number, then: number | undefined, unit = '', d = 1) => then == null || !Number.isFinite(then) ? '' : ` (${now - then >= 0 ? '+' : ''}${(now - then).toFixed(d)}${unit} since your last review)`;

/** compact = shorter briefing for quiet countries on the review rotation. */
export function briefing(w: World, s: Statics, iso: string, annexTopic?: string, compact = false): string {
  const c = w.countries[iso], rng = new Rng(hash(`${w.seed}:brief:${w.turn}:${iso}`));
  const dem = isDemocracy(c.govType), k = c.incentives;
  // officials under-report bad news where the press is unfree and courts are weak
  const yesMan = dem ? 0 : INFO.yesManMax * (1 - c.info.pressFreedom) * (c.constitution.courts.independence < 0.3 ? 1 : 0.5);
  const rep = (bad: number) => bad * (1 - yesMan);
  const month = monthLabel(w.startDate, w.turn);

  const myWars = warsOf(w, iso);
  const held = regionsOf(w, iso), owned = regionsOf(w, iso, 'owner');
  const lost = owned.filter(i => w.regions[i].controller !== iso);
  const situation = [
    `Population ${(c.pop / 1e6).toFixed(1)} million. Government controls ${owned.length - lost.length} of our ${owned.length} regions${held.length > owned.length - lost.length ? `, and occupies ${held.length - (owned.length - lost.length)} regions of other states` : ''}${lost.length ? `; not under government control: ${lost.slice(0, 8).map(i => `${s.regions[i].name} (held by ${nm(w, w.regions[i].controller)})`).join(', ')}` : ''}.`,
    c.provisionalUntil != null ? `The government is provisional; the constitution is not yet ratified. It came to power through ${c.leader.origin}.` : '',
    ...myWars.map(v => `${v.civil ? 'Internal armed conflict' : 'State of war'}: ${v.name}. Opponents: ${(v.attackers.includes(iso) ? v.defenders : v.attackers).map(e => nm(w, e)).join(', ')}. War-weariness: ${(v.exhaustion[iso] ?? 0) > 60 ? 'severe' : (v.exhaustion[iso] ?? 0) > 30 ? 'growing' : 'limited'}.`),
    `Commodity prices (index, 100 = last year's average): oil ${(w.global.oilPrice * 100).toFixed(0)}, food ${(w.global.foodPrice * 100).toFixed(0)}.${w.global.pandemic ? ' A pandemic is spreading worldwide.' : ''}`,
  ].filter(Boolean).join('\n');

  const sanc = w.sanctions.filter(q => q.target === iso);
  const top = Object.entries(w.trade[iso] ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const economy = [
    `GDP ${usd(c.gdp)} (${'$' + Math.round(c.gdp / c.pop).toLocaleString('en-US')} per person). Growth ${pct(c.growth)} annualised${delta(c.growth, c.reviewStats?.growth, ' pts')}; inflation ${pct(c.inflation)}${delta(c.inflation, c.reviewStats?.inflation, ' pts')}; unemployment ${pct(rep(c.unemployment) + c.unemployment * yesMan * 0.3)}${delta(c.unemployment, c.reviewStats?.unemployment, ' pts')}.`,
    `Budget: revenue ${pct(c.taxRate)} of GDP, balance ${pct(c.budgetBalance)} of GDP; public debt ${pct(c.debt / c.gdp * 100, 0)} of GDP at ${pct(c.interestRate * 100)} average yield.${c.austerityUntil && c.austerityUntil > w.turn ? ' An IMF programme with spending limits is in force.' : ''}`,
    `Spending (% of GDP): ${Object.entries(c.spending).map(([a, v]) => `${a} ${v.toFixed(1)}`).join(', ')}.`,
    `Main export markets: ${top.map(([b, v]) => `${nm(w, b)} ${usd(v)}`).join('; ') || 'n/a'}.`,
    sanc.length ? `Under sanctions from ${sanc.length} states (${sanc.slice(0, 6).map(q => q.by).join(', ')}${sanc.length > 6 ? '…' : ''}); roughly ${pct(c.sanctionExposure * 100, 0)} of our trade is affected.` : '',
    k.welfare > 0.3 ? `Social indicators: life expectancy ${c.lifeExp.toFixed(1)} years; literacy ${c.literacy.toFixed(0)}%; ${(c.refugeesHosted / 1e3).toFixed(0)}k refugees hosted.` : '',
  ].filter(Boolean).join('\n');

  const blocs = c.blocs.map(b => {
    const a = clamp(b.approval + yesMan * 15);
    return k.approval > 0.2 || dem ? `- ${b.name} (${pct(b.share * 100, 0)} of population): ${a.toFixed(0)}% approve${b.grievances.length ? `; grievances: ${b.grievances.join(', ')}` : ''}` : `- ${b.name}: ${a > 55 ? 'supportive' : a > 40 ? 'mixed' : 'discontented'}`;
  });
  const shownStage = Math.max(0, Math.round(c.stage - yesMan * 2 * (c.stage < 6 ? 1 : 0)));
  const domestic = [
    `Overall public mood: ${LADDER[shownStage].replace('_', ' ')}. ${dem || k.approval > 0.2 ? `Approval of the government: ${clamp(avgApproval(c, false) + yesMan * 15).toFixed(0)}%${delta(avgApproval(c, false), c.reviewStats?.approval, ' pts', 0)}.` : ''}`,
    ...blocs,
    c.nextElection != null ? `Legislative support: ${pct(c.legislatureSupport * 100, 0)} of seats. Next legislative elections: ${monthLabel(w.startDate, c.nextElection)}.` : `The legislature ${c.constitution.legislature.type === 'none' ? 'is suspended' : 'is compliant'}.`,
    `Current posture: repression ${c.repression > 0.6 ? 'high' : c.repression > 0.3 ? 'moderate' : 'low'}; civil liberties ${c.civilLiberties > 0.6 ? 'broad' : c.civilLiberties > 0.3 ? 'limited' : 'curtailed'}; media ${c.info.pressFreedom > 0.6 ? 'free and critical' : c.info.pressFreedom > 0.3 ? 'partly controlled' : 'state-directed'}${c.curfew ? '; curfew in force' : ''}${c.info.internetShutdown ? '; internet shut down' : ''}.`,
    k.survival > 0.3 ? `Security services: ${c.coupRisk > 0.004 ? 'reports of discontent among senior officers; the loyalty of the security services cannot be taken for granted' : 'the loyalty of the security services cannot be taken for granted, though no plotting has been detected'}.` : '',
    ...Object.values(w.factions).filter(f => f.active && f.country === iso).map(f => `Armed opposition: ${f.name} (${f.ideology}), strength ${f.strength > strength(c) * 0.3 ? 'formidable' : f.strength > strength(c) * 0.1 ? 'significant' : 'limited'}, holding ${f.regions.length} regions${f.backers.length ? `, backed by ${f.backers.join(', ')}` : ''}.`),
    ...owned.filter(i => w.regions[i].unrest > 55 && w.regions[i].controller === iso).sort((a, b) => w.regions[b].unrest - w.regions[a].unrest).slice(0, 4).map(i => `Unrest hotspot: ${s.regions[i].name}${s.regions[i].group ? ` (${s.regions[i].group})` : ''}.`).map(t => yesMan > 0.3 && rng.chance(0.5) ? '' : t),
  ].filter(Boolean).join('\n');

  // intelligence on rivals & neighbours: noisy, sometimes wrong
  const watch = [...new Set([...enemies(w, iso).filter(e => !e.startsWith('rebel:')), ...Object.entries(w.attitudes[iso]).filter(([o, v]) => v < -30 && w.countries[o]?.alive).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([o]) => o), ...((s.countryData[iso]?.borders ?? []) as string[]).filter(b => w.countries[b]?.alive).slice(0, 2)])].slice(0, 5);
  const skill = clamp(c.tech * 0.4 + c.info.surveillance * 0.6, 0.1, 1.2);
  const intel = watch.map(o => {
    const t = w.countries[o];
    const ratio = strength(t) / Math.max(1e-6, strength(c)) * (1 + rng.normal() * 0.3 * (1.2 - skill)) * (1 - yesMan * 0.3);
    // true likelihood of hostile action, then a noisy estimate with a range that widens with weaker intelligence services
    const att = w.attitudes[o][iso] ?? 0;
    const truth = clamp(0.1 + (att < 0 ? -att / 130 : 0) + (t.mobilized > 0.3 ? 0.25 : 0) + (enemies(w, iso).includes(o) ? 0.4 : 0), 0.02, 0.97);
    const noise = rng.normal() * 0.25 * (1.2 - skill), est = clamp(truth + noise, 0.02, 0.98), half = 0.05 + 0.15 * (1.2 - skill);
    const lo = Math.round(clamp(est - half, 0.01, 0.99) * 20) * 5, hi = Math.round(clamp(est + half, 0.01, 0.99) * 20) * 5;
    const intent = `likelihood of hostile action against us within months: ${lo}–${hi}%`;
    const conf = skill > 0.8 ? 'moderate confidence' : 'low confidence';
    return `- ${nm(w, o)}: military ${ratio > 1.5 ? 'considerably stronger than ours' : ratio > 0.8 ? 'comparable to ours' : 'weaker than ours'}${t.mobilized > 0.2 ? ', partially mobilised' : ''}; ${intent} (${conf}). Internal stability: ${t.stage >= 4 ? 'fragile' : t.stage >= 2 ? 'strained' : 'stable'}.`;
  });
  if (k.power > 0.25) {
    const region = [iso, ...((s.countryData[iso]?.borders ?? []) as string[])].filter(i => w.countries[i]?.alive);
    const rank = region.sort((a, b) => strength(w.countries[b]) - strength(w.countries[a])).indexOf(iso) + 1;
    intel.push(`Regional balance: our armed forces rank ${rank} of ${region.length} among us and our neighbours.`);
  }

  const att = Object.entries(w.attitudes)
    .filter(([o]) => o !== iso && w.countries[o]?.alive).map(([o, row]) => [o, row[iso] ?? 0] as [string, number]).sort((a, b) => b[1] - a[1]);
  const allies = w.treaties.filter(t => t.kind === 'alliance' && (t.a === iso || t.b === iso)).map(t => t.a === iso ? t.b : t.a);
  const diplomacy = [
    `Memberships: ${c.orgs.join(', ') || 'none'}. Treaty allies: ${allies.map(a => nm(w, a)).join(', ') || 'none'}.`,
    `Most favourable towards us: ${att.slice(0, 5).map(([o]) => nm(w, o)).join(', ')}.`,
    `Most hostile towards us: ${att.slice(-5).reverse().map(([o]) => nm(w, o)).join(', ')}.`,
  ].join('\n');

  const cables = [...w.cables.filter(cb => cb.to === iso), ...w.cables.filter(cb => cb.to !== iso && !cb.private && cb.from !== iso && (w.attitudes[iso][cb.from] ?? 0) < -40), ...w.cables.filter(cb => cb.to !== iso && (cb.intercepted ?? []).includes(iso)).slice(0, 2)];
  const proposals = w.pendingProposals.filter(p => p.to === iso && p.turn >= w.turn - 1);
  const statements = Object.values(w.countries).filter(o => o.alive && o.iso3 !== iso && o.leader.lastStatement && (enemies(w, iso).includes(o.iso3) || allies.includes(o.iso3))).slice(0, 4);
  const inbox = [
    ...cables.slice(0, compact ? 3 : 8).map(cb => `- ${cb.to === iso ? `Cable (${cb.private ? 'private channel' : 'public'})` : cb.private ? 'INTERCEPTED cable' : 'Public message'} from ${nm(w, cb.from)}${cb.to !== iso ? ` to ${nm(w, cb.to)}` : ''} [sender has ${reliability(w, cb.from)}]: "${cb.text.slice(0, 500)}"`),
    ...proposals.map(p => `- Formal proposal from ${nm(w, p.from)}: ${p.type.replace(/_/g, ' ')}${p.regions?.length ? ` (${p.regions.join(', ')})` : ''}. Reply with the matching _accept directive to agree.`),
    ...(compact ? [] : statements).map(o => `- Public statement by the government of ${nm(w, o.iso3)}: "${o.leader.lastStatement!.slice(0, 250)}"`),
  ].join('\n') || 'No new correspondence.';

  annexTopic ??= c.leader.reportTopic;
  const annex = annexTopic && !compact ? `\nANNEX: DETAILED REPORT ON ${annexTopic.toUpperCase()}\n${detailedReport(w, s, iso, annexTopic)}\n` : '';
  // commitments in force (treaties are promises; record of any broken) — kept separate from the outcome ledger
  const mine = w.commitments.filter(x => x.from === iso);
  const commitments = [
    ...mine.filter(x => x.broken == null).slice(-6).map(x => `- ${x.kind.replace('_', ' ')} with ${nm(w, x.to)} since ${monthLabel(w.startDate, x.turn)}`),
    ...mine.filter(x => x.broken != null).slice(-3).map(x => `- BROKEN: ${x.kind.replace('_', ' ')} with ${nm(w, x.to)} (${monthLabel(w.startDate, x.broken!)})`),
    ...w.sanctions.filter(q => q.by === iso && !q.un).slice(0, 4).map(q => `- sanctions in force against ${nm(w, q.target)}`),
    ...(c.standingOrders ?? []).map(o => `- standing order: if ${o.when} → ${o.do.type}${o.do.target ? ' ' + o.do.target : ''}`),
  ].join('\n') || 'None.';
  return fill(tpl('briefing.txt'), {
    country: c.name, month, constitution: compact ? `${c.constitution.govType.replace(/_/g, ' ')}; ${c.constitution.howPowerHeld}` : describeConstitution(c),
    situation, economy, domestic, intel: (compact ? intel.slice(0, 2) : intel).join('\n') || 'No significant foreign threats identified.', diplomacy: compact ? diplomacy.split('\n')[0] : diplomacy, inbox,
    notes: c.rejections.length ? c.rejections.map(r => '- ' + r).join('\n') : 'All orders were executed.',
    commitments, memory: c.leader.memory ? c.leader.memory.split('\n').slice(-6).join('\n') : 'This is your first briefing in office.', annex,
  });
}

export function detailedReport(w: World, s: Statics, iso: string, topic: string): string {
  const c = w.countries[iso], t = topic.toLowerCase();
  if (w.countries[topic.toUpperCase()]) {
    const o = w.countries[topic.toUpperCase()];
    return `${o.name}: government ${o.govType.replace(/_/g, ' ')}, GDP ${usd(o.gdp)}, growth ${pct(o.growth)}, inflation ${pct(o.inflation)}, public mood ${LADDER[o.stage]}, mobilisation ${o.mobilized > 0.2 ? 'yes' : 'no'}, nuclear-armed ${o.nuclear ? 'yes' : 'no'}. Their view of us: ${(w.attitudes[o.iso3][iso] ?? 0) > 30 ? 'friendly' : (w.attitudes[o.iso3][iso] ?? 0) < -30 ? 'hostile' : 'neutral'}.`;
  }
  const reg = s.regions.find(r => r.name.toLowerCase() === t);
  if (reg) { const r = w.regions[reg.id]; return `${reg.name}: population ${(r.pop / 1e6).toFixed(2)}m, controlled by ${nm(w, r.controller)}, unrest ${r.unrest > 60 ? 'high' : r.unrest > 30 ? 'moderate' : 'low'}, terrain ${reg.terrain}, resources ${Object.entries(reg.res).filter(([, v]) => v).map(([k]) => k).join(', ') || 'few'}${reg.group ? `, majority ${reg.group}` : ''}.`; }
  if (/milit|defen|army/.test(t)) return `Active personnel ${(c.personnel / 1e3).toFixed(0)}k; equipment stock ${usd(c.milStock)}; readiness ${(c.readiness * 100).toFixed(0)}%; mobilisation ${(c.mobilized * 100).toFixed(0)}%; nuclear deterrent ${c.nuclear ? 'yes' : 'no'}.`;
  if (/econ|budget|financ/.test(t)) return `Potential growth ${pct(c.potentialGrowth)}; policy rate stance ${c.policyRate > 0 ? 'tight' : c.policyRate < 0 ? 'loose' : 'neutral'}; corruption ${c.corruption > 0.6 ? 'endemic' : c.corruption > 0.4 ? 'significant' : 'contained'}; organised crime ${c.crime > 0.5 ? 'pervasive' : 'present'}.`;
  return c.blocs.map(b => `${b.name}: approval ${b.realApproval.toFixed(0)}%, unrest ${b.unrest.toFixed(0)}/100, influence ${b.influence > 0.3 ? 'high' : 'normal'}.`).join('\n') + `\nSuppressed discontent: ${c.suppressed > 30 ? 'substantial' : 'low'}.`;
}
