/**
 * houtini-lm install
 *
 * Provisions Claude Code hook scripts and patches settings.json so that:
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

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

const HOOK_READ_GUARD = `#!/bin/bash
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // ""')
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
    printf '{"decision":"block","reason":"Use mcp__houtini-lm__code_task_files([\\\"%s\\\"], task) instead of Read for source files."}\\n' "$FILE"
    exit 2
    ;;
esac
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

async function writeHook(hooksDir: string, filename: string, content: string, force = false) {
  const p = join(hooksDir, filename);
  if (!force && await exists(p)) { skip(filename); return; }
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

  const hooks = (cfg.hooks ?? {}) as Record<string, unknown[]>;

  // Check if our specific entries are already present (by command value)
  const alreadyHasReadGuard = (hooks['PreToolUse'] as { hooks?: { command?: string }[] }[] | undefined)
    ?.some((e) => e.hooks?.some((h) => h.command?.includes('houtini-read-guard')));
  const alreadyHasRemind = (hooks['UserPromptSubmit'] as { hooks?: { command?: string }[] }[] | undefined)
    ?.some((e) => e.hooks?.some((h) => h.command?.includes('houtini-remind')));

  if (alreadyHasReadGuard && alreadyHasRemind) {
    skip('settings.json hooks');
    return;
  }

  // Merge: append our entries to existing arrays rather than replacing them
  if (!alreadyHasReadGuard) {
    hooks['PreToolUse'] = [...(hooks['PreToolUse'] ?? []), ...HOOKS_CFG.PreToolUse];
  }
  if (!alreadyHasRemind) {
    hooks['UserPromptSubmit'] = [...(hooks['UserPromptSubmit'] ?? []), ...HOOKS_CFG.UserPromptSubmit];
  }
  cfg.hooks = hooks;

  await writeFile(settingsPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  pass('settings.json hooks');
}

export async function runInstall(force = false) {
  process.stdout.write(`\nHoutini LM — Claude Code hook installer${force ? ' (--force)' : ''}\n\n`);

  const claudeDir = join(homedir(), '.claude');
  const hooksDir = join(claudeDir, 'hooks');
  const settingsPath = join(claudeDir, 'settings.json');

  await mkdir(hooksDir, { recursive: true });

  await writeHook(hooksDir, 'houtini-read-guard.sh', HOOK_READ_GUARD, force);
  await writeHook(hooksDir, 'houtini-remind.sh', HOOK_REMIND, force);
  await patchSettings(settingsPath);

  process.stdout.write('\nDone. Restart Claude Code to activate the hooks.\n\n');
}
