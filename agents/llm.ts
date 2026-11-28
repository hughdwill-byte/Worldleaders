// Provider layer: one OpenAI-compatible chat endpoint for every provider, plus an RPM/RPD request queue,
// 429 backoff, a persisted daily counter and an optional cost tracker. Configured from .env.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
loadEnv();

export const BASE_URLS: Record<string, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  anthropic: 'https://api.anthropic.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
};
const DEFAULT_MODELS: Record<string, string> = {
  gemini: 'gemini-3.5-flash-lite', anthropic: 'claude-haiku-5-5', groq: 'llama-3.3-70b-versatile',
  openrouter: 'meta-llama/llama-3.3-70b-instruct:free', ollama: 'llama3.1', mock: 'mock',
};

export const config = {
  // getters so CLI flags / CI inputs that set process.env late still apply
  get provider() { return (process.env.PROVIDER || 'mock').toLowerCase(); },
  get model() { return process.env.MODEL || DEFAULT_MODELS[this.provider] || ''; },
  get apiKey() { return process.env.API_KEY || ''; },
  get baseUrl() { return process.env.BASE_URL || ''; },
  get rpm() { return Number(process.env.RPM || 10); },
  get rpd() { return Number(process.env.RPD || 250); },
  get priceIn() { return Number(process.env.PRICE_IN_PER_M || 0); },     // USD per million input tokens
  get priceOut() { return Number(process.env.PRICE_OUT_PER_M || 0); },
  get maxSpend() { return Number(process.env.MAX_SPEND_USD || 0); },
};

export class QuotaExhausted extends Error { name = 'QuotaExhausted'; }
export class SpendLimit extends Error { name = 'SpendLimit'; }
/** Provider down/overloaded after retries: the run stops cleanly (progress saved) and resumes later. */
export class ProviderUnavailable extends QuotaExhausted { name = 'ProviderUnavailable'; }

export interface ChatResult { text: string; inTokens: number; outTokens: number; costUsd: number }
export type Progress = (msg: string, waitMs?: number) => void;

const QUOTA_FILE = path.join(ROOT, 'runs', '.quota.json');
// Free-tier daily quotas reset at midnight US Pacific time.
const quotaDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
// Free-tier quotas are per model, so the counter is too.
function readQuota(): { day: string; provider: string; used: number; spent: number } {
  const key = `${config.provider}/${config.model}`;
  try { const q = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8')); if (q.day === quotaDay() && q.provider === key) return q; } catch { /* first use */ }
  return { day: quotaDay(), provider: key, used: 0, spent: 0 };
}
function writeQuota(q: ReturnType<typeof readQuota>) { fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true }); fs.writeFileSync(QUOTA_FILE, JSON.stringify(q)); }
export const quotaLeft = () => Math.max(0, config.rpd - readQuota().used);

// ---- Rate-aware scheduler: up to CONCURRENCY requests in flight, within RPM and TPM; AIMD on 429 ----
const recent: number[] = [];                    // request start times (last 60 s)
const recentTok: [number, number][] = [];       // [time, estimated tokens] (last 60 s)
let inFlight = 0, conc = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const maxConc = () => Math.max(1, Number(process.env.CONCURRENCY || 4));
const tpm = () => Number(process.env.TPM || 0);  // 0 = no token-per-minute limit configured
export const stats = { calls: 0, retries429: 0, retries503: 0, waitedMs: 0 };

async function acquire(estTokens: number, onProgress?: Progress) {
  if (!conc) conc = maxConc();
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > 60_000) recent.shift();
    while (recentTok.length && now - recentTok[0][0] > 60_000) recentTok.shift();
    const tokUsed = recentTok.reduce((a, x) => a + x[1], 0);
    const rpmOk = recent.length < config.rpm, tpmOk = !tpm() || tokUsed + estTokens <= tpm(), slot = inFlight < conc;
    if (rpmOk && tpmOk && slot) { inFlight++; recent.push(now); recentTok.push([now, estTokens]); return; }
    const wait = !slot ? 250 : !rpmOk ? 60_000 - (now - recent[0]) + 50 : 60_000 - (now - recentTok[0][0]) + 50;
    if (wait > 1000) onProgress?.(`waiting ${Math.ceil(wait / 1000)}s for rate limit`, wait);
    stats.waitedMs += wait; await sleep(wait);
  }
}
const release = (ok: boolean) => { inFlight--; if (ok && conc < maxConc()) conc++; };     // additive increase…
const backoff = () => { conc = Math.max(1, Math.floor(conc / 2)); };                        // …multiplicative decrease

