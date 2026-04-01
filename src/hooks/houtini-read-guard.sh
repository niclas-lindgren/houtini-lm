#!/bin/bash
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
# Allow bypass for specific directories (set HOUTINI_GUARD_EXCLUDE to a path prefix)
if [ -n "$HOUTINI_GUARD_EXCLUDE" ] && [[ "$FILE" == "$HOUTINI_GUARD_EXCLUDE"* ]]; then exit 0; fi
EXT="${FILE##*.}"
case "$EXT" in
  # Binary/media -- let Claude read these directly
  png|jpg|jpeg|gif|svg|ico|webp|bmp|tiff|\
  pdf|zip|tar|gz|bz2|xz|7z|\
  mp3|mp4|wav|mov|avi|\
  woff|woff2|ttf|eot|\
  so|dylib|dll|exe|bin|o|a)
    exit 0
    ;;
  *)
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"Prefer mcp__houtini-lm__code_task_files([\"%s\"], task) over Read to keep source files out of context."}}\n' "$FILE"
    exit 0
    ;;
esac
