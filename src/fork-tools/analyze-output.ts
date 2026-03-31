import type { ForkContext, ChatMessage, ToolResult } from './types.js';

export const ANALYZE_OUTPUT_TOOL = {
  name: 'analyze_output',
  description:
    'Compress long command output using the local LLM — extract only what you need.\n\n' +
    'WHEN TO USE (saves 1\u20132K tokens per run):\n' +
    '\u2022 npm test / jest output — extract only failing tests\n' +
    '\u2022 tsc / build logs — find the root error\n' +
    '\u2022 Any verbose CLI output where you need a specific subset\n\n' +
    'WHEN NOT TO USE:\n' +
    '\u2022 Short output (< 50 lines) — just read it directly\n' +
    '\u2022 When you need exact raw content (e.g. a specific line number)',
  inputSchema: {
    type: 'object' as const,
    properties: {
      output: {
        type: 'string',
        description: 'Raw command output (stdout/stderr).',
      },
      task: {
        type: 'string',
        description: 'What to extract: "failing tests and their errors", "root build error", "all warnings".',
      },
      max_tokens: {
        type: 'number',
        description: 'Max response tokens. Default 512.',
      },
    },
    required: ['output', 'task'],
  },
};

export async function handleAnalyzeOutput(
  args: unknown,
  ctx: ForkContext,
  progressToken?: string | number,
): Promise<ToolResult> {
  const { output, task: analyzeTask, max_tokens: analyzeMaxTokens } = args as {
    output: string;
    task: string;
    max_tokens?: number;
  };

  const route = await ctx.routeToModel('analysis');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a log analysis assistant. Extract only what the task asks for. Be concise and specific — include file names and line numbers where relevant.',
    },
    {
      role: 'user',
      content: `Task: ${analyzeTask}\n\nOutput:\n${output}`,
    },
  ];

  const resp = await ctx.chatCompletionStreaming(messages, {
    temperature: route.hints.chatTemp,
    maxTokens: analyzeMaxTokens ?? 512,
    model: route.modelId,
    progressToken,
  });

  return { content: [{ type: 'text', text: resp.content + ctx.formatFooter(resp) }] };
}
