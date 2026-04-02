import os from 'os';
import path from 'path';
import type { ForkContext, ToolResult } from './types.js';
import { isSafeGhCommand } from './gh-safe.js';

const SAFE_RUN_ID = /^\d+$/;
const SAFE_REPO   = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

export const CI_LOGS_TOOL = {
  name: 'ci_logs',
  description:
    'Diagnose GitHub Actions CI failures using the local LLM — raw logs never enter Claude\'s context.\n\n' +
    'Requires the `gh` CLI to be authenticated.\n\n' +
    'TWO-STEP WORKFLOW:\n' +
    '1. Call ci_logs (with optional run_id/job_id/workflow/branch) — returns a Bash download command\n' +
    '2. Run that Bash command to download logs to /tmp\n' +
    '3. Call ci_logs(log_file="/tmp/ci_<id>.txt") — returns LLM diagnosis\n' +
    'IMPORTANT: Always proceed to step 3 even if the Bash command exits non-zero. Do NOT run additional gh or shell commands to investigate — the local LLM will diagnose any download errors in the file.\n\n' +
    'TIPS:\n' +
    '\u2022 Omit run_id/job_id to auto-find the latest failed run\n' +
    '\u2022 Override filter to match language-specific patterns (e.g. "panic:|FAIL " for Go)\n' +
    '\u2022 Use debug: true to inspect what the LLM received',
  inputSchema: {
    type: 'object' as const,
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in owner/repo format, e.g. "acme/my-app". Optional — omit to auto-detect from the current git remote.',
      },
      run_id: {
        type: 'string',
        description: 'GitHub Actions run ID. Skips auto-resolution when provided.',
      },
      job_id: {
        type: 'string',
        description: 'GitHub Actions job ID. Fetches full logs for that job only.',
      },
      workflow: {
        type: 'string',
        description: 'Workflow file name (e.g. "ci.yml"). Filters auto-resolution when run_id is omitted.',
      },
      branch: {
        type: 'string',
        description: 'Branch to filter by when auto-resolving runs.',
      },
      log_file: {
        type: 'string',
        description:
          'Path to a log file under /tmp previously downloaded via Bash. ' +
          'The file is read, analyzed, and deleted by this tool.',
      },
      filter: {
        type: 'string',
        description: 'Extended-regex filter applied to log lines. Defaults to common failure patterns.',
      },
      context_lines: {
        type: 'number',
        description: 'Lines of context to include around each match. Default: 3.',
      },
      debug: {
        type: 'boolean',
        description: 'When true, append the filtered log sent to the LLM after the analysis.',
      },
    },
    required: [],
  },
};

const DEFAULT_FILTER =
  '##\\[error\\]|##\\[warning\\]' +
  // Generic
  '|Error:|error:|FAILED|failed|FAIL[\\t ]|Exception|assert|panic:|fatal:|TypeError|SyntaxError|Cannot find|No such file' +
  // Rust / Cargo
  '|error\\[E\\d+\\]|could not compile' +
  // Java / Maven / Gradle
  '|BUILD FAILURE|COMPILATION ERROR|Failed to execute goal' +
  // C# / MSBuild / dotnet
  '|error CS\\d+|MSB\\d+' +
  // Python
  '|ModuleNotFoundError|ImportError|FAILED tests/' +
  // PHP
  '|PHP (?:Parse|Fatal) error' +
  // Ruby / Bundler
  '|Bundler::GemNotFound|could not load such file';
const ERRORS_ONLY_FILTER =
  '##\\[error\\]' +
  // Generic
  '|Error:|error:|FAILED|failed|FAIL[\\t ]|Exception|assert|panic:|fatal:|TypeError|SyntaxError|Cannot find|No such file' +
  // Rust / Cargo
  '|error\\[E\\d+\\]|could not compile' +
  // Java / Maven / Gradle
  '|BUILD FAILURE|COMPILATION ERROR|Failed to execute goal' +
  // C# / MSBuild / dotnet
  '|error CS\\d+|MSB\\d+' +
  // Python
  '|ModuleNotFoundError|ImportError|FAILED tests/' +
  // PHP
  '|PHP (?:Parse|Fatal) error' +
  // Ruby / Bundler
  '|Bundler::GemNotFound|could not load such file';
const ESCALATION_THRESHOLD = 150; // lines — when exceeded with default filter, drop ##[warning] and re-filter
const LINE_CAP = 250;             // max lines for the regex-fallback path
const CI_ANALYSIS_MAX_TOKENS = 600;
const MAX_LOG_BUDGET = 150_000;   // total chars across all sections sent to the analysis LLM

