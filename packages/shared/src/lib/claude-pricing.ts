// Claude API list prices, USD per 1M tokens. Cached from the Claude API
// reference (2026-06). These are public list prices; actual billing can differ
// with discounts, batch (50% off), or priority tiers — the Cost view labels its
// numbers as estimates accordingly.
export interface ModelPrice {
  /** $ / 1M input tokens (also the base for cache pricing). */
  input: number;
  /** $ / 1M output tokens. */
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  "claude-opus-4": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
};

// Cache pricing multipliers, relative to the model's base input rate (per the
// Claude prompt-caching reference): reads ≈ 0.1×, 5-minute writes 1.25×,
// 1-hour writes 2×.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;

/** Resolve a price for a model id, tolerating dated suffixes and unknown tiers. */
export function priceForModel(model: string): ModelPrice | null {
  if (PRICES[model]) return PRICES[model];
  // Dated snapshots / `-fast` variants: match the longest known prefix.
  let best: { key: string; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(PRICES)) {
    if (model.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  if (best) return best.price;
  // Family fallback for anything unrecognized.
  if (/fable|mythos/.test(model)) return { input: 10, output: 50 };
  if (/opus/.test(model)) return { input: 5, output: 25 };
  if (/sonnet/.test(model)) return { input: 3, output: 15 };
  if (/haiku/.test(model)) return { input: 1, output: 5 };
  return null;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Estimated USD cost for a bucket of token counts on a given model. */
export function estimateCost(model: string, t: TokenCounts): number {
  const p = priceForModel(model);
  if (!p) return 0;
  const dollars =
    t.input * p.input +
    t.output * p.output +
    t.cacheRead * p.input * CACHE_READ_MULT +
    t.cacheWrite5m * p.input * CACHE_WRITE_5M_MULT +
    t.cacheWrite1h * p.input * CACHE_WRITE_1H_MULT;
  return dollars / 1_000_000;
}
