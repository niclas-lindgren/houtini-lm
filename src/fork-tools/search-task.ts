import type { ForkContext, ChatMessage, ToolResult } from './types.js';

export const SEARCH_TASK_TOOL = {
  name: 'search_task',
  description:
    'Search a codebase and answer a question about the results using the local LLM.\n\n' +
    'WHEN TO USE (saves significant tokens on large codebases):\n' +
    '\u2022 "Which files import AuthService?" — grep returns 80 lines, this returns 1 sentence\n' +
    '\u2022 "Where is deleteUser called?" — distills noisy grep output to the relevant answer\n\n' +
    'WHEN NOT TO USE:\n' +
    '\u2022 When you need precise line numbers — fall back to Grep for exact locations\n' +
    '\u2022 Small codebases where grep output is already compact\n\n' +
    'Quality safeguard: the raw match count is always returned so you can verify the answer.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Search string or regex passed to grep -rn.',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Absolute directory paths to search in.',
      },
      task: {
        type: 'string',
        description: 'Question to answer: "which files import X?", "find all calls to deleteUser".',
      },
      file_glob: {
        type: 'string',
        description: 'Optional file pattern filter, e.g. "*.ts" or "*.py".',
      },
    },
    required: ['query', 'paths', 'task'],
  },
};

export async function handleSearchTask(
  args: unknown,
  ctx: ForkContext,
  progressToken?: string | number,
): Promise<ToolResult> {
  const { query, paths: searchPaths, task: searchTask, file_glob } = args as {
    query: string;
    paths: string[];
    task: string;
    file_glob?: string;
  };

  const grepArgs = ['-rn'];
  if (file_glob) grepArgs.push(`--include=${file_glob}`);
  grepArgs.push('--', query, ...searchPaths);

  let grepOutput = '';
  let matchCount = 0;
  let fileCount = 0;

  try {
    const { stdout } = await ctx.execFileAsync('grep', grepArgs, { timeout: 10_000 });
    const lines = stdout.trim().split('\n').filter(Boolean);
    matchCount = lines.length;
    fileCount = new Set(lines.map((l: string) => l.split(':')[0])).size;
    // Cap at 500 lines to avoid token overflow
    grepOutput = lines.length > 500
      ? lines.slice(0, 500).join('\n') + `\n... (truncated at 500 of ${lines.length} matches)`
      : lines.join('\n');
  } catch (err: unknown) {
    const execErr = err as { code?: number };
    if (execErr.code === 1) {
      // grep exit code 1 = no matches (not an error)
      return { content: [{ type: 'text', text: `No matches for '${query}' in the specified paths.` }] };
    }
    return { isError: true, content: [{ type: 'text', text: `grep failed: ${err instanceof Error ? err.message : String(err)}` }] };
  }

  const route = await ctx.routeToModel('analysis');

  const systemContent = route.hints.outputConstraint
    ? `You are a code search assistant. Answer the question using only the grep results provided. Be specific — reference file names and line numbers.\n\n${route.hints.outputConstraint}`
    : 'You are a code search assistant. Answer the question using only the grep results provided. Be specific — reference file names and line numbers.';

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    {
      role: 'user',
      content: `Question: ${searchTask}\n\nGrep results (${matchCount} matches across ${fileCount} files):\n${grepOutput}`,
    },
  ];

  const resp = await ctx.chatCompletionStreaming(messages, {
    temperature: route.hints.chatTemp,
    maxTokens: ctx.adaptiveMaxTokens(grepOutput.length + searchTask.length, route.contextLength),
    model: route.modelId,
    progressToken,
  });

  return {
    content: [{
      type: 'text',
      text: resp.content + `\n\n(${matchCount} raw matches across ${fileCount} files)` + ctx.formatFooter(resp),
    }],
  };
}
