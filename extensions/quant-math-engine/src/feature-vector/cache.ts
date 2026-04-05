import type { QuantFeatureVector } from "../schema/QuantFeatureVector.js";

interface CacheEntry {
  vector: QuantFeatureVector;
  expiresAt: number;
}

export interface FeatureVectorCache {
  get(symbol: string): QuantFeatureVector | null;
  set(symbol: string, vector: QuantFeatureVector): void;
  invalidate(symbol: string): void;
  clear(): void;
}

/**
 * Creates an in-process TTL cache for QuantFeatureVector objects.
 * Uses a Map keyed by symbol; expired entries are lazily evicted on `get`.
 */
export function createFeatureVectorCache(ttlMs: number): FeatureVectorCache {
  const store = new Map<string, CacheEntry>();

  return {
    get(symbol: string): QuantFeatureVector | null {
      const entry = store.get(symbol);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(symbol);
        return null;
      }
      return entry.vector;
    },

    set(symbol: string, vector: QuantFeatureVector): void {
      store.set(symbol, { vector, expiresAt: Date.now() + ttlMs });
    },

    invalidate(symbol: string): void {
      store.delete(symbol);
    },

    clear(): void {
      store.clear();
    },
  };
}
