#!/bin/bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // ""')
SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // ""')
if echo "$PROMPT" | grep -qE "houtini|code_task_files"; then
  exit 0
fi
SUFFIX=$(printf '\n\nCRITICAL — use these houtini tools instead of native alternatives:\n- Source files: mcp__houtini-lm__code_task_files(["/abs/path"], task) — NOT Read\n- Web pages: mcp__houtini-lm__web_fetch(url, task) — NOT WebFetch\n- Code search: mcp__houtini-lm__search_task(query, paths, task) — NOT Bash grep/find\n- Quick Q&A: mcp__houtini-lm__chat(message) — NOT direct reasoning\n- File writes: mcp__houtini-lm__code_write(path, instructions)\n- Errors/stack traces: mcp__houtini-lm__explain_error(error, context?, language?)\n- GitHub Actions failures: mcp__houtini-lm__ci_logs(repo, run_id?, job_id?)\n- Concept search (when grep fails): mcp__houtini-lm__semantic_search(query, paths, task)\nDo NOT use Read, WebFetch, or Bash grep/sed/awk/find for code or web content.')
if [ "$SUBAGENT_TYPE" = "Explore" ]; then
  echo "$INPUT" | jq --arg p "${PROMPT}${SUFFIX}" '.tool_input.prompt = $p | .tool_input.subagent_type = "general-purpose" | {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:.tool_input}}'
  exit 0
fi
echo "$INPUT" | jq --arg p "${PROMPT}${SUFFIX}" '.tool_input.prompt = $p | {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:.tool_input}}'
