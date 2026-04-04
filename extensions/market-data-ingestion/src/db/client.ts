import pg from "pg";

const { Pool } = pg;
type Pool = InstanceType<typeof Pool>;

let pool: Pool | null = null;

/**
 * Returns the singleton pg Pool, creating it lazily on first call.
 * The connection URL is read from the `TIMESCALE_URL` environment variable
 * or defaults to `postgres://localhost:5432/trading`.
 *
 * Override the URL before the first call by setting `process.env.TIMESCALE_URL`.
 */
export function getPool(connectionUrl?: string): Pool {
  if (!pool) {
    const url =
      connectionUrl ?? process.env["TIMESCALE_URL"] ?? "postgres://localhost:5432/trading";
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

/** Closes the singleton pool. Should be called on plugin deactivation. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Typed parameterized query helper. Returns an array of typed rows. */
export async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}
