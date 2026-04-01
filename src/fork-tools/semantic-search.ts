import { stat, readFile } from 'node:fs/promises';
import type { ForkContext, ChatMessage, ToolResult } from './types.js';
import { normalizePaths } from '../normalize-paths.js';
import { initEmbedCache, getCachedChunks, upsertChunks, flushEmbedCache } from './embed-cache.js';

export const SEMANTIC_SEARCH_TOOL = {
  name: 'semantic_search',
  description:
    'Search a codebase by concept using vector embeddings — answers questions like "find anything related to rate limiting" where no single keyword is reliable.\n\n' +
    'IMPORTANT — use ONLY when keyword search has already failed or is likely to fail:\n' +
    '\u2022 Prefer search_task or Grep for any query where you know a relevant symbol, function name, or term\n' +
    '\u2022 This tool is slower (embeds files on first use) and requires an embedding model to be loaded in LM Studio\n\n' +
    'WHEN THIS TOOL IS APPROPRIATE:\n' +
    '\u2022 Concept-based queries with no reliable keyword ("error handling strategy", "auth flow")\n' +
    '\u2022 Large unfamiliar codebases where grep returns too much noise\n\n' +
    'Embeddings are cached per-file by mtime — subsequent calls on unchanged files are fast.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Concept or question to search for semantically.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Absolute directory paths to search in (same format as search_task).',
      },
      task: {
        type: 'string',
        description: 'Question to answer using the retrieved excerpts.',
      },
      file_glob: {
        type: 'string',
        description: 'Optional file type filter, e.g. "*.ts" or "*.py".',
      },
      top_k: {
        type: 'number',
        description: 'Number of top chunks to retrieve. Default: 5.',
      },
    },
    required: ['query', 'paths', 'task'],
  },
};

const CHUNK_LINES = 50;
const CHUNK_OVERLAP = 10;
const EMBED_TIMEOUT_MS = 15_000;
const LM_BASE_URL = (process.env.LM_STUDIO_URL ?? 'http://localhost:1234').replace(/\/$/, '');

async function embedText(text: string): Promise<{ vector: number[]; modelId: string }> {
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

function chunkFile(lines: string[]): Array<{ chunk_idx: number; content: string; startLine: number }> {
  const chunks: Array<{ chunk_idx: number; content: string; startLine: number }> = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    if (slice.length === 0) break;
    chunks.push({ chunk_idx: chunks.length, content: slice.join('\n'), startLine: i + 1 });
  }
  return chunks;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export async function handleSemanticSearch(
  args: unknown,
  ctx: ForkContext,
  progressToken?: string | number,
): Promise<ToolResult> {
  const { query, paths: rawPaths, task, file_glob, top_k = 5 } = args as {
    query: string;
    paths: unknown;
    task: string;
    file_glob?: string;
    top_k?: number;
  };

  // Resolve paths — normalizePaths expands globs and handles JSON-encoded arrays
  // We need individual files, so pass file_glob as a synthetic glob if provided
  let filePaths: string[];
  try {
    const dirs = await normalizePaths(rawPaths);
    // Enumerate files inside each directory
    const globPatterns = dirs.map((d) =>
      file_glob ? `${d}/**/${file_glob}` : `${d}/**/*`,
    );
    const expanded = await normalizePaths(globPatterns);
    filePaths = expanded;
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Path resolution failed: ${err instanceof Error ? err.message : String(err)}` }] };
  }

  if (filePaths.length === 0) {
    return { content: [{ type: 'text', text: 'No files found in the specified paths.' }] };
  }

  await initEmbedCache();

  // Embed query first — fast-fail if no embedding model is loaded
  let queryVec: number[];
  let embedModelId: string;
  try {
    const result = await embedText(query);
    queryVec = result.vector;
    embedModelId = result.modelId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `${msg}\n\nLoad an embedding model in LM Studio and retry.` }] };
  }

  // Collect all chunks (from cache or fresh embed)
  interface ScoredChunk { file: string; startLine: number; content: string; score: number }
  const allChunks: Array<{ file: string; startLine: number; content: string; vector: number[] }> = [];
  let embeddedFiles = 0;
  let cachedFiles = 0;

  for (const filePath of filePaths) {
    let fileContent: string;
    let mtime: number;
    try {
      const [content, st] = await Promise.all([
        readFile(filePath, 'utf8'),
        stat(filePath),
      ]);
      fileContent = content;
      mtime = Math.floor(st.mtimeMs);
    } catch {
      continue; // skip unreadable files
    }

    const lines = fileContent.split('\n');
    const fileChunks = chunkFile(lines);

    const cached = getCachedChunks(filePath, mtime);
    if (cached) {
      cachedFiles++;
      for (let i = 0; i < fileChunks.length; i++) {
        const cv = cached[i];
        if (cv) allChunks.push({ file: filePath, startLine: fileChunks[i].startLine, content: cv.content, vector: cv.vector });
      }
    } else {
      embeddedFiles++;
      const embedded: Array<{ chunk_idx: number; content: string; vector: number[] }> = [];
      for (const chunk of fileChunks) {
        try {
          const { vector } = await embedText(chunk.content);
          allChunks.push({ file: filePath, startLine: chunk.startLine, content: chunk.content, vector });
          embedded.push({ chunk_idx: chunk.chunk_idx, content: chunk.content, vector });
        } catch {
          // skip chunk on embed failure
        }
      }
      if (embedded.length > 0) {
        upsertChunks(filePath, mtime, embedModelId, embedded);
      }
    }
  }

  flushEmbedCache();

  if (allChunks.length === 0) {
    return { content: [{ type: 'text', text: 'No chunks could be embedded from the specified files.' }] };
  }

  // Rank by cosine similarity
  const scored: ScoredChunk[] = allChunks.map((c) => ({
    file: c.file,
    startLine: c.startLine,
    content: c.content,
    score: cosineSimilarity(queryVec, c.vector),
  }));
  scored.sort((a, b) => b.score - a.score);
  const topChunks = scored.slice(0, top_k);

  const excerpts = topChunks
    .map((c, i) => `### Excerpt ${i + 1} — ${c.file}:${c.startLine} (score: ${c.score.toFixed(3)})\n\`\`\`\n${c.content}\n\`\`\``)
    .join('\n\n');

  const route = await ctx.routeToModel('analysis');
  const systemContent = [
    'You are a code analyst. Answer the question using only the provided code excerpts.',
    'Reference file paths and line numbers where relevant. Be specific and concise.',
    route.hints.outputConstraint ?? '',
  ].filter(Boolean).join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: `Question: ${task}\n\n${excerpts}` },
  ];

  const resp = await ctx.chatCompletionStreaming(messages, {
    temperature: route.hints.chatTemp,
    maxTokens: ctx.adaptiveMaxTokens(excerpts.length + task.length, route.contextLength),
    model: route.modelId,
    progressToken,
  });

  const uniqueFiles = new Set(topChunks.map((c) => c.file)).size;
  const cacheNote = embeddedFiles > 0
    ? ` (embedded ${embeddedFiles} new file${embeddedFiles !== 1 ? 's' : ''}, ${cachedFiles} from cache)`
    : ' (all from cache)';

  return {
    content: [{
      type: 'text',
      text: resp.content +
        `\n\n(semantic search: ${allChunks.length} chunks across ${filePaths.length} files, top ${top_k} from ${uniqueFiles} file${uniqueFiles !== 1 ? 's' : ''}${cacheNote})` +
        ctx.formatFooter(resp),
    }],
  };
}
