import type { ForkContext, ChatMessage, ToolResult } from './types.js';

export const CI_LOGS_TOOL = {
  name: 'ci_logs',
  description:
    'Fetch GitHub Actions logs and diagnose failures using the local LLM — without raw logs entering Claude\'s context window.\n\n' +
    'Requires the `gh` CLI to be authenticated.\n\n' +
    'WHEN TO USE:\n' +
    '\u2022 A CI run or job has failed and you want to know why\n' +
    '\u2022 Build/test output is too large to paste directly\n\n' +
    'TIPS:\n' +
    '\u2022 Provide job_id alone for a specific job\'s full logs, or run_id alone for all failed steps\n' +
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
        description: 'GitHub Actions run ID. Use for all failed steps of a run. Provide this or job_id.',
      },
      job_id: {
        type: 'string',
        description: 'GitHub Actions job ID. Returns full logs for that job only. Provide this or run_id.',
      },
      filter: {
        type: 'string',
        description: 'Extended-regex filter applied to log lines. Defaults to common failure patterns.',
      },
      context_lines: {
        type: 'number',
        description: 'Lines of context to include around each match. Default: 3.',
      },
    },
    required: [],
  },
};

const DEFAULT_FILTER = 'Error:|error:|FAILED|failed|FAIL |Exception|assert|panic:|fatal:|TypeError|SyntaxError|Cannot find|No such file';
const MAX_LOG_LINES = 400;

export async function handleCiLogs(
  args: unknown,
  ctx: ForkContext,
  progressToken?: string | number,
): Promise<ToolResult> {
  const { repo, run_id, job_id, filter, context_lines } = args as {
    repo?: string;
    run_id?: string;
    job_id?: string;
    filter?: string;
    context_lines?: number;
  };

  if (!run_id && !job_id) {
    return { isError: true, content: [{ type: 'text', text: 'Provide either run_id or job_id.' }] };
  }

  // Build gh command:
  // - job_id alone: gh run view --log [--repo REPO] --job JOB_ID  (full job log, no --log-failed)
  // - run_id (with optional job_id filter): gh run view RUN_ID --log-failed [--repo REPO]
  // repo is optional — when omitted, gh infers from the current git remote
  const repoArgs = repo ? ['--repo', repo] : [];
  let ghArgs: string[];
  if (job_id && !run_id) {
    ghArgs = ['run', 'view', '--log', ...repoArgs, '--job', job_id];
  } else if (job_id && run_id) {
    ghArgs = ['run', 'view', run_id, '--log', ...repoArgs, '--job', job_id];
  } else {
    ghArgs = ['run', 'view', run_id!, '--log-failed', ...repoArgs];
  }

  let rawLog: string;
  try {
    const { stdout } = await ctx.execFileAsync('gh', ghArgs, { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 });
    rawLog = stdout;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `gh failed: ${msg}` }] };
  }

  if (!rawLog.trim()) {
    return { content: [{ type: 'text', text: 'No failed-step logs found — the run may have succeeded or logs may have expired.' }] };
  }

  // Compile filter regex safely
  const pattern = filter ?? DEFAULT_FILTER;
  let filterRe: RegExp;
  try {
    filterRe = new RegExp(pattern, 'i');
  } catch {
    return { isError: true, content: [{ type: 'text', text: `Invalid filter regex: ${pattern}` }] };
  }

  // Filter to failure-signal lines with context, deduplicating overlapping windows
  const ctxLines = context_lines ?? 3;
  const allLines = rawLog.split('\n');
  const matched: string[] = [];
  let lastEnd = -1;

  for (let i = 0; i < allLines.length; i++) {
    if (filterRe.test(allLines[i])) {
      const start = Math.max(lastEnd + 1, i - ctxLines);
      const end = Math.min(allLines.length - 1, i + ctxLines);
      if (matched.length > 0 && start > lastEnd + 1) matched.push('---');
      matched.push(...allLines.slice(start, end + 1));
      lastEnd = end;
      i = end;
    }
  }

  const matchCount = matched.filter((l) => l !== '---').length;
  let filteredLog: string;

  if (matched.length === 0) {
    const tail = allLines.slice(-MAX_LOG_LINES);
    filteredLog = `(no lines matched filter — showing last ${tail.length} lines)\n` + tail.join('\n');
  } else {
    const capped = matched.length > MAX_LOG_LINES
      ? matched.slice(0, MAX_LOG_LINES).concat([`... (truncated at ${MAX_LOG_LINES} of ${matched.length} lines)`])
      : matched;
    filteredLog = capped.join('\n');
  }

  const route = await ctx.routeToModel('analysis');
  const target = job_id ? `job ${job_id}` : `run ${run_id}`;
  const systemContent = [
    'You are a CI failure analyst. Diagnose the build/test failure from the log excerpt and provide:',
    '1. Root cause — what failed and why',
    '2. Fix — the specific change needed',
    '3. If relevant: what to verify after applying the fix',
    'Be concise. Reference step names and line numbers where visible.',
    route.hints.outputConstraint ?? '',
  ].filter(Boolean).join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: `Repository: ${repo}\nTarget: ${target}\n\nFiltered log (${matchCount} matching lines):\n\`\`\`\n${filteredLog}\n\`\`\``,
    },
  ];

  try {
    const resp = await ctx.chatCompletionStreaming(messages, {
      temperature: route.hints.chatTemp,
      maxTokens: ctx.adaptiveMaxTokens(filteredLog.length, route.contextLength),
      model: route.modelId,
      progressToken,
    });
    return {
      content: [{
        type: 'text',
        text: resp.content + `\n\n(${matchCount} matched lines from ${job_id ? 'job' : 'run'} logs)` + ctx.formatFooter(resp),
      }],
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}