const TEST_SUMMARY_MARKERS = [
  /={3,} (?:short test summary info|FAILURES|ERRORS) ={3,}/i, // pytest
  /^Tests run: \d+, Failures: [1-9]/m,                         // Maven Surefire failure summary
  /^> Task :.+ FAILED$/m,                                       // Gradle task failure
];
const TEST_SUMMARY_MAX_LINES = 200;

/**
 * Find the highest-signal test failure summary block — the tail of the log starting from a
 * well-known test-framework summary header. Returns null if none is found.
 */
function extractTestSummary(log: string): string | null {
  let earliest = -1;
  for (const marker of TEST_SUMMARY_MARKERS) {
    const m = marker.exec(log);
    if (m && (earliest === -1 || m.index < earliest)) earliest = m.index;
  }
  if (earliest === -1) return null;
  const tail = log.slice(earliest).split('\n').slice(0, TEST_SUMMARY_MAX_LINES).join('\n');
  return tail;
}

function filterLines(raw: string, re: RegExp, ctxLines: number): { filtered: string; matchCount: number } {
  const allLines = raw.split('\n');
  const matched: string[] = [];
  let lastEnd = -1;

  for (let i = 0; i < allLines.length; i++) {
    if (re.test(allLines[i])) {
      const start = Math.max(lastEnd + 1, i - ctxLines);
      const end = Math.min(allLines.length - 1, i + ctxLines);
      if (matched.length > 0 && start > lastEnd + 1) matched.push('---');
      matched.push(...allLines.slice(start, end + 1));
      lastEnd = end;
      i = end;
    }
  }

  const matchCount = matched.filter((l) => l !== '---').length;
  if (matched.length === 0) {
    const tail = allLines.slice(-400);
    return {
      filtered: `(no lines matched filter — showing last ${tail.length} lines)\n` + tail.join('\n'),
      matchCount: 0,
    };
  }
  return { filtered: matched.join('\n'), matchCount };
}

/**
 * Discard log sections from CI steps that contain no error-matching lines.
 * GitHub Actions annotates steps with ##[group]<name> ... ##[endgroup].
 * Sections outside any group (runner preamble/metadata) are kept unconditionally.
 * Falls back to the original log if no group markers are present.
 */
function filterByGroup(raw: string, re: RegExp): string {
  if (!raw.includes('##[group]')) return raw;
  const lines = raw.split('\n');
  const out: string[] = [];
  let inGroup = false;
  let groupHasError = false;
  let groupLines: string[] = [];

  for (const line of lines) {
    if (line.includes('##[group]')) {
      inGroup = true;
      groupHasError = false;
      groupLines = [line];
    } else if (line.includes('##[endgroup]')) {
      groupLines.push(line);
      if (groupHasError) out.push(...groupLines);
      inGroup = false;
      groupLines = [];
    } else if (inGroup) {
      groupLines.push(line);
      if (re.test(line)) groupHasError = true;
    } else {
      out.push(line);
    }
  }
  if (groupLines.length > 0 && groupHasError) out.push(...groupLines);
  return out.join('\n');
}

// 5% head preserves the step/group header line; 95% tail captures the failure output.
// Test results and error output almost always appear at the END of a CI step, after build/compile noise.
function applyCharBudget(log: string, budget: number): string {
  if (log.length <= budget) return log;
  const headBudget = Math.floor(budget * 0.05);
  const tailBudget = budget - headBudget;
  const omitted = log.length - budget;
  return log.slice(0, headBudget) + `\n\n...(${omitted} chars omitted)...\n\n` + log.slice(-tailBudget);
}

/** Keep first 1/3 + last 2/3 of lines when the filtered log exceeds maxLines. */
function capLines(log: string, maxLines: number): string {
  const lines = log.split('\n');
  if (lines.length <= maxLines) return log;
  const headCount = Math.floor(maxLines / 3);
  const tailCount = maxLines - headCount;
  const omitted = lines.length - maxLines;
  return [
    ...lines.slice(0, headCount),
    `...(${omitted} lines omitted)...`,
    ...lines.slice(lines.length - tailCount),
  ].join('\n');
}

/** Collapse repeated error patterns — strips timestamps/coords for grouping, annotates repeats with ×N. */
function deduplicateLines(log: string): string {
  const normalize = (line: string): string =>
    line
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>')
      .replace(/0x[0-9a-fA-F]+/g, '<hex>')
      .replace(/:\d+:\d+/g, ':<loc>')
      .replace(/\b\d+\b/g, '<n>')
      .trim();

  const lines = log.split('\n');
  const counts = new Map<string, { first: string; count: number }>();
  const order: string[] = [];

  for (const line of lines) {
    const key = normalize(line);
    if (counts.has(key)) {
      counts.get(key)!.count++;
    } else {
      counts.set(key, { first: line, count: 1 });
      order.push(key);
    }
  }

  return order
    .map((key) => {
      const { first, count } = counts.get(key)!;
      return count > 1 ? `${first}  (×${count})` : first;
    })
    .join('\n');
}

