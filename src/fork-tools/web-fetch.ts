import type { ForkContext, ToolResult } from './types.js';

export const WEB_FETCH_TOOL = {
  name: 'web_fetch',
  description:
    'Fetch a URL and summarize its content using the local LLM — keeping raw HTML out of Claude\'s context window. ' +
    'Use instead of the native WebFetch tool when you need to extract specific information from a page or when ' +
    'the page is large (docs, articles, API references).',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to fetch.',
      },
      task: {
        type: 'string',
        description:
          'What to extract or summarize. Be specific: "List all HTTP endpoints" or ' +
          '"Summarize the installation steps" beats "Summarize this page".',
      },
      max_tokens: {
        type: 'number',
        description: 'Max response tokens. Default: adaptive based on page size.',
      },
    },
    required: ['url', 'task'],
  },
};

const FETCH_TIMEOUT_MS = 30_000;
const MAX_PAGE_CHARS = 120_000; // ~30k tokens — truncate before sending to LLM

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html: string): string {
  // Remove script/style blocks entirely
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  // Collapse block-level tags to newlines
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, '\n');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '');
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // Collapse whitespace
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export async function handleWebFetch(
  args: unknown,
  ctx: ForkContext,
  progressToken?: string | number,
): Promise<ToolResult> {
  const { url, task, max_tokens } = args as { url: string; task: string; max_tokens?: number };

  // Fetch with timeout
  let rawBody: string;
  try {
    const resp = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': 'houtini-lm/1.0 (summary bot)' } },
      FETCH_TIMEOUT_MS,
    );
    if (!resp.ok) {
      return { isError: true, content: [{ type: 'text', text: `HTTP ${resp.status} ${resp.statusText} — ${url}` }] };
    }
    rawBody = await resp.text();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: 'text', text: `Fetch failed: ${msg}` }] };
  }

  const plainText = stripHtml(rawBody).slice(0, MAX_PAGE_CHARS);

  const route = await ctx.routeToModel('analysis');
  const constraint = route.hints.outputConstraint ? `\n${route.hints.outputConstraint}` : '';
  const messages = [
    {
      role: 'system' as const,
      content: `You extract information from web page content. Be concise and factual. Answer only what is asked — do not pad. If the requested information is not present on the page, say so explicitly.${constraint}`,
    },
    {
      role: 'user' as const,
      content: `URL: ${url}\n\nTask: ${task}\n\nPage content:\n\n${plainText}`,
    },
  ];

  try {
    const resp = await ctx.chatCompletionStreaming(messages, {
      temperature: route.hints.chatTemp,
      maxTokens: max_tokens ?? ctx.adaptiveMaxTokens(plainText.length, route.contextLength),
      model: route.modelId,
      progressToken,
    });
    return { content: [{ type: 'text', text: resp.content + ctx.formatFooter(resp) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` }] };
  }
}
