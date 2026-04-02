/**
 * gh-safe.ts — allowlist validator for gh CLI commands.
 *
 * Used by ci-logs to ensure only read-only `gh` invocations are
 * constructed or executed. Any command that could mutate GitHub state
 * (cancel, delete, rerun, non-GET API calls, etc.) is rejected.
 *
 * Accepts an args array (as passed to execFile/execFileAsync) — no shell
 * string parsing, no subprocess execution.
 */

const SHELL_METACHARACTERS = /[|;&$`\\><()\n\r]/;

/** Subcommand trees that are read-only and explicitly permitted. */
const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'run view',
  'run list',
]);

/** Flags permitted alongside allowed subcommands. Values after these flags are also accepted. */
const ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  '--log',
  '--log-failed',
  '--job',
  '--json',
  '--repo',
  '--status',
  '--workflow',
  '--branch',
  '--limit',
  '--paginate',
  '--jq',
  '--method',   // only GET accepted — enforced separately
  '-X',         // alias for --method — only GET accepted
]);

/**
 * Returns true iff the args array represents a safe, read-only `gh` invocation.
 *
 * Rules:
 * - First element must be "gh"
 * - Second + third elements must form an allowed subcommand (e.g. "run view")
 * - No element may contain shell metacharacters
 * - All elements must be strings
 * - `--method` / `-X` value must be "GET"
 */
export function isSafeGhCommand(args: unknown[]): boolean {
  if (!Array.isArray(args) || args.length < 3) return false;
  if (!args.every((a) => typeof a === 'string')) return false;

  const strArgs = args as string[];
  if (strArgs[0] !== 'gh') return false;

  // Check for shell metacharacters in any argument
  if (strArgs.some((a) => SHELL_METACHARACTERS.test(a))) return false;

  const subcommand = `${strArgs[1]} ${strArgs[2]}`;
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) return false;

  // Validate flags and check --method / -X are read-only
  let i = 3;
  while (i < strArgs.length) {
    const arg = strArgs[i];
    if (arg.startsWith('-')) {
      if (!ALLOWED_FLAGS.has(arg)) return false;
      if (arg === '--method' || arg === '-X') {
        const method = strArgs[i + 1];
        if (method !== 'GET') return false;
        i += 2;
        continue;
      }
      // Flags that consume a value
      if (['--job', '--json', '--repo', '--status', '--workflow', '--branch', '--limit', '--jq'].includes(arg)) {
        i += 2; // skip flag + value
        continue;
      }
    }
    i++;
  }

  return true;
}
