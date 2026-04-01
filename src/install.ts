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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PASS = '\x1b[0;32m✓\x1b[0m';
const SKIP = '\x1b[0;33m·\x1b[0m';
const FAIL = '\x1b[0;31m✗\x1b[0m';

function pass(label: string) { process.stdout.write(`  ${PASS} ${label}\n`); }
function skip(label: string) { process.stdout.write(`  ${SKIP} ${label} (already exists)\n`); }
function fail(label: string, err: unknown) { process.stdout.write(`  ${FAIL} ${label}: ${err}\n`); }

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

const HOOKS_SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'hooks');

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

const HOOK_NAMES = [
  'houtini-agent-inject.sh',
  'houtini-read-guard.sh',
  'houtini-bash-guard.sh',
  'houtini-remind.sh',
];

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

  for (const filename of HOOK_NAMES) {
    const content = await readFile(join(HOOKS_SRC_DIR, filename), 'utf8');
    await writeHook(hooksDir, filename, content, force);
  }
  await patchSettings(settingsPath, force);

  process.stdout.write('\nDone. Restart Claude Code to activate the hooks.\n\n');
}
