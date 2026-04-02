import type { ForkContext, ChatMessage, ToolResult } from './types.js';

export const CI_LOGS_TOOL = {
  name: 'ci_logs',
  description:
    'Fetch GitHub Actions logs and diagnose failures using the local LLM — without raw logs entering Claude\'s context window.\n\n' +
    'Requires the `gh` CLI to be authenticated.\n\n' +
    'WHEN TO USE:\n' +
    '\u2022 Use INSTEAD of `gh run view --log` or `gh run view --log-failed` — raw logs will flood Claude\'s context\n' +
    '\u2022 A CI run or job has failed and you want to know why\n' +
    '\u2022 Build/test output is too large to paste directly\n\n' +
    'TIPS:\n' +
    '\u2022 Omit run_id/job_id to auto-find the latest failed run (optionally filter by workflow/branch)\n' +
    '\u2022 Use runs: 2-3 to detect flaky failures vs. consistently broken\n' +
    '\u2022 Override filter to match language-specific patterns (e.g. "panic:|FAIL " for Go)',
  inputSchema: {
    type: 'object' as const,
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in owner/repo format, e.g. "acme/my-app". Optional — omit to auto-detect from the current git remote.',
      },
      run_id: {
        type: 'string',
        description: 'GitHub Actions run ID. Use for all failed steps of a specific run.',
      },
      job_id: {
        type: 'string',
        description: 'GitHub Actions job ID. Returns full logs for that job only.',
      },
      workflow: {
        type: 'string',
        description: 'Workflow file name (e.g. "ci.yml"). Auto-finds the latest failed run when run_id is omitted.',
      },
      branch: {
        type: 'string',
        description: 'Branch to filter by when auto-resolving runs. Only used when run_id is omitted.',
      },
      runs: {
        type: 'number',
        description: 'Number of recent failed runs to analyze (1–3). Default 1. Use 2–3 to detect flaky vs. consistently broken.',
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
        description: 'When true, append the filtered log sent to the LLM after the analysis. Useful for verifying the LLM is not hallucinating.',
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
 * Call the GitHub Jobs API to find which steps within a job concluded with 'failure'.
 * Returns null (non-fatal) if the API call fails or no failed steps are found.
 */
async function fetchFailedStepNames(
  jobId: string,
  repo: string | undefined,
  ctx: ForkContext,
): Promise<Set<string> | null> {
  const repoPath = repo ?? ':owner/:repo';
  try {
    const { stdout } = await ctx.execFileAsync(
      'gh',
      ['api', `repos/${repoPath}/actions/jobs/${jobId}`],
      { timeout: 15_000, maxBuffer: 512 * 1024 },
    );
    const data = JSON.parse(stdout) as { steps?: Array<{ name: string; conclusion: string }> };
    const failed = (data.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => s.name);
    return failed.length > 0 ? new Set(failed) : null;
  } catch {
    return null;
  }
}

export async function handleCiLogs(
  args: unknown,
  ctx: ForkContext,
  progressToken?: string | number,
): Promise<ToolResult> {
  const {
    repo,
    run_id,
    job_id,
    workflow,
    branch,
    runs: wantedRuns = 1,
    filter,
    context_lines,
    debug = false,
  } = args as {
    repo?: string;
    run_id?: string;
    job_id?: string;
    workflow?: string;
    branch?: string;
    runs?: number;
    filter?: string;
    context_lines?: number;
    debug?: boolean;
  };

  const repoArgs = repo ? ['--repo', repo] : [];

  // Compile filter regex
  const pattern = filter ?? DEFAULT_FILTER;
  let filterRe: RegExp;
  try {
    filterRe = new RegExp(pattern, 'i');
  } catch {
    return { isError: true, content: [{ type: 'text', text: `Invalid filter regex: ${pattern}` }] };
  }

  const ctxLines = context_lines ?? 3;
  const runCount = Math.min(Math.max(1, wantedRuns), 3);

  // Resolve which runs to analyze
  type RunTarget = { id: string; title: string; runBranch: string };
  let resolvedRuns: RunTarget[];

  if (job_id) {
    resolvedRuns = [];  // job_id path bypasses run resolution
  } else if (run_id) {
    resolvedRuns = [{ id: run_id, title: run_id, runBranch: branch ?? '' }];
  } else {
    // Auto-resolve: find the N most recent failed runs via gh run list
    const listArgs = [
      'run', 'list',
      '--json', 'databaseId,displayTitle,headBranch',
      '--status', 'failure',
      '--limit', String(runCount * 3),
      ...repoArgs,
    ];
    if (workflow) listArgs.push('--workflow', workflow);
    if (branch)   listArgs.push('--branch', branch);

    let listStdout: string;
    try {
      ({ stdout: listStdout } = await ctx.execFileAsync('gh', listArgs, { timeout: 20_000, maxBuffer: 1024 * 1024 }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: 'text', text: `gh run list failed: ${msg}` }] };
    }

    let failedRuns: Array<{ databaseId: number; displayTitle: string; headBranch: string }>;
    try {
      failedRuns = JSON.parse(listStdout);
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'Failed to parse gh run list output.' }] };
    }

    const selected = failedRuns.slice(0, runCount);
    if (selected.length === 0) {
      const what = [workflow && `workflow "${workflow}"`, branch && `branch "${branch}"`].filter(Boolean).join(', ');
      return { content: [{ type: 'text', text: `No failed runs found${what ? ` for ${what}` : ''}.` }] };
    }
    resolvedRuns = selected.map((r) => ({ id: String(r.databaseId), title: r.displayTitle, runBranch: r.headBranch }));
  }

  // Determine gh invocations
  type GhTarget = { ghArgs: string[]; label: string };
  const targets: GhTarget[] = job_id
    ? [{
        ghArgs: run_id
          ? ['run', 'view', run_id, '--log', ...repoArgs, '--job', job_id]
          : ['run', 'view', '--log', ...repoArgs, '--job', job_id],
        label: `job ${job_id}`,
      }]
    : resolvedRuns.map((r) => ({
        ghArgs: ['run', 'view', r.id, '--log-failed', ...repoArgs],
        label: resolvedRuns.length > 1 ? `run ${r.id} — ${r.title} (${r.runBranch})` : `run ${r.id}`,
      }));

  const route = await ctx.routeToModel('analysis');

  // When a specific job is targeted, fetch per-step conclusions from the Jobs API so we can
  // slice the log to only the steps that actually failed. Non-fatal if the API call fails.
  const failedStepNames = job_id ? await fetchFailedStepNames(job_id, repo, ctx) : null;

  const sections: string[] = [];
  let totalSteps = 0;

  for (const { ghArgs, label } of targets) {
    let rawLog: string;
    try {
      ({ stdout: rawLog } = await ctx.execFileAsync('gh', ghArgs, { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sections.push(targets.length > 1 ? `## ${label}\n(fetch failed: ${msg})` : `fetch failed: ${msg}`);
      continue;
    }

    if (!rawLog.trim()) {
      sections.push(targets.length > 1
        ? `## ${label}\n(no output — run may have succeeded or logs may have expired)`
        : 'No failed-step logs found — the run may have succeeded or logs may have expired.');
      continue;
    }

    const cleanLog = rawLog
      .replace(/\x1b\[[0-9;]*m/g, '')                    // strip ANSI colour codes
      .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/gm, '');  // strip leading ISO timestamps

    const logSections = splitIntoSections(cleanLog);

    let assembled: string;
    if (logSections.length > 0) {
      // Structural path: keep only the steps that failed (or all steps when step info is unavailable)
      const relevant = failedStepNames
        ? logSections.filter((s) => failedStepNames.has(s.name))
        : logSections;
      const usedSections = relevant.length > 0 ? relevant : logSections;
      const perSectionBudget = Math.max(10_000, Math.floor(MAX_LOG_BUDGET / usedSections.length));
      totalSteps += usedSections.length;
      assembled = usedSections
        .map((s) => `##[group]${s.name}\n${applyCharBudget(s.content, perSectionBudget)}`)
        .join('\n\n');
    } else {
      // Fallback: no ##[group] markers — use the legacy regex-filter pipeline
      totalSteps += 1;
      const groupFiltered = filterByGroup(cleanLog, filterRe);
      let { filtered, matchCount } = filterLines(groupFiltered, filterRe, ctxLines);
      if (matchCount > ESCALATION_THRESHOLD && !filter) {
        const errorsOnlyRe = new RegExp(ERRORS_ONLY_FILTER, 'i');
        const { filtered: escalated, matchCount: escalatedCount } = filterLines(groupFiltered, errorsOnlyRe, ctxLines);
        if (escalatedCount < matchCount) filtered = escalated;
      }
      // Append the test-framework summary block if present and not already covered
      const testSummary = extractTestSummary(cleanLog);
      if (testSummary && !filtered.includes(testSummary.slice(0, 60))) {
        filtered += '\n\n--- test summary ---\n' + testSummary;
      }
      assembled = applyCharBudget(capLines(deduplicateLines(filtered), LINE_CAP), MAX_LOG_BUDGET);
    }

    sections.push(targets.length > 1 ? `## ${label}\n${assembled}` : assembled);
  }

  if (sections.length === 0) {
    return { content: [{ type: 'text', text: 'No logs could be fetched.' }] };
  }

  const combinedLog = sections.join('\n\n---\n\n');
  const isMultiRun = resolvedRuns.length > 1;

  const systemContent = [
    isMultiRun
      ? 'You are a CI failure analyst reviewing multiple runs. First identify: are failures consistent across all runs (systemic) or only in some (flaky)? Then provide root cause and fix.'
      : 'You are a CI failure analyst. Diagnose the build/test failure from the log excerpt and provide:\n1. Root cause — what failed and why, referencing the step name from ##[group] headers where visible\n2. Fix — the specific change needed\n3. If relevant: what to verify after applying the fix\nBe concise. Reference step names and line numbers where visible.\nOnly reference information explicitly present in the log excerpt. If the root cause is not visible in the excerpt, say so — do not invent error messages, file paths, or fixes.',
    route.hints.outputConstraint ?? '',
  ].filter(Boolean).join('\n');

  const repoLine = repo ? `Repository: ${repo}\n` : '';
  const targetLabel = job_id ? `job ${job_id}` : resolvedRuns.map((r) => r.id).join(', ');
  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: `${repoLine}Target: ${targetLabel}\n\nLog sections (${totalSteps} step${totalSteps !== 1 ? 's' : ''}):\n\`\`\`\n${combinedLog}\n\`\`\``,
    },
  ];

  try {
    const resp = await ctx.chatCompletionStreaming(messages, {
      temperature: route.hints.chatTemp,
      maxTokens: Math.min(ctx.adaptiveMaxTokens(combinedLog.length, route.contextLength), CI_ANALYSIS_MAX_TOKENS),
      model: route.modelId,
      progressToken,
    });
    const footer = `\n\n(${totalSteps} step${totalSteps !== 1 ? 's' : ''} from ${job_id ? 'job' : isMultiRun ? `${resolvedRuns.length} runs` : 'run'} logs)` +
      ctx.formatFooter(resp);
    const debugSection = debug
      ? `\n\n---\n**Debug — filtered log sent to LLM (${combinedLog.length} chars):**\n\`\`\`\n${combinedLog}\n\`\`\``
      : '';
    return {
      content: [{
        type: 'text',
        text: resp.content + footer + debugSection,
      }],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}
