#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
if ! echo "$CMD" | grep -qE '\b(grep|rg|sed|awk|cat|head|tail)\b'; then exit 0; fi
if ! echo "$CMD" | grep -qE '\.(ts|tsx|js|jsx|py|go|rs|sh|cs|java|rb|php|c|cpp|h)\b'; then exit 0; fi
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"Prefer mcp__houtini-lm__code_task_files([paths], task) or mcp__houtini-lm__search_task(query, paths, task) over Bash grep/sed/awk/cat for source files — keeps content out of context."}}\n'
exit 0
