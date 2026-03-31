import type { ForkContext, ChatMessage, ToolResult } from './types.js';

export const DIFF_REVIEW_TOOL = {
  name: 'diff_review',
  description:
    'Analyse a git diff using the local LLM. Three modes:\n' +
    '• commit_message — write a properly formatted git commit message (subject + body, imperative mood, no Co-Authored-By)\n' +
    '• review — group findings as Critical / Warning / Suggestion with file names and line references\n' +
    '• summary — plain English 2-5 sentence description of what changed and why\n\n' +
    'Pass the raw output of `git diff`, `git diff HEAD~1`, or `git show`. ' +
    'For commit messages, add the Co-Authored-By trailer yourself before committing.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      diff: {
        type: 'string',
        description: 'Raw git diff output. Include the full diff — do not truncate.',
      },
      mode: {
        type: 'string',
        enum: ['commit_message', 'review', 'summary'],
        description: 'commit_message: write a git commit message. review: find bugs/issues. summary: plain English description.',
      },
    },
    required: ['diff', 'mode'],
  },
};

export async function handleDiffReview(
  args: unknown,
  ctx: ForkContext,
  progressToken?: string | number,
): Promise<ToolResult> {
  const { diff, mode } = args as { diff: string; mode: 'commit_message' | 'review' | 'summary' };
  const route = await ctx.routeToModel('code');
  const constraint = route.hints.outputConstraint ? `\n${route.hints.outputConstraint}` : '';

  let systemPrompt: string;
  if (mode === 'commit_message') {
    systemPrompt =
      'You are an expert developer writing git commit messages.\n' +
      'Rules:\n' +
      '- Subject line: imperative mood, max 72 chars, no trailing period\n' +
      '- Blank line between subject and body\n' +
      '- Body: explain WHY, not WHAT (the diff shows what)\n' +
      '- No Co-Authored-By line (the caller adds that)\n' +
      '- Output only the commit message text, no preamble' +
      constraint;
  } else if (mode === 'review') {
    systemPrompt =
      'You are a senior code reviewer. Review the diff for bugs, missing edge cases, style issues, and security concerns.\n' +
      'Group findings under these headings (omit empty sections):\n' +
      '**Critical** — bugs, security issues, data loss risks\n' +
      '**Warning** — edge cases, correctness concerns, unclear logic\n' +
      '**Suggestion** — style, naming, minor improvements\n' +
      'Be specific: reference file names and line numbers.' +
      constraint;
  } else {
    systemPrompt =
      'You are a technical writer. Summarise what this diff changes in plain English.\n' +
      'Be concise: 2-5 sentences. Focus on intent and effect, not mechanics.' +
      constraint;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `\`\`\`diff\n${diff}\n\`\`\`` },
  ];

  const resp = await ctx.chatCompletionStreaming(messages, {
    temperature: route.hints.codeTemp,
    model: route.modelId,
    progressToken,
  });

  return { content: [{ type: 'text', text: resp.content + ctx.formatFooter(resp) }] };
}
