/**
 * Allowlist guard for LLM-suggested gh commands.
 * Only read-only subcommands relevant to CI log investigation are permitted.
 * Exported separately so it can be unit-tested without a running LLM server.
 */
export function isSafeGhCommand(args: unknown[]): args is string[] {
  if (!args.every((a): a is string => typeof a === 'string')) return false;
  if (args[0] !== 'gh' || args.length < 2) return false;
  // Block shell metacharacters anywhere in the argument list
  if (args.some((a) => ['|', '>', '$', '`', ';', '&'].some((c) => (a as string).includes(c)))) return false;

  const sub = args[1];
  // gh run view / gh run list — always read-only
  if (sub === 'run' && (args[2] === 'view' || args[2] === 'list')) return true;
  // gh api — allow only when no non-GET HTTP method is specified
  if (sub === 'api') {
    for (let i = 2; i < args.length - 1; i++) {
      if (args[i] === '--method' || args[i] === '-X') {
        if ((args[i + 1] as string).toUpperCase() !== 'GET') return false;
      }
    }
    return true;
  }
  return false; // deny everything else (cancel, delete, rerun, release, issue, pr, etc.)
}
