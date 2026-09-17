import { config } from "../config.js";

export interface Transcript {
  text: string;
  durationSeconds: number;
  costUsd: number;
}

export function sttEnabled(): boolean {
  return Boolean(config.STT_API_KEY);
}

/** OpenAI-compatible /audio/transcriptions (Groq by default). WhatsApp voice notes arrive as OGG/Opus. */
export async function transcribe(data: Buffer, mimeType: string): Promise<Transcript> {
  const form = new FormData();
  const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mpeg") ? "mp3" : mimeType.includes("mp4") ? "m4a" : "ogg";
  form.append("file", new Blob([new Uint8Array(data)], { type: mimeType.split(";")[0] ?? "audio/ogg" }), `voice.${ext}`);
  form.append("model", config.STT_MODEL);
  form.append("response_format", "verbose_json");

  const res = await fetch(`${config.STT_BASE_URL.replace(/\/$/, "")}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.STT_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`transkripsi gagal: HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
  }
  const json = (await res.json()) as { text?: string; duration?: number };
  const durationSeconds = Math.max(0, Number(json.duration ?? 0));
  return {
    text: (json.text ?? "").trim(),
    durationSeconds,
    costUsd: (durationSeconds / 3600) * config.STT_USD_PER_HOUR,
  };
}
