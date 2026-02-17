import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, withTransaction } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

async function ensureMigrationsTable() {
  const pool = createPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.end();
}

async function run() {
  await ensureMigrationsTable();

  const pool = createPool();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const alreadyApplied = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [version],
    );

    if (alreadyApplied.rowCount && alreadyApplied.rowCount > 0) {
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");

    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
    });

    // eslint-disable-next-line no-console
    console.log(`Applied migration ${version}`);
  }

  await pool.end();
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
