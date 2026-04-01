import type { ForkContext, ChatMessage, ToolResult } from './types.js';

export const EXPLAIN_ERROR_TOOL = {
  name: 'explain_error',
  description:
    'Diagnose an error message or stack trace using the local LLM — without loading it into Claude\'s context window.\n\n' +
    'WHEN TO USE:\n' +
    '\u2022 Build failures, test failures, runtime exceptions, CI logs\n' +
    '\u2022 Any verbose error output you want diagnosed + fix suggestions for\n\n' +
    'WHEN NOT TO USE:\n' +
    '\u2022 When you need precise file/line edits — use code_task_files instead',
  inputSchema: {
    type: 'object' as const,
    properties: {
      error: {
        type: 'string',
        description: 'The error message, stack trace, or log output to diagnose.',
      },
      context: {
        type: 'string',
        description: 'Optional: surrounding code snippet or extra context that may be relevant.',
      },
      language: {
        type: 'string',
        description: 'Optional: programming language or runtime (e.g. "TypeScript", "Python", "GitHub Actions").',
      },
    },
    required: ['error'],
  },
};

export async function handleExplainError(
  args: unknown,
  ctx: ForkContext,
  progressToken?: string | number,
): Promise<ToolResult> {
  const { error, context, language } = args as {
    error: string;
    context?: string;
    language?: string;
  };

  const route = await ctx.routeToModel('analysis');

  const langHint = language ? ` (${language})` : '';
  const systemContent = [
    `You are an expert debugger${langHint}. Diagnose the error and provide:`,
    '1. Root cause — what went wrong and why',
    '2. Fix — the specific change needed to resolve it',
    '3. If relevant: what to check if the fix doesn\'t work',
    'Be concise. Skip preamble.',
    route.hints.outputConstraint ?? '',
  ].filter(Boolean).join('\n');

  let userContent = `Error:\n\`\`\`\n${error}\n\`\`\``;
  if (context) userContent += `\n\nContext:\n\`\`\`\n${context}\n\`\`\``;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ];

  try {
    const resp = await ctx.chatCompletionStreaming(messages, {
      temperature: route.hints.chatTemp,
      maxTokens: ctx.adaptiveMaxTokens(error.length + (context?.length ?? 0), route.contextLength),
      model: route.modelId,
      progressToken,
    });
    return { content: [{ type: 'text', text: resp.content + ctx.formatFooter(resp) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}
