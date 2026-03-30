/**
 * Normalize the `paths` argument from an MCP tool call.
 * MCP clients occasionally serialize arrays as JSON strings; this handles all cases:
 *   - string[]          → unchanged
 *   - '["a","b"]'       → ["a", "b"]   (JSON-encoded array)
 *   - '"path/to/file"'  → ["path/to/file"]  (JSON-encoded single string)
 *   - 'path/to/file'    → ["path/to/file"]  (plain string)
 *   - anything else     → [String(value)]
 */
export function normalizePaths(raw: unknown): string[] {
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
