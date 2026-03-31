import { readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';

/**
 * Normalize the `paths` argument from an MCP tool call.
 * MCP clients occasionally serialize arrays as JSON strings; this handles all cases:
 *   - string[]          → unchanged
 *   - '["a","b"]'       → ["a", "b"]   (JSON-encoded array)
 *   - '"path/to/file"'  → ["path/to/file"]  (JSON-encoded single string)
 *   - 'path/to/file'    → ["path/to/file"]  (plain string)
 *   - anything else     → [String(value)]
 *
 * After normalization, any path containing glob metacharacters (* ? {})
 * is expanded via expandGlob. Results are capped at 20 files to prevent
 * context explosion.
 */
export async function normalizePaths(raw: unknown): Promise<string[]> {
  const paths = normalizeRaw(raw);
  const expanded: string[] = [];
  for (const p of paths) {
    if (/[*?{]/.test(p)) {
      const matches = await expandGlob(p);
      expanded.push(...matches);
    } else {
      expanded.push(p);
    }
  }
  return expanded.slice(0, 20);
}

function normalizeRaw(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [raw];
    }
  }
  return [String(raw)];
}

/**
 * Expand a glob pattern to matching file paths.
 * Supports * (within segment), ** (any depth), ? (single char).
 * No external dependencies — uses Node 18.17+ recursive readdir.
 */
async function expandGlob(pattern: string): Promise<string[]> {
  // Find the base directory: everything before the first glob metachar segment
  const parts = pattern.split('/');
  const baseSegments: string[] = [];
  for (const part of parts) {
    if (/[*?{]/.test(part)) break;
    baseSegments.push(part);
  }
  const baseDir = baseSegments.join('/') || '/';
  const relPattern = parts.slice(baseSegments.length).join('/');

  let allFiles: string[];
  try {
    const entries = await readdir(baseDir, { recursive: true, withFileTypes: true });
    allFiles = entries
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath ?? dirname(join(baseDir, e.name)), e.name));
  } catch {
    return [];
  }

  const regex = globToRegex(relPattern);
  return allFiles.filter((f) => {
    const rel = f.slice(baseDir.length).replace(/^\//, '');
    return regex.test(rel);
  });
}

function globToRegex(pattern: string): RegExp {
  // Expand brace alternatives: {a,b} → (a|b)
  const expanded = expandBraces(pattern);
  const escaped = expanded
    .replace(/[.+^$[\]\\()]/g, '\\$&')  // escape regex special chars (not * ? {})
    .replace(/\*\*/g, '\x00')             // placeholder for **
    .replace(/\*/g, '[^/]*')              // * matches within one segment
    .replace(/\?/g, '[^/]')               // ? matches one non-slash char
    .replace(/\x00/g, '.*');              // ** matches across segments
  return new RegExp(`^${escaped}$`);
}

function expandBraces(pattern: string): string {
  const m = pattern.match(/\{([^{}]+)\}/);
  if (!m) return pattern;
  const [full, inner] = m;
  const alts = inner.split(',').map((a) => pattern.replace(full, a));
  return alts.map(expandBraces).join('|');
}

/** Synchronous variant used in contexts where async is not available (kept for compat). */
export function normalizePathsSync(raw: unknown): string[] {
  return normalizeRaw(raw);
}
