import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
// Re-export for consumers that need the Pool type
export type { Pool };

let pool: InstanceType<typeof Pool> | null = null;
let configuredUrl: string | undefined;

/**
 * Returns the singleton pg Pool. Creates it lazily on first call.
 * Pass `connectionUrl` on first call to override the default.
 * Connection URL is never logged.
 */
export function getPool(connectionUrl?: string): InstanceType<typeof Pool> {
  if (!pool) {
    const url =
      connectionUrl ??
      configuredUrl ??
      process.env["SENTIMENT_POSTGRES_URL"] ??
      "postgres://localhost:5432/trading";
    configuredUrl = url;
    pool = new Pool({ connectionString: url });
    pool.on("error", (err) => {
      console.error("[sentiment-intelligence] pg pool error:", err.message);
    });
  }
  return pool;
}

/** Sets the connection URL before the first `getPool()` call. */
export function configurePool(url: string): void {
  configuredUrl = url;
}

/** Closes the singleton pool. Should be called on plugin deactivation. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Typed parameterized query helper.
 * Returns an array of typed rows.
 */
export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

/**
 * Idempotently runs the initial migration SQL.
 * All statements use IF NOT EXISTS guards so re-running is safe.
 */
export async function runMigrations(p: InstanceType<typeof Pool>): Promise<void> {
  const migrationPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "migrations",
    "001_initial.sql",
  );
  const sql = await readFile(migrationPath, "utf8");
  // Execute statements sequentially; skip empty statements from splitting
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
  for (const stmt of statements) {
    await p.query(stmt);
  }
}
