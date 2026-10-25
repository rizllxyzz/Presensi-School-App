// The research notebook agent: a CLI whose memory is real H-MEM.
// Every command maps to a named engine service, so this file doubles as a
// live tour of the spec. State persists in .notebook/ between invocations.
//
//   npx tsx notebook.ts remember "We chose SQLite because it needs no server"
//   npx tsx notebook.ts ask "what database did we pick"
//   npx tsx notebook.ts audit mem-1
//   npx tsx notebook.ts sleep --preview
//   npx tsx notebook.ts seed        # loads seed/example-session.txt

import "./src/env.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHMEM } from "./src/engine.ts";
import { runAgent } from "./src/agent.ts";
import { loadIntoMemory, dbPath } from "./src/school-data.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const TTY = process.stdout.isTTY === true;
const dim = (s: string) => (TTY ? `[2m${s}[0m` : s);
const green = (s: string) => (TTY ? `[32m${s}[0m` : s);

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const arg = rest.filter((a) => !a.startsWith("--")).join(" ");
  const { HMEM, source } = await loadHMEM();
  console.log(dim(`engine source: ${source} | state: .notebook/`));
  const hmem = new HMEM({ persistDir: path.join(here, ".notebook") });

  switch (command) {
    case "remember": {
      if (!arg) return usage();
      // MemoryMiningService: model-free extraction into short-term memory.
      const mined = await hmem.mine("chat_message", arg);
      if (mined.length === 0) {
        // Direct capture path: mining heuristics skipped it, store verbatim.
        const record = hmem.add({ content: arg, type: "general", source: "notebook:manual" });
        console.log(green(`remembered ${record.id}`) + ` [${record.layer}] ${record.content}`);
      } else {
        for (const m of mined) console.log(green(`mined ${m.id}`) + ` [${m.layer}] (${m.type}) ${m.content}` + dim(` confidence=${m.confidence}`));
      }
      break;
    }
    case "ask": {
      if (!arg) return usage();
      // The agent loop: plan -> retrieve -> evaluate -> (revise) -> report.
      const res = await runAgent(arg, hmem);
      console.log(dim(`mode: ${res.mode}${res.provider ? ` (${res.provider})` : ""} | strategy: ${res.strategy} | iterasi: ${res.iterations} | bukti cukup: ${res.sufficient}`));
      console.log(res.answer);
      if (res.trace.length) {
        console.log(dim("\njejak langkah:"));
        for (const t of res.trace) console.log(dim(`  - ${t.step}: ${t.detail} (${t.ms}ms)`));
      }
      if (res.provenance.length) {
        console.log(dim(`\nprovenance: ${res.provenance.join(", ")} (audit any of them: notebook audit <id>)`));
      }
      break;
    }
    case "audit": {
      if (!arg) return usage();
      // TrustLedgerService: the append-only history of one memory.
      const history = hmem.ledger.history(arg);
      if (history.length === 0) {
        console.log(`no ledger entries for ${arg}`);
        break;
      }
      for (const e of history) {
        const conf = e.newState?.confidence !== undefined ? ` confidence ${e.previousState?.confidence ?? "-"} -> ${e.newState.confidence}` : "";
        console.log(`- ${e.action} by ${e.actor} at ${new Date(e.timestamp).toISOString()}${conf}`);
      }
      break;
    }
    case "sleep": {
      // SleepCycleService: preview-first maintenance.
      const preview = hmem.sleep.preview();
      console.log("sleep plan (nothing applied):");
      console.log(`  consolidate: ${preview.toConsolidate.length} | archive: ${preview.toArchive.length} | synthesize: ${preview.toSynthesize.length} groups`);
      if (!rest.includes("--preview")) {
        const report = hmem.sleep.execute(preview);
        console.log(green(`executed with backup ${report.backupId}`));
      } else {
        console.log(dim("run without --preview to execute (a backup is taken first)"));
      }
      break;
    }
    case "seed": {
      const seedText = fs.readFileSync(path.join(here, "seed", "example-session.txt"), "utf-8");
      for (const line of seedText.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const mined = await hmem.mine("chat_message", line);
        for (const m of mined) console.log(green(`mined ${m.id}`) + ` ${m.content.slice(0, 70)}`);
      }
      console.log(dim('\nnow try: npx tsx notebook.ts ask "what did we decide about storage"'));
      break;
    }
    case "sync": {
      // Data layer: read the school SQLite database in place and mine facts.
      const result = await loadIntoMemory(hmem);
      console.log(green(`synced ${result.added} fakta`) + ` dari ${result.students} siswa (db: ${dbPath()})`);
      if (result.anomalies) {
        console.log(dim(`  ${result.anomalies} anomali: masuk tanpa catatan pulang`));
      }
      console.log(dim('now try: npx tsx notebook.ts ask "siswa mana yang masuk tanpa pulang?"'));
      break;
    }
    default:
      usage();
  }
}

function usage(): void {
  console.log(`the research notebook agent (memory: H-MEM)

  npx tsx notebook.ts seed                     load the example session
  npx tsx notebook.ts sync                     load the school attendance DB into memory
  npx tsx notebook.ts remember "<fact>"        mine a fact into memory
  npx tsx notebook.ts ask "<question>"         retrieve + answer with provenance
  npx tsx notebook.ts audit <memory-id>        the memory's full ledger history
  npx tsx notebook.ts sleep [--preview]        consolidation preview / run`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
