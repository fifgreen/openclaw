import fs from "node:fs/promises";

/**
 * Ensure the journal directory (and all parent directories) exist.
 * Safe to call multiple times — no-op if already exists.
 */
export async function ensureJournalDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