type LogSection = { name: string; content: string };

/**
 * Split a GitHub Actions log into per-step sections using ##[group]/##[endgroup] markers.
 * Returns an empty array if the log contains no group markers.
 */
function splitIntoSections(log: string): LogSection[] {
  if (!log.includes('##[group]')) return [];

  const lines = log.split('\n');
  const sections: LogSection[] = [];
  let name = '';
  let buf: string[] = [];
  let inGroup = false;

  for (const line of lines) {
    const m = line.match(/##\[group\](.*)/);
    if (m) {
      if (inGroup && buf.length > 0) sections.push({ name, content: buf.join('\n') });
      name = m[1].trim();
      buf = [line];
      inGroup = true;
    } else if (line.includes('##[endgroup]')) {
      if (inGroup) {
        buf.push(line);
        sections.push({ name, content: buf.join('\n') });
        name = '';
        buf = [];
        inGroup = false;
      }
    } else if (inGroup) {
      buf.push(line);
    }
  }
  // Handle unterminated last section (truncated logs)
  if (inGroup && buf.length > 0) sections.push({ name, content: buf.join('\n') });

  return sections;
}

/**
 * Validate that a log_file path is safe to read: must be absolute and under the system
 * temp directory (or /tmp as a fallback) to prevent arbitrary file reads.
 */
function validateLogFilePath(filePath: string): string | null {
  if (!path.isAbsolute(filePath)) return 'log_file must be an absolute path';
  const tmpDir = os.tmpdir();
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(tmpDir + path.sep) && !resolved.startsWith('/tmp/')) {
    return `log_file must be under ${tmpDir} or /tmp`;
  }
  return null;
}

