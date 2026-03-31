import type { ForkContext, ChatMessage, ToolResult } from './types.js';

export const CODE_WRITE_TOOL = {
  name: 'code_write',
  description:
    'Write or edit a file using the local LLM. The server reads the file and writes the result ' +
    'directly to disk — Claude never sees the file content, saving both prompt and output tokens.\n\n' +
    'WHEN TO USE (saves ~4K tokens per 400-line file):\n' +
    '\u2022 Create new files from clear specifications\n' +
    '\u2022 Edit existing files with well-defined instructions\n\n' +
    'WHEN NOT TO USE:\n' +
    '\u2022 Subtle refactors requiring architectural judgment — use Claude directly\n' +
    '\u2022 Multi-file changes with complex interdependencies\n\n' +
    'Always verify the written file compiles and behaves correctly after calling this tool.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to file. Existing file \u2192 edited in place. New path \u2192 created.',
      },
      instructions: {
        type: 'string',
        description: 'What to write or change: "add error handling to fetchUser", "write a debounce utility".',
      },
      language: {
        type: 'string',
        description: 'Programming language. Inferred from file extension if omitted.',
      },
    },
    required: ['path', 'instructions'],
  },
};

export async function handleCodeWrite(
  args: unknown,
  ctx: ForkContext,
  progressToken?: string | number,
): Promise<ToolResult> {
  const { path: filePath, instructions, language: writeLanguage } = args as {
    path: string;
    instructions: string;
    language?: string;
  };

  const ext = filePath.split('.').pop() ?? '';
  const lang = writeLanguage || ext || 'unknown';

  const route = await ctx.routeToModel('code');
  const constraint = route.hints.outputConstraint ? `\n\n${route.hints.outputConstraint}` : '';

  let existingContent = '';
  let fileExists = false;
  try {
    existingContent = await ctx.readFile(filePath, 'utf8');
    fileExists = true;
  } catch { /* new file */ }

  const inputChars = existingContent.length + instructions.length;

  const messages: ChatMessage[] = fileExists
    ? [
        {
          role: 'system',
          content: `Expert ${lang} developer. Rewrite the file as instructed. Output ONLY the complete new file content — no explanation, no markdown fences, no preamble.${constraint}`,
        },
        {
          role: 'user',
          content: `File: ${filePath}\n\n\`\`\`${lang}\n${existingContent}\n\`\`\`\n\nInstructions: ${instructions}`,
        },
      ]
    : [
        {
          role: 'system',
          content: `Expert ${lang} developer. Write the new file as instructed. Output ONLY the complete file content — no explanation, no markdown fences, no preamble.${constraint}`,
        },
        {
          role: 'user',
          content: `File to create: ${filePath}\n\nInstructions: ${instructions}`,
        },
      ];

  const resp = await ctx.chatCompletionStreaming(messages, {
    temperature: route.hints.codeTemp,
    maxTokens: ctx.adaptiveMaxTokens(inputChars, route.contextLength),
    model: route.modelId,
    progressToken,
  });

  if (!resp.content.trim()) {
    return { isError: true, content: [{ type: 'text', text: 'Local LLM returned empty output — file not written.' }] };
  }

  // Strip markdown fences if the model wrapped output despite instructions
  let fileContent = resp.content.trim();
  const fenceMatch = fileContent.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
  if (fenceMatch) fileContent = fenceMatch[1];

  await ctx.writeFile(filePath, fileContent, 'utf8');
  const lineCount = fileContent.split('\n').length;

  return {
    content: [{ type: 'text', text: `Written ${lineCount} lines to ${filePath}${ctx.formatFooter(resp, lang)}` }],
  };
}
