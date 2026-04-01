/**
 * Shared types for fork tool handlers.
 * Re-declared here to avoid importing from index.ts (which is the entry point, not a library).
 * Keep in sync with the matching definitions in index.ts if upstream changes them.
 */

import type { PromptHints } from '../model-cache.js';

export interface RoutingDecision {
  modelId: string;
  hints: PromptHints;
  contextLength: number;
  suggestion?: string;
}

export interface StreamingResult {
  content: string;
  rawContent: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  finishReason: string;
  truncated: boolean;
  ttftMs?: number;
  generationMs: number;
}

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export type TaskType = 'code' | 'chat' | 'analysis' | 'embedding';

export interface ForkContext {
  routeToModel: (taskType: TaskType) => Promise<RoutingDecision>;
  chatCompletionStreaming: (
    messages: ChatMessage[],
    opts?: { temperature?: number; maxTokens?: number; model?: string; progressToken?: string | number }
  ) => Promise<StreamingResult>;
  formatFooter: (resp: StreamingResult, extra?: string) => string;
  adaptiveMaxTokens: (inputChars: number, contextLength: number) => number;
  execFileAsync: (file: string, args: string[], opts?: { timeout?: number; maxBuffer?: number }) => Promise<{ stdout: string }>;
  readFile: (path: string, enc: 'utf8') => Promise<string>;
  writeFile: (path: string, content: string, enc: 'utf8') => Promise<void>;
}

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: true };
