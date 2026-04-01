/**
 * houtini-lm install
 *
 * Provisions Claude Code hook scripts and patches settings.json so that:
 *   - PreToolUse(Agent) injects a houtini reminder into subagent prompts
 *   - PreToolUse(Read) on source files is hard-blocked → use code_task_files instead
 *   - UserPromptSubmit with comprehension keywords injects a Houtini reminder
 *
 * Usage: npx houtini-lm install [--force]
 */

import { readFile, writeFile, mkdir, access, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PASS = '\x1b[0;32m✓\x1b[0m';
const SKIP = '\x1b[0;33m·\x1b[0m';
const FAIL = '\x1b[0;31m✗\x1b[0m';

function pass(label: string) { process.stdout.write(`  ${PASS} ${label}\n`); }
function skip(label: string) { process.stdout.write(`  ${SKIP} ${label} (already exists)\n`); }
function fail(label: string, err: unknown) { process.stdout.write(`  ${FAIL} ${label}: ${err}\n`); }

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

const HOOK_AGENT_INJECT = `#!/bin/bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // ""')
SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // ""')
if echo "$PROMPT" | grep -qE "houtini|code_task_files"; then
  exit 0
fi
SUFFIX=$(printf '\\n\\nCRITICAL — use these houtini tools instead of native alternatives:\\n- Source files: mcp__houtini-lm__code_task_files(["/abs/path"], task) — NOT Read\\n- Web pages: mcp__houtini-lm__web_fetch(url, task) — NOT WebFetch\\n- Code search: mcp__houtini-lm__search_task(query, paths, task) — NOT Bash grep/find\\n- Quick Q&A: mcp__houtini-lm__chat(message) — NOT direct reasoning\\n- File writes: mcp__houtini-lm__code_write(path, instructions)\\n- Errors/stack traces: mcp__houtini-lm__explain_error(error, context?, language?)\\n- GitHub Actions failures: mcp__houtini-lm__ci_logs(repo, run_id?, job_id?)\\n- Concept search (when grep fails): mcp__houtini-lm__semantic_search(query, paths, task)\\nDo NOT use Read, WebFetch, or Bash grep/sed/awk/find for code or web content.')
if [ "$SUBAGENT_TYPE" = "Explore" ]; then
  echo "$INPUT" | jq --arg p "\${PROMPT}\${SUFFIX}" '.tool_input.prompt = $p | .tool_input.subagent_type = "general-purpose" | {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:.tool_input}}'
  exit 0
fi
echo "$INPUT" | jq --arg p "\${PROMPT}\${SUFFIX}" '.tool_input.prompt = $p | {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",updatedInput:.tool_input}}'
`;

const HOOK_READ_GUARD = `#!/bin/bash
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
# Allow bypass for specific directories (set HOUTINI_GUARD_EXCLUDE to a path prefix)
if [ -n "$HOUTINI_GUARD_EXCLUDE" ] && [[ "$FILE" == "$HOUTINI_GUARD_EXCLUDE"* ]]; then exit 0; fi
EXT="\${FILE##*.}"
case "$EXT" in
  # Binary/media -- let Claude read these directly
  png|jpg|jpeg|gif|svg|ico|webp|bmp|tiff|\\
  pdf|zip|tar|gz|bz2|xz|7z|\\
  mp3|mp4|wav|mov|avi|\\
  woff|woff2|ttf|eot|\\
  so|dylib|dll|exe|bin|o|a)
    exit 0
    ;;
  *)
    printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"Prefer mcp__houtini-lm__code_task_files([\\\"%s\\\"], task) over Read to keep source files out of context."}}\\n' "$FILE"
    exit 0
    ;;
esac
`;

const HOOK_BASH_GUARD = `#!/bin/bash
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
if ! echo "$CMD" | grep -qE '\\b(grep|rg|sed|awk|cat|head|tail)\\b'; then exit 0; fi
if ! echo "$CMD" | grep -qE '\\.(ts|tsx|js|jsx|py|go|rs|sh|cs|java|rb|php|c|cpp|h)\\b'; then exit 0; fi
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"Prefer mcp__houtini-lm__code_task_files([paths], task) or mcp__houtini-lm__search_task(query, paths, task) over Bash grep/sed/awk/cat for source files — keeps content out of context."}}\\n'
exit 0
`;

const HOOK_REMIND = `#!/bin/bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')
if echo "$PROMPT" | grep -qiE '\\b(explain|understand|what does|summarize|review|analyze|look at|check|read|write|create|implement|scaffold|locate)\\b|find all|which files'; then
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"HOUTINI REMINDER: use mcp__houtini-lm__code_task_files([paths], task) instead of Read for code comprehension. For file writes: mcp__houtini-lm__code_write(path, instructions). For search: mcp__houtini-lm__search_task(query, paths, task). For long output: mcp__houtini-lm__analyze_output(output, task). For web pages: mcp__houtini-lm__web_fetch(url, task) instead of WebFetch."}}'
fi
exit 0
`;

const HOOKS_CFG = {
  PreToolUse: [
    { matcher: 'Agent', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/houtini-agent-inject.sh' }] },
    { matcher: 'Read',  hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/houtini-read-guard.sh' }] },
    { matcher: 'Bash',  hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/houtini-bash-guard.sh' }] },
  ],
  UserPromptSubmit: [
    { matcher: '', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/houtini-remind.sh' }] },
  ],
};

const HOOK_FILES: Record<string, string> = {
  'houtini-agent-inject.sh': HOOK_AGENT_INJECT,
  'houtini-read-guard.sh':   HOOK_READ_GUARD,
  'houtini-bash-guard.sh':   HOOK_BASH_GUARD,
  'houtini-remind.sh':       HOOK_REMIND,
};

async function writeHook(hooksDir: string, filename: string, content: string, force = false) {
  const p = join(hooksDir, filename);
  if (!force && await fileExists(p)) { skip(filename); return; }
  try {
    await writeFile(p, content, 'utf8');
    await chmod(p, 0o755);
    pass(filename);
  } catch (err) {
    fail(filename, err);
  }
}

async function patchSettings(settingsPath: string, force = false) {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // File missing or invalid -- start fresh with just the hooks key
  }

  const hooks = (cfg.hooks ?? {}) as Record<string, unknown[]>;
  type HookEntry = { hooks?: { command?: string }[] };

  // --force: strip all existing houtini entries so they are re-added fresh
  if (force) {
    for (const event of Object.keys(HOOKS_CFG)) {
      const arr = (hooks[event] ?? []) as HookEntry[];
      hooks[event] = arr.filter(e => !e.hooks?.some(h => h.command?.includes('houtini-')));
    }
  }

  // Append any missing entries -- idempotent: skip if command already present
  let changed = false;
  for (const [event, entries] of Object.entries(HOOKS_CFG)) {
    for (const entry of entries) {
      const cmd = entry.hooks[0].command;
      const alreadyPresent = ((hooks[event] ?? []) as HookEntry[])
        .some(e => e.hooks?.some(h => h.command === cmd));
      if (!alreadyPresent) {
        hooks[event] = [...(hooks[event] ?? []), entry];
        changed = true;
      }
    }
  }

  if (!changed) {
    skip('settings.json hooks');
    return;
  }

  cfg.hooks = hooks;
  await writeFile(settingsPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  pass('settings.json hooks');
}

export async function runInstall(force = false) {
  process.stdout.write(`\nHoutini LM -- Claude Code hook installer${force ? ' (--force)' : ''}\n\n`);

  const claudeDir = join(homedir(), '.claude');
  const hooksDir = join(claudeDir, 'hooks');
  const settingsPath = join(claudeDir, 'settings.json');

  await mkdir(hooksDir, { recursive: true });

  for (const [filename, content] of Object.entries(HOOK_FILES)) {
    await writeHook(hooksDir, filename, content, force);
  }
  await patchSettings(settingsPath, force);

  process.stdout.write('\nDone. Restart Claude Code to activate the hooks.\n\n');
}
