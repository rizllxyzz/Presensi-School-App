// Loads agent/.env into process.env if the file exists.
// Uses Node's built-in process.loadEnvFile (Node 20.12+/21.7+) so no
// dotenv dependency is needed. Missing file is fine: H-MEM runs offline
// and the answer path silently falls back to retrieval-only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

if (fs.existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.error(`warning: could not load ${envPath}: ${(err as Error).message}`);
  }
}
