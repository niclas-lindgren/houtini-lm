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
    '\u2022 Use job_id for a specific job\'s logs (more focused than run_id)\n' +
    '\u2022 Override filter to match language-specific patterns (e.g. "panic:|FAIL " for Go)',
  inputSchema: {
    type: 'object' as const,
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in owner/repo format, e.g. "acme/my-app".',
      },
      run_id: {
        type: 'string',
        description: 'GitHub Actions run ID. Use this or job_id.',
      },
      job_id: {
        type: 'string',
        description: 'GitHub Actions job ID. More focused than run_id — prefer this when available.',
      },
      filter: {
        type: 'string',
        description: 'Extended-regex filter applied to log lines (grep -E). Defaults to common failure patterns.',
      },
      context_lines: {
        type: 'number',
        description: 'Lines of context to include around each match (grep -C). Default: 3.',
      },
    },
    required: ['repo'],
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
    repo: string;
    run_id?: string;
    job_id?: string;
    filter?: string;
    context_lines?: number;
  };

  if (!run_id && !job_id) {
    return { isError: true, content: [{ type: 'text', text: 'Provide either run_id or job_id.' }] };
  }

  // Fetch logs via gh CLI
  const ghArgs = ['run', 'view', '--log-failed', '--repo', repo];
  if (job_id) {
    ghArgs.push('--job', job_id);
  } else {
    ghArgs.push(run_id!);
  }

  let rawLog: string;
  try {
    const { stdout } = await ctx.execFileAsync('gh', ghArgs, { timeout: 30_000 });
    rawLog = stdout;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `gh failed: ${msg}` }] };
  }

  if (!rawLog.trim()) {
    return { content: [{ type: 'text', text: 'No failed-step logs found — the run may have succeeded or logs may have expired.' }] };
  }

  // Filter to failure-signal lines with context (JS-based — avoids stdin piping with execFileAsync)
  const ctxLines = context_lines ?? 3;
  const pattern = filter ?? DEFAULT_FILTER;
  let filteredLog: string;
  let matchCount: number;
  const filterRe = new RegExp(pattern, 'i');
  const allLines = rawLog.split('\n');
  const matched: string[] = [];
  for (let i = 0; i < allLines.length; i++) {
    if (filterRe.test(allLines[i])) {
      const start = Math.max(0, i - ctxLines);
      const end = Math.min(allLines.length - 1, i + ctxLines);
      matched.push(...allLines.slice(start, end + 1));
      matched.push('---');
      i = end; // skip ahead to avoid re-processing context lines
    }
  }
  matchCount = matched.filter((l) => l !== '---').length;

  if (matched.length === 0) {
    // No pattern matches — send the tail of the raw log as fallback
    const tail = allLines.slice(-MAX_LOG_LINES);
    filteredLog = `(no lines matched filter — showing last ${tail.length} lines)\n` + tail.join('\n');
    matchCount = tail.length;
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
}
