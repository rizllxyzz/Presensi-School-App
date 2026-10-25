// The attendance agent's decision loop.
//
// This is the part that makes it an agent rather than a one-shot retriever.
// A single question runs through a closed loop with a critique step:
//
//   1. PLAN      turn the question into focused retrieval queries
//   2. RETRIEVE  query H-MEM for each, merge and de-duplicate by relevance
//   3. EVALUATE  judge whether the evidence is enough to answer
//   4. REVISE    if not enough, write a sharper query and loop back (bounded)
//   5. REPORT    phrase the final answer, citing memory ids as evidence
//
// Every step is timed and recorded in a `trace`, so the caller — and the
// judges — can see how the system reached its output instead of trusting a
// black box. The loop is bounded (MAX_ITERATIONS) and every model role
// degrades to an offline heuristic when no key is configured, so a run never
// hangs on the network.

import type { Evaluation, Provider } from "./llm.ts";
import { answer, evaluate, pickProvider, planQueries } from "./llm.ts";

/** The slice of the H-MEM engine this loop depends on (structurally typed). */
export interface Hmem {
  query(
    query: string,
    opts?: { topN?: number; threshold?: number },
  ): {
    memories: { memory: { id: string; content: string }; relevance: number }[];
    context: string;
    trace: { strategy: string };
  };
}

export interface TraceStep {
  step: "plan" | "retrieve" | "evaluate" | "revise" | "report";
  detail: string;
  ms: number;
}

export interface AgentResult {
  answer: string;
  mode: "retrieval-only" | "model";
  provider?: string;
  strategy: string;
  provenance: string[];
  iterations: number;
  sufficient: boolean;
  trace: TraceStep[];
}

/** How many retrieve→evaluate passes we allow before reporting anyway. */
const MAX_ITERATIONS = 2;

export async function runAgent(question: string, hmem: Hmem, topN = 8): Promise<AgentResult> {
  const provider: Provider | null = pickProvider();
  const trace: TraceStep[] = [];
  const found = new Map<string, { id: string; relevance: number; content: string }>();

  // --- 1. PLAN -------------------------------------------------------------
  let planStart = Date.now();
  const queries = await planQueries(question, provider);
  trace.push({
    step: "plan",
    detail: `${provider ? provider.name : "offline"} menyusun kueri: ${queries.join(" | ")}`,
    ms: Date.now() - planStart,
  });

  let strategy = "";
  let context = "";
  let evaluation: Evaluation = { sufficient: false, missing: "belum dievaluasi", refinedQuery: question };
  let iteration = 0;

  for (iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    // --- 2. RETRIEVE -------------------------------------------------------
    const retrieveStart = Date.now();
    let queriesThisRound = queries.slice();
    for (const q of queriesThisRound) {
      const r = hmem.query(q, { topN, threshold: 0.05 });
      if (r.trace?.strategy) strategy = r.trace.strategy;
      if (r.context) context = r.context;
      for (const m of r.memories) {
        const prev = found.get(m.memory.id);
        if (!prev || m.relevance > prev.relevance) {
          found.set(m.memory.id, { id: m.memory.id, relevance: m.relevance, content: m.memory.content });
        }
      }
    }
    const ranked = rank(found, topN);
    trace.push({
      step: "retrieve",
      detail: `iterasi ${iteration}: ${queriesThisRound.length} kueri, ${ranked.length} memori relevan`,
      ms: Date.now() - retrieveStart,
    });

    // --- 3. EVALUATE -------------------------------------------------------
    const evalStart = Date.now();
    const topRelevance = ranked[0]?.relevance ?? 0;
    evaluation = await evaluate(question, context, provider, topRelevance);
    trace.push({
      step: "evaluate",
      detail: evaluation.sufficient
        ? "bukti dinilai cukup untuk menjawab"
        : `bukti dinilai kurang: ${evaluation.missing || "tidak ada alasan"}`,
      ms: Date.now() - evalStart,
    });

    if (evaluation.sufficient) break;

    // --- 4. REVISE (loop back with a sharper query) ------------------------
    if (iteration < MAX_ITERATIONS) {
      const refined = evaluation.refinedQuery.trim();
      if (refined && refined !== question) {
        queries.length = 0;
        queries.push(refined);
        trace.push({ step: "revise", detail: `kueri baru: ${refined}`, ms: 0 });
      } else {
        trace.push({ step: "revise", detail: "tidak ada kueri yang lebih tajam; berhenti iterasi", ms: 0 });
        break;
      }
    }
  }

  // --- 5. REPORT -----------------------------------------------------------
  const reportStart = Date.now();
  const ranked = rank(found, topN);
  const memories = ranked.map((m) => ({ relevance: m.relevance, content: m.content }));
  const res = await answer(question, context, memories);
  trace.push({
    step: "report",
    detail: `${res.mode === "model" ? res.provider : "retrieval-only"} menyusun jawaban dari ${ranked.length} memori`,
    ms: Date.now() - reportStart,
  });

  return {
    answer: res.text,
    mode: res.mode,
    provider: res.provider,
    strategy,
    provenance: ranked.map((m) => m.id),
    iterations: iteration,
    sufficient: evaluation.sufficient,
    trace,
  };
}

function rank(
  found: Map<string, { id: string; relevance: number; content: string }>,
  topN: number,
): { id: string; relevance: number; content: string }[] {
  return [...found.values()].sort((a, b) => b.relevance - a.relevance).slice(0, topN);
}
