// Applies supabase/migrations to the project in SUPABASE_DB_URL using the
// Supabase CLI. Local use only: the app never reads this variable, and it
// must not be set in Vercel. Pass --dry-run to preview.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

let url = process.env.SUPABASE_DB_URL;
if (!url) {
  try {
    for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      if (line.startsWith("SUPABASE_DB_URL=")) url = line.slice("SUPABASE_DB_URL=".length).trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env.local
  }
}
if (!url) {
  console.error("SUPABASE_DB_URL is empty. Set it in .env.local (Session pooler connection string).");
  process.exit(1);
}

const args = ["supabase", "db", "push", "--db-url", url, ...process.argv.slice(2)];
const result = spawnSync("npx", ["--yes", ...args], { stdio: "inherit", shell: process.platform === "win32", env: { ...process.env } });
process.exit(result.status ?? 1);
