#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Intercept gh run view --log* before raw logs flood the context
if echo "$CMD" | grep -qE 'gh run view' && echo "$CMD" | grep -qE '\-\-log(-failed)?'; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"STOP: use mcp__houtini-lm__ci_logs instead of gh run view --log/--log-failed. Raw logs will flood your context. ci_logs fetches, filters, and diagnoses in one call — pass run_id if known, or omit to auto-resolve the latest failure."}}\n'
  exit 0
fi

# Warn when using grep/etc on source files
if ! echo "$CMD" | grep -qE '\b(grep|rg|sed|awk|cat|head|tail)\b'; then exit 0; fi
if ! echo "$CMD" | grep -qE '\.(ts|tsx|js|jsx|py|go|rs|sh|cs|java|rb|php|c|cpp|h)\b'; then exit 0; fi
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"Prefer mcp__houtini-lm__code_task_files([paths], task) or mcp__houtini-lm__search_task(query, paths, task) over Bash grep/sed/awk/cat for source files — keeps content out of context."}}\n'
exit 0
