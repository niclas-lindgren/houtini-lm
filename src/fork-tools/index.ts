import { DIFF_REVIEW_TOOL, handleDiffReview } from './diff-review.js';
import { CODE_WRITE_TOOL, handleCodeWrite } from './code-write.js';
import { ANALYZE_OUTPUT_TOOL, handleAnalyzeOutput } from './analyze-output.js';
import { SEARCH_TASK_TOOL, handleSearchTask } from './search-task.js';
import { WEB_FETCH_TOOL, handleWebFetch } from './web-fetch.js';
import { EXPLAIN_ERROR_TOOL, handleExplainError } from './explain-error.js';
import { SEMANTIC_SEARCH_TOOL, handleSemanticSearch } from './semantic-search.js';
import type { ForkContext, ToolResult } from './types.js';

export type { ForkContext };

export const FORK_TOOLS = [
  DIFF_REVIEW_TOOL,
  CODE_WRITE_TOOL,
  ANALYZE_OUTPUT_TOOL,
  SEARCH_TASK_TOOL,
  WEB_FETCH_TOOL,
  EXPLAIN_ERROR_TOOL,
  SEMANTIC_SEARCH_TOOL,
];

export async function handleForkTool(
  name: string,
  args: unknown,
  progressToken: string | number | undefined,
  ctx: ForkContext,
): Promise<ToolResult | null> {
  switch (name) {
    case 'diff_review':    return handleDiffReview(args, ctx, progressToken);
    case 'code_write':     return handleCodeWrite(args, ctx, progressToken);
    case 'analyze_output': return handleAnalyzeOutput(args, ctx, progressToken);
    case 'search_task':    return handleSearchTask(args, ctx, progressToken);
    case 'web_fetch':      return handleWebFetch(args, ctx, progressToken);
    case 'explain_error':  return handleExplainError(args, ctx, progressToken);
    case 'semantic_search':  return handleSemanticSearch(args, ctx, progressToken);
    default:                 return null;
  }
}
