import pg from "pg";

const { Pool } = pg;
type Pool = InstanceType<typeof import("pg").Pool>;

const pools = new Map<string, Pool>();

/** Returns a lazily-initialized pg Pool for the given TimescaleDB URL. */
export function getPool(url: string): Pool {
  const existing = pools.get(url);
  if (existing) return existing;
  const pool = new Pool({ connectionString: url });
  pools.set(url, pool);
  return pool;
}

/** Closes all open pools. */
export async function closePool(): Promise<void> {
  const closing = [...pools.values()].map((p) => p.end());
  pools.clear();
  await Promise.all(closing);
}

/** Typed parameterized query helper. */
export async function query<T>(pool: Pool, sql: string, params: unknown[]): Promise<T[]> {
  const result = await pool.query(sql, params as unknown[]);
  return result.rows as T[];
}
