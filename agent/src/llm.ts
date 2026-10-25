// Model access for the attendance agent.
//
// The agent uses a language model in FOUR roles (see src/agent.ts):
//   planner    - turn a teacher's question into focused retrieval queries
//   reporter   - phrase the final answer, citing memories as <mem-N>
//   evaluator  - judge whether the retrieved evidence is enough to answer
//   (none)     - when no key is present the whole thing runs retrieval-only
//
// Every role goes through the same callModel() here, so adding a provider is
// one branch in pickProvider(). No key is ever required: each role degrades
// to a deterministic offline heuristic, and the memory spine (H-MEM) works
// fully offline. A model only changes how the work is phrased and how well
// the loop can critique itself.

export interface AnswerResult {
  mode: "retrieval-only" | "model";
  provider?: string;
  text: string;
}

export interface Provider {
  name: string;
  endpoint: string;
  key: string;
  model: string;
}

export interface Evaluation {
  /** Did the retrieved evidence look enough to answer the question? */
  sufficient: boolean;
  /** Short reason when it is not (used for the trace, never shown raw to users). */
  missing: string;
  /** A sharper query to try on the next loop iteration. */
  refinedQuery: string;
}

const SYSTEM_PROMPT_REPORTER =
  "Kamu adalah asisten presensi sekolah. Jawab HANYA berdasarkan konteks memori yang diberikan. " +
  "Sebutkan id memori secara inline saat memakai fakta. Jangan mengarang. " +
  "Kalau konteks tidak cukup, katakan terus terang. Jawab ringkas dalam bahasa Indonesia.";

const SYSTEM_PROMPT_PLANNER =
  "Kamu menyusun kueri pencarian untuk basis memori absensi sekolah. " +
  "Ubah pertanyaan guru menjadi 1-3 kueri pencarian singkat yang berorientasi kata kunci " +
  "(nama siswa, tanggal, jenis kejadian seperti masuk, pulang, terlambat, izin, lokasi). " +
  "Balas HANYA kueri, satu per baris, tanpa penomoran, tanpa penjelasan.";

const SYSTEM_PROMPT_EVALUATOR =
  "Kamu menilai apakah konteks memori yang diberikan sudah cukup untuk menjawab pertanyaan guru. " +
  "Balas HANYA satu objek JSON: {\"cukup\": true|false, \"alasan\": \"...\", \"kueri_baru\": \"...\"}. " +
  "Isi kueri_baru dengan kueri pencarian yang lebih tajam bila cukup=false, atau string kosong bila cukup=true.";

/** Which provider to use, by key precedence. NVIDIA is a hackathon sponsor, so it wins when present. */
export function pickProvider(): Provider | null {
  // Nightshift/Meterless is preferred when configured. It can serve
  // NVIDIA Nemotron through its OpenAI-compatible local/runtime endpoint.
  if (process.env.NIGHTSHIFT_API_KEY && process.env.NIGHTSHIFT_BASE_URL) {
    return {
      name: "nightshift-meterless+nvidia-nemotron",
      endpoint: process.env.NIGHTSHIFT_BASE_URL.replace(/\/$/, "") + "/chat/completions",
      key: process.env.NIGHTSHIFT_API_KEY,
      model: process.env.NIGHTSHIFT_MODEL ?? process.env.NVIDIA_MODEL ?? "nvidia/llama-3.3-nemotron-super-49b-v1",
    };
  }
  if (process.env.NVIDIA_API_KEY) {
    return {
      name: "nvidia-nemotron",
      // NVIDIA NIM is OpenAI-compatible (build.nvidia.com).
      endpoint: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1/chat/completions",
      key: process.env.NVIDIA_API_KEY,
      model: process.env.NVIDIA_MODEL ?? "nvidia/llama-3.3-nemotron-super-49b-v1",
    };
  }
  if (process.env.GROQ_API_KEY) {
    return {
      name: "groq",
      endpoint: "https://api.groq.com/openai/v1/chat/completions",
      key: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
    };
  }
  if (process.env.GEMINI_API_KEY) {
    return {
      name: "gemini",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      key: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      name: "openai",
      endpoint: "https://api.openai.com/v1/chat/completions",
      key: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    };
  }
  return null;
}

