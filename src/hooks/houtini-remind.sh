#!/bin/bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')
if echo "$PROMPT" | grep -qiE '\b(explain|understand|what does|summarize|review|analyze|look at|check|read|write|create|implement|scaffold|locate|investigate|fix|debug|error|logs|run|workflow|ci|github)\b|find all|which files'; then
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"HOUTINI REMINDER: use mcp__houtini-lm__code_task_files([paths], task) instead of Read for code comprehension. For file writes: mcp__houtini-lm__code_write(path, instructions). For search: mcp__houtini-lm__search_task(query, paths, task). For long output: mcp__houtini-lm__analyze_output(output, task). For web pages: mcp__houtini-lm__web_fetch(url, task) instead of WebFetch. For CI/GitHub logs: mcp__houtini-lm__ci_logs(run_id, task). For errors: mcp__houtini-lm__explain_error(error, task). For semantic search: mcp__houtini-lm__semantic_search(query, task)."}}'
fi
exit 0
