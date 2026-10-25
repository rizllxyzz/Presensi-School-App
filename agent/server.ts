// The agent as a local HTTP service.
//
// Why a server: the PHP app (Apache) and this agent are two runtimes. Instead
// of shelling out to `tsx` on every request (slow), the app POSTs the teacher's
// question here and gets an answer back. The agent stays local and lightweight;
// only the language model call goes out to the network.
//
//   node --experimental-sqlite server.ts        (or: npm run agent)
//
// Endpoints:
//   GET  /health        liveness + engine source + memory count
//   POST /sync          (re)load the school attendance DB into memory
//   POST /ask           { question, topN? } -> { answer, mode, provider, provenance[], trace[] }

import "./src/env.ts";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHMEM } from "./src/engine.ts";
import type { Hmem } from "./src/agent.ts";
import { runAgent } from "./src/agent.ts";
import { loadIntoMemory, dbPath } from "./src/school-data.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AGENT_PORT ?? 8788);
const AGENT_TOKEN = String(process.env.AGENT_SHARED_TOKEN ?? '');

type HmemWithAdd = Hmem & { add: (i: unknown) => unknown };

async function main(): Promise<void> {
  const { HMEM } = await loadHMEM();
  const hmem = new HMEM({ persistDir: path.join(here, ".notebook") }) as HmemWithAdd;

  // Seed memory from the attendance DB at startup so the agent is useful
  // immediately. Cheap: ~a few dozen rows.
  try {
    const r = await loadIntoMemory(hmem);
    console.log(`[agent] memory seeded from ${dbPath()}: ${r.added} fakta, ${r.students} siswa, ${r.anomalies} anomali`);
  } catch (err) {
    console.error(`[agent] seed skipped: ${(err as Error).message}`);
  }

  const server = http.createServer(async (req, res) => {
    const send = (code: number, obj: unknown) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(body);
    };

    try {
      if (req.method === "GET" && req.url === "/health") {
        return send(200, { ok: true, db: dbPath() });
      }

      if ((req.method === "POST" && (req.url === "/sync" || req.url === "/ask")) && AGENT_TOKEN !== '' && req.headers['x-agent-token'] !== AGENT_TOKEN) {
        return send(401, { ok: false, error: "unauthorized" });
      }

      if (req.method === "POST" && req.url === "/sync") {
        const r = await loadIntoMemory(hmem);
        return send(200, { ok: true, ...r });
      }

      if (req.method === "POST" && req.url === "/ask") {
        const body = await readJson(req);
        const question = String(body.question ?? "").trim();
        if (!question) return send(400, { ok: false, error: "question kosong" });

        const topN = Number(body.topN ?? 8);
        const r = await runAgent(question, hmem, topN);

        return send(200, {
          ok: true,
          answer: r.answer,
          mode: r.mode,
          provider: r.provider ?? null,
          strategy: r.strategy,
          provenance: r.provenance,
          iterations: r.iterations,
          sufficient: r.sufficient,
          trace: r.trace,
        });
      }

      return send(404, { ok: false, error: "not found" });
    } catch (err) {
      return send(500, { ok: false, error: (err as Error).message });
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[agent] listening on http://127.0.0.1:${PORT}`);
  });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("payload too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
