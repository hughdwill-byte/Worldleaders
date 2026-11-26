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
  gemini: 'gemini-3.8-flash', anthropic: 'claude-haiku-5-5', groq: 'llama-3.3-70b-versatile',
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

export interface ChatResult { text: string; inTokens: number; outTokens: number; costUsd: number }
export type Progress = (msg: string, waitMs?: number) => void;

const QUOTA_FILE = path.join(ROOT, 'runs', '.quota.json');
// Free-tier daily quotas reset at midnight US Pacific time.
const quotaDay = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
function readQuota(): { day: string; provider: string; used: number; spent: number } {
  try { const q = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8')); if (q.day === quotaDay() && q.provider === config.provider) return q; } catch { /* first use */ }
  return { day: quotaDay(), provider: config.provider, used: 0, spent: 0 };
}
function writeQuota(q: ReturnType<typeof readQuota>) { fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true }); fs.writeFileSync(QUOTA_FILE, JSON.stringify(q)); }
export const quotaLeft = () => Math.max(0, config.rpd - readQuota().used);

const recent: number[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function chat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], onProgress?: Progress, totalSpent = 0): Promise<ChatResult> {
  if (config.provider === 'mock') throw new Error('chat() called in mock mode');
  if (config.provider !== 'ollama' && !config.apiKey) throw new Error('API_KEY is not set (see .env.example)');
  const q = readQuota();
  if (q.used >= config.rpd) throw new QuotaExhausted(`Daily request quota (${config.rpd}) used up; resets at midnight Pacific time.`);
  if (config.maxSpend && totalSpent >= config.maxSpend) throw new SpendLimit(`MAX_SPEND_USD (${config.maxSpend}) reached.`);
  for (let attempt = 0; ; attempt++) {
    // RPM: wait until fewer than `rpm` requests in the last 60s
    for (;;) {
      const now = Date.now(); while (recent.length && now - recent[0] > 60_000) recent.shift();
      if (recent.length < config.rpm) break;
      const wait = 60_000 - (now - recent[0]) + 50;
      onProgress?.(`waiting ${Math.ceil(wait / 1000)}s for rate limit`, wait);
      await sleep(wait);
    }
    recent.push(Date.now());
    const qq = readQuota(); qq.used++; writeQuota(qq);
    let r: Response;
    try {
      r = await fetch(`${config.baseUrl || BASE_URLS[config.provider]}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
        body: JSON.stringify({ model: config.model, messages, temperature: 0.7, max_tokens: 2000 }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      if (attempt >= 3) throw e;
      onProgress?.(`network error, retrying (${(e as Error).message})`); await sleep(5000 * 2 ** attempt); continue;
    }
    if (r.status === 429 || r.status === 503 || r.status === 529) {
      const body = await r.text();
      if (/per.?day|daily|PerDay/i.test(body)) { const q2 = readQuota(); q2.used = config.rpd; writeQuota(q2); throw new QuotaExhausted('Provider reports daily quota exhausted.'); }
      if (attempt >= 5) throw new QuotaExhausted(`Rate limited repeatedly (${r.status}).`);
      const wait = Number(r.headers.get('retry-after')) * 1000 || 10_000 * 2 ** attempt;
      onProgress?.(`rate limited (${r.status}), waiting ${Math.ceil(wait / 1000)}s`, wait);
      await sleep(wait); continue;
    }
    if (!r.ok) throw new Error(`Provider error ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json() as any;
    const inTokens = j.usage?.prompt_tokens ?? 0, outTokens = j.usage?.completion_tokens ?? 0;
    const costUsd = (inTokens * config.priceIn + outTokens * config.priceOut) / 1e6;
    const q3 = readQuota(); q3.spent += costUsd; writeQuota(q3);
    return { text: j.choices?.[0]?.message?.content ?? '', inTokens, outTokens, costUsd };
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
