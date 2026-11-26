// Seeded RNG (mulberry32) + small math helpers. Every random draw in the engine goes through Rng.
export class Rng {
  s: number;
  constructor(seed: number | string) { this.s = typeof seed === 'number' ? seed >>> 0 : hash(seed); }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  chance(p: number) { return this.next() < p; }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(a: number, b: number) { return Math.floor(this.range(a, b + 1)); }
  pick<T>(xs: T[]): T { return xs[Math.floor(this.next() * xs.length)]; }
  normal() { return Math.sqrt(-2 * Math.log(this.next() + 1e-12)) * Math.cos(2 * Math.PI * this.next()); }
  weighted<T extends string>(w: Record<T, number>): T {
    const ks = Object.keys(w) as T[]; const tot = ks.reduce((s, k) => s + Math.max(0, w[k]), 0);
    let r = this.next() * tot;
    for (const k of ks) { r -= Math.max(0, w[k]); if (r <= 0) return k; }
    return ks[ks.length - 1];
  }
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const clamp = (x: number, a = 0, b = 100) => Math.max(a, Math.min(b, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function km(a: [number, number], b: [number, number]) {
  const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(start: string, turn: number) {
  const [y, m] = start.split('-').map(Number); const t = (m - 1) + turn;
  return `${MONTHS[t % 12]} ${y + Math.floor(t / 12)}`;
}
