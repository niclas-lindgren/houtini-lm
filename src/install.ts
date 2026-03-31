/**
 * houtini-lm install
 *
 * Provisions Claude Code hook scripts and patches settings.json so that:
 *   - PreToolUse(Read) on source files is hard-blocked → use code_task_files instead
 *   - UserPromptSubmit with comprehension keywords injects a Houtini reminder
 *
 * Usage: npx houtini-lm install
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

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

const HOOK_READ_GUARD = `#!/bin/bash
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
EXT="\${FILE##*.}"
case "$EXT" in
  ts|tsx|js|jsx|mjs|cjs|py|go|rs|sh|bash|rb|java|c|cpp|cs|swift|kt|php)
    printf '{"decision":"block","reason":"Use mcp__houtini-lm__code_task_files([\\\"%s\\\"], task) instead of Read for source files."}\\n' "$FILE"
    exit 2
    ;;
esac
exit 0
`;

const HOOK_REMIND = `#!/bin/bash
INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')
if echo "$PROMPT" | grep -qiE '\\b(explain|understand|what does|summarize|review|analyze|look at|check|read)\\b'; then
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"HOUTINI REMINDER: use mcp__houtini-lm__code_task_files([paths], task) instead of Read for code comprehension."}}'
fi
exit 0
`;

const HOOKS_CFG = {
  PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/houtini-read-guard.sh' }] }],
  UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/houtini-remind.sh' }] }],
};

async function writeHook(hooksDir: string, filename: string, content: string) {
  const p = join(hooksDir, filename);
  if (await exists(p)) { skip(filename); return; }
  try {
    await writeFile(p, content, 'utf8');
    await chmod(p, 0o755);
    pass(filename);
  } catch (err) {
    fail(filename, err);
  }
}

async function patchSettings(settingsPath: string) {
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // File missing or invalid — start fresh with just the hooks key
  }

  const existing = cfg.hooks as Record<string, unknown> | undefined;
  if (existing && existing['PreToolUse'] && existing['UserPromptSubmit']) {
    skip('settings.json hooks');
    return;
  }

  cfg.hooks = { ...(existing ?? {}), ...HOOKS_CFG };
  await writeFile(settingsPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  pass('settings.json hooks');
}

export async function runInstall() {
  process.stdout.write('\nHoutini LM — Claude Code hook installer\n\n');

  const claudeDir = join(homedir(), '.claude');
  const hooksDir = join(claudeDir, 'hooks');
  const settingsPath = join(claudeDir, 'settings.json');

  await mkdir(hooksDir, { recursive: true });

  await writeHook(hooksDir, 'houtini-read-guard.sh', HOOK_READ_GUARD);
  await writeHook(hooksDir, 'houtini-remind.sh', HOOK_REMIND);
  await patchSettings(settingsPath);

  process.stdout.write('\nDone. Restart Claude Code to activate the hooks.\n\n');
}
