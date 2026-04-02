import { stat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ForkContext, ChatMessage, ToolResult } from './types.js';
import { normalizePaths } from '../normalize-paths.js';
import { embedText, cosineSimilarity } from './embed-utils.js';
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

/** Enumerate all files under dirs, optionally filtered by a *.ext glob pattern. No file cap. */
async function enumerateFiles(dirs: string[], fileGlob?: string): Promise<string[]> {
  const globRe = fileGlob ? fileGlobToRegex(fileGlob) : null;
  const results: string[] = [];
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (globRe && !globRe.test(entry.name)) continue;
        results.push(join(entry.parentPath ?? dir, entry.name));
      }
    } catch { /* skip unreadable dirs */ }
  }
  return results;
}

function fileGlobToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^$[\]\\()]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
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

  // Resolve input paths (handles JSON-encoded arrays from MCP clients)
  // Then enumerate files directly with readdir — bypasses normalizePaths' 20-file cap
  let filePaths: string[];
  try {
    const dirs = await normalizePaths(rawPaths);
    filePaths = await enumerateFiles(dirs, file_glob);
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
      // Index by chunk_idx — guards against gaps if a prior embed was partial
      const byIdx = new Map(cached.map((c) => [c.chunk_idx, c]));
      for (const chunk of fileChunks) {
        const cv = byIdx.get(chunk.chunk_idx);
        if (cv) allChunks.push({ file: filePath, startLine: chunk.startLine, content: cv.content, vector: cv.vector });
      }
    } else {
      embeddedFiles++;
      const embedded: Array<{ chunk_idx: number; content: string; vector: number[] }> = [];
      let allSucceeded = true;
      for (const chunk of fileChunks) {
        try {
          const { vector } = await embedText(chunk.content);
          allChunks.push({ file: filePath, startLine: chunk.startLine, content: chunk.content, vector });
          embedded.push({ chunk_idx: chunk.chunk_idx, content: chunk.content, vector });
        } catch {
          allSucceeded = false; // don't cache partial results
        }
      }
      // Only cache when every chunk embedded successfully — prevents permanent gaps
      if (embedded.length > 0 && allSucceeded) {
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

  const uniqueFiles = new Set(topChunks.map((c) => c.file)).size;
  const cacheNote = embeddedFiles > 0
    ? ` (embedded ${embeddedFiles} new file${embeddedFiles !== 1 ? 's' : ''}, ${cachedFiles} from cache)`
    : ' (all from cache)';

  try {
    const resp = await ctx.chatCompletionStreaming(messages, {
      temperature: route.hints.chatTemp,
      maxTokens: ctx.adaptiveMaxTokens(excerpts.length + task.length, route.contextLength),
      model: route.modelId,
      progressToken,
    });
    return {
      content: [{
        type: 'text',
        text: resp.content +
          `\n\n(semantic search: ${allChunks.length} chunks across ${filePaths.length} files, top ${top_k} from ${uniqueFiles} file${uniqueFiles !== 1 ? 's' : ''}${cacheNote})` +
          ctx.formatFooter(resp),
      }],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}