export async function handleCiLogs(
  args: unknown,
  ctx: ForkContext,
  progressToken?: string | number,
): Promise<ToolResult> {
  const { repo, run_id, job_id, workflow, branch, filter, context_lines, debug = false, log_file } = args as {
    repo?: string;
    run_id?: string;
    job_id?: string;
    workflow?: string;
    branch?: string;
    filter?: string;
    context_lines?: number;
    debug?: boolean;
    log_file?: string;
  };

  if (run_id && !SAFE_RUN_ID.test(run_id))
    return { isError: true, content: [{ type: 'text', text: `Invalid run_id: must be numeric` }] };
  if (job_id && !SAFE_RUN_ID.test(job_id))
    return { isError: true, content: [{ type: 'text', text: `Invalid job_id: must be numeric` }] };
  if (repo && !SAFE_REPO.test(repo))
    return { isError: true, content: [{ type: 'text', text: `Invalid repo: must be "owner/repo" with alphanumeric, hyphens, dots, or underscores` }] };

  const repoArgs = repo ? ['--repo', repo] : [];

  // Compile filter regex (needed for analyze mode)
  const pattern = filter ?? DEFAULT_FILTER;
  let filterRe: RegExp;
  try {
    filterRe = new RegExp(pattern, 'i');
  } catch {
    return { isError: true, content: [{ type: 'text', text: `Invalid filter regex: ${pattern}` }] };
  }
  const ctxLines = context_lines ?? 3;

  // ── Analyze mode ────────────────────────────────────────────────────────────
  if (log_file) {
    const pathErr = validateLogFilePath(log_file);
    if (pathErr) return { isError: true, content: [{ type: 'text', text: pathErr }] };

    let rawLog: string;
    try {
      rawLog = await ctx.readFile(log_file, 'utf8');
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Could not read log_file: ${err instanceof Error ? err.message : String(err)}` }] };
    }
    // Log file stays in /tmp — OS will clean it up. Deleting here breaks debug re-runs.

    const route = await ctx.routeToModel('analysis');
    const cleanLog = rawLog
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/gm, '');
    const logSections = splitIntoSections(cleanLog);

    let assembled: string;
    let totalSteps: number;
    if (logSections.length > 0) {
      const perSectionBudget = Math.max(10_000, Math.floor(MAX_LOG_BUDGET / logSections.length));
      totalSteps = logSections.length;
      assembled = logSections
        .map((s) => `##[group]${s.name}\n${applyCharBudget(s.content, perSectionBudget)}`)
        .join('\n\n');
    } else {
      totalSteps = 1;
      const groupFiltered = filterByGroup(cleanLog, filterRe);
      let { filtered, matchCount } = filterLines(groupFiltered, filterRe, ctxLines);
      if (matchCount > ESCALATION_THRESHOLD && !filter) {
        const errorsOnlyRe = new RegExp(ERRORS_ONLY_FILTER, 'i');
        const { filtered: escalated, matchCount: escalatedCount } = filterLines(groupFiltered, errorsOnlyRe, ctxLines);
        if (escalatedCount < matchCount) filtered = escalated;
      }
      const testSummary = extractTestSummary(cleanLog);
      if (testSummary && !filtered.includes(testSummary.slice(0, 60))) {
        filtered += '\n\n--- test summary ---\n' + testSummary;
      }
      assembled = applyCharBudget(capLines(deduplicateLines(filtered), LINE_CAP), MAX_LOG_BUDGET);
    }

    const systemContent = [
      'You are a CI failure analyst. Diagnose the build/test failure from the log excerpt and provide:\n1. Root cause — what failed and why, referencing the step name from ##[group] headers where visible\n2. Fix — the specific change needed\n3. If relevant: what to verify after applying the fix\nBe concise. Reference step names and line numbers where visible.\nOnly reference information explicitly present in the log excerpt. If the root cause is not visible in the excerpt, say so — do not invent error messages, file paths, or fixes.',
      route.hints.outputConstraint ?? '',
    ].filter(Boolean).join('\n');
    const messages = [
      { role: 'system' as const, content: systemContent },
      { role: 'user' as const, content: `Log sections (${totalSteps} step${totalSteps !== 1 ? 's' : ''}):\n\`\`\`\n${assembled}\n\`\`\`` },
    ];
    try {
      const resp = await ctx.chatCompletionStreaming(messages, {
        temperature: route.hints.chatTemp,
        maxTokens: Math.min(ctx.adaptiveMaxTokens(assembled.length, route.contextLength), CI_ANALYSIS_MAX_TOKENS),
        model: route.modelId,
        progressToken,
      });
      const footer = `\n\n(${totalSteps} step${totalSteps !== 1 ? 's' : ''} from log file)` + ctx.formatFooter(resp);
      const debugSection = debug ? `\n\n---\n**Debug — filtered log sent to LLM (${assembled.length} chars):**\n\`\`\`\n${assembled}\n\`\`\`` : '';
      return { content: [{ type: 'text', text: resp.content + footer + debugSection }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }

  // ── Resolve mode ─────────────────────────────────────────────────────────────
  // Find the run ID if not provided, then return a Bash download instruction.
  // The log download goes through Claude's Bash tool (user approval), not houtini.
  let runId = run_id;
  if (!runId && !job_id) {
    const listArgs = [
      'run', 'list',
      '--json', 'databaseId,displayTitle,headBranch',
      '--status', 'failure',
      '--limit', '1',
      ...repoArgs,
    ];
    if (workflow) listArgs.push('--workflow', workflow);
    if (branch)   listArgs.push('--branch', branch);

    if (!isSafeGhCommand(['gh', ...listArgs]))
      return { isError: true, content: [{ type: 'text', text: 'Internal error: unsafe gh run list command blocked' }] };

    let listStdout: string;
    try {
      ({ stdout: listStdout } = await ctx.execFileAsync('gh', listArgs, { timeout: 20_000, maxBuffer: 1024 * 1024 }));
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `gh run list failed: ${err instanceof Error ? err.message : String(err)}` }] };
    }

    let runs: Array<{ databaseId: number; displayTitle: string; headBranch: string }>;
    try { runs = JSON.parse(listStdout); } catch {
      return { isError: true, content: [{ type: 'text', text: 'Failed to parse gh run list output.' }] };
    }
    if (runs.length === 0) {
      const what = [workflow && `workflow "${workflow}"`, branch && `branch "${branch}"`].filter(Boolean).join(', ');
      return { content: [{ type: 'text', text: `No failed runs found${what ? ` for ${what}` : ''}.` }] };
    }
    runId = String(runs[0].databaseId);
  }

  const tmpFile = `/tmp/ci_${runId ?? job_id}.txt`;

  const downloadArgs: string[] = ['run', 'view'];
  if (runId) downloadArgs.push(runId);
  if (job_id) { downloadArgs.push('--log', '--job', job_id); }
  else         { downloadArgs.push('--log-failed'); }
  if (repo)    downloadArgs.push('--repo', repo);

  if (!isSafeGhCommand(['gh', ...downloadArgs]))
    return { isError: true, content: [{ type: 'text', text: 'Internal error: unsafe gh download command blocked' }] };

  const ghCmd = `gh ${downloadArgs.join(' ')} > ${tmpFile} 2>&1`;

  return {
    content: [{
      type: 'text',
      text: `Download the logs first (keeps raw output out of Claude's context):\n\nBash: \`${ghCmd}\`\n\nThen call \`ci_logs(log_file="${tmpFile}")\` — do this even if the Bash command exits non-zero; the local LLM will diagnose errors in the output too. Do NOT run additional gh or shell commands to investigate.`,
    }],
  };
}
