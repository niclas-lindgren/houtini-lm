export const LM_BASE_URL = (process.env.LM_STUDIO_URL ?? 'http://localhost:1234').replace(/\/$/, '');
export const EMBED_TIMEOUT_MS = 15_000;

export async function embedText(text: string): Promise<{ vector: number[]; modelId: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${LM_BASE_URL}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Embed endpoint returned ${resp.status}: ${body}`);
  }
  const json = await resp.json() as { data?: Array<{ embedding?: number[] }>; model?: string };
  const vector = json.data?.[0]?.embedding;
  if (!vector?.length) throw new Error('No embedding returned — is an embedding model loaded?');
  return { vector, modelId: json.model ?? 'unknown' };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