export interface ChatOpts { json?: boolean; maxTokens?: number; secondary?: boolean }
/** Secondary model (headlines, narrative, constitutions) — SECONDARY_PROVIDER/SECONDARY_MODEL/SECONDARY_API_KEY, else the main one. */
function target(secondary?: boolean) {
  const p = secondary && process.env.SECONDARY_PROVIDER ? process.env.SECONDARY_PROVIDER.toLowerCase() : config.provider;
  const same = p === config.provider && !(secondary && process.env.SECONDARY_MODEL);
  return { provider: p, model: same ? config.model : process.env.SECONDARY_MODEL || DEFAULT_MODELS[p], key: same ? config.apiKey : process.env.SECONDARY_API_KEY || config.apiKey,
    base: same ? (config.baseUrl || BASE_URLS[p]) : (process.env.SECONDARY_BASE_URL || BASE_URLS[p]) };
}

export async function chat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], onProgress?: Progress, totalSpent = 0, opts: ChatOpts = {}): Promise<ChatResult> {
  if (config.provider === 'mock') throw new Error('chat() called in mock mode');
  const t = target(opts.secondary);
  if (t.provider !== 'ollama' && !t.key) throw new Error('API_KEY is not set (see .env.example)');
  const q = readQuota();
  if (q.used >= config.rpd) throw new QuotaExhausted(`Daily request quota (${config.rpd}) used up; resets at midnight Pacific time.`);
  if (config.maxSpend && totalSpent >= config.maxSpend) throw new SpendLimit(`MAX_SPEND_USD (${config.maxSpend}) reached.`);
  const est = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4) + (opts.maxTokens ?? 1200);
  let jsonMode = opts.json && process.env.JSON_MODE !== 'off';
  for (let attempt = 0; ; attempt++) {
    await acquire(est, onProgress);
    let ok = false;
    try {
      const qq = readQuota(); qq.used++; writeQuota(qq); stats.calls++;
      let r: Response;
      try {
        r = await fetch(`${t.base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(t.key ? { authorization: `Bearer ${t.key}` } : {}) },
          body: JSON.stringify({ model: t.model, messages, temperature: 0.7, max_tokens: opts.maxTokens ?? Number(process.env.MAX_OUTPUT_TOKENS || 1200), ...(jsonMode ? { response_format: { type: 'json_object' } } : {}) }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e) {
        if (attempt >= 3) throw new ProviderUnavailable(`Provider unreachable after retries (${(e as Error).message}).`);
        onProgress?.(`network error, retrying (${(e as Error).message})`); await sleep(5000 * 2 ** attempt + Math.random() * 1000); continue;
      }
      if (r.status === 400 && jsonMode) { jsonMode = false; continue; } // provider rejects JSON mode: fall back to plain text + local repair
      if (r.status === 429) {
        const body = await r.text(); stats.retries429++; backoff();
        if (/per.?day|daily|PerDay/i.test(body)) { const q2 = readQuota(); q2.used = config.rpd; writeQuota(q2); throw new QuotaExhausted('Provider reports daily quota exhausted.'); }
        if (attempt >= 5) throw new QuotaExhausted('Rate limited repeatedly (429).');
        const wait = Number(r.headers.get('retry-after')) * 1000 || 10_000 * 2 ** attempt;
        onProgress?.(`rate limited (429), waiting ${Math.ceil(wait / 1000)}s`, wait); await sleep(wait); continue;
      }
      if (r.status === 503 || r.status === 529 || r.status === 500) {
        await r.text(); stats.retries503++;
        if (attempt >= 3) throw new ProviderUnavailable(`Model overloaded (${r.status}); try again later or set MODEL to another model.`);
        const wait = 5000 * 2 ** attempt * (0.5 + Math.random()); // jittered backoff
        onProgress?.(`model busy (${r.status}), retrying in ${Math.ceil(wait / 1000)}s`, wait); await sleep(wait); continue;
      }
      if (!r.ok) throw new Error(`Provider error ${r.status}: ${(await r.text()).slice(0, 300)}`);
      let j: any;
      try { j = await r.json(); } catch (e) { if (attempt >= 3) throw new ProviderUnavailable(`Provider response failed (${(e as Error).message}).`); continue; }
      const inTokens = j.usage?.prompt_tokens ?? 0, outTokens = j.usage?.completion_tokens ?? 0;
      const costUsd = (inTokens * config.priceIn + outTokens * config.priceOut) / 1e6;
      const q3 = readQuota(); q3.spent += costUsd; writeQuota(q3);
      ok = true;
      return { text: j.choices?.[0]?.message?.content ?? '', inTokens, outTokens, costUsd };
    } finally { release(ok); }
  }
}

/** Minimal .env loader (no dependency). Never logs values. */
function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