/** True when a language model will be used (any provider key present). */
export function hasModel(): boolean {
  return pickProvider() !== null;
}

/**
 * Planner role: turn one question into up to three focused retrieval queries.
 * Offline (no provider) the single query is the question itself.
 */
export async function planQueries(question: string, provider: Provider | null): Promise<string[]> {
  if (!provider) return [question];
  try {
    const raw = await callModel(provider, SYSTEM_PROMPT_PLANNER, `Pertanyaan guru: ${question}`, 200);
    const lines = raw
      .split("\n")
      .map((l) => l.replace(/^[\s\-*•\d.)]+/, "").trim())
      .filter((l) => l.length > 0)
      .slice(0, 3);
    return lines.length ? lines : [question];
  } catch {
    return [question];
  }
}

/**
 * Evaluator role: decide whether the retrieved context answers the question,
 * and if not, propose a sharper query. Offline the decision is a relevance
 * threshold on the top memory.
 */
export async function evaluate(
  question: string,
  context: string,
  provider: Provider | null,
  topRelevance: number,
): Promise<Evaluation> {
  const heuristic: Evaluation = {
    sufficient: topRelevance >= 0.35,
    missing: topRelevance >= 0.35 ? "" : "relevansi memori tertinggi rendah (" + topRelevance.toFixed(2) + ")",
    refinedQuery: question,
  };
  if (!provider) return heuristic;
  try {
    const raw = await callModel(
      provider,
      SYSTEM_PROMPT_EVALUATOR,
      `Pertanyaan: ${question}\n\nKonteks memori:\n${context || "(kosong)"}`,
      250,
    );
    const obj = extractJson(raw);
    if (!obj) return heuristic;
    const cukupRaw = obj.cukup;
    const sufficient = cukupRaw === true || String(cukupRaw).toLowerCase() === "true";
    return {
      sufficient,
      missing: String(obj.alasan ?? "").slice(0, 300),
      refinedQuery: String(obj.kueri_baru ?? "").trim() || question,
    };
  } catch {
    return heuristic;
  }
}

/**
 * Reporter role: phrase the final answer from the memory context, citing
 * memories. Falls back to a plain listing when no provider is configured.
 */
export async function answer(
  question: string,
  memoryContext: string,
  memories: { relevance: number; content: string }[],
): Promise<AnswerResult> {
  const provider = pickProvider();

  if (provider) {
    try {
      const text = await callModel(
        provider,
        SYSTEM_PROMPT_REPORTER,
        `${memoryContext}\n\nPertanyaan: ${question}`,
        500,
      );
      return { mode: "model", provider: provider.name, text };
    } catch (err) {
      return {
        mode: "retrieval-only",
        provider: provider.name,
        text: `${retrievalOnly(question, memories)}\n\n(${provider.name} dipanggil tapi gagal: ${(err as Error).message})`,
      };
    }
  }

  return { mode: "retrieval-only", text: retrievalOnly(question, memories) };
}

async function callModel(
  provider: Provider,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  let lastErr: Error = new Error("no attempt made");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800 * attempt));
    const res = await fetch(provider.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.key}`,
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (res.status === 429 || res.status === 503) {
      lastErr = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      continue; // transient: retry
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (text) return text;
    lastErr = new Error("empty answer");
  }
  throw lastErr;
}

/** Pull the first JSON object out of a model reply that may wrap it in prose or code fences. */
function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function retrievalOnly(question: string, memories: { relevance: number; content: string }[]): string {
  if (memories.length === 0) {
    return `Belum ada memori yang bisa menjawab "${question}".`;
  }
  const lines = [`Berdasarkan yang saya ingat tentang "${question}":`];
  for (const m of memories) lines.push(`- ${m.content} (relevance ${m.relevance.toFixed(2)})`);
  return lines.join("\n");
}
