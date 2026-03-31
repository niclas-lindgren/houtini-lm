# Houtini LM — Claude Code Hooks

Three hook scripts integrate houtini-lm into Claude Code's tooling:

- **agent-inject** — injects a houtini reminder into subagent prompts before they run, since hooks don't fire inside spawned subagents. Ensures Explore/Plan/general-purpose agents use `code_task_files` instead of `Read`.
- **read-guard** — nudges Claude to prefer `code_task_files` over `Read` for source files (allows the Read so `Edit`/`Write` workflows still function; blocking would cause Claude to bypass via `Bash cat` anyway).
- **bash-guard** — nudges Claude to prefer `code_task_files` or `search_task` when a Bash command uses `grep`/`rg`/`sed`/`awk`/`cat`/`head`/`tail` on source file extensions (`.ts`, `.js`, `.py`, `.go`, etc.).
- **remind** — injects a reminder about houtini-lm tools when Claude's prompt contains comprehension or write keywords (`explain`, `understand`, `review`, `write`, `implement`, `find all`, etc.).

## Install

Run once from this fork's GitHub repo — no npm publish required:

```sh
npx github:niclas-lindgren/houtini-lm install
```

To overwrite existing hooks and clean up stale settings.json entries (e.g. after updating):

```sh
npx github:niclas-lindgren/houtini-lm install --force
```

## What gets written

### Hook scripts

```
~/.claude/hooks/houtini-agent-inject.sh
~/.claude/hooks/houtini-read-guard.sh
~/.claude/hooks/houtini-bash-guard.sh
~/.claude/hooks/houtini-remind.sh
```

### settings.json entries

Four entries are merged into `~/.claude/settings.json` under `hooks`:

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Agent",
      "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/houtini-agent-inject.sh" }]
    },
    {
      "matcher": "Read",
      "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/houtini-read-guard.sh" }]
    },
    {
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/houtini-bash-guard.sh" }]
    }
  ],
  "UserPromptSubmit": [
    {
      "matcher": "",
      "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/houtini-remind.sh" }]
    }
  ]
}
```

`patchSettings` is idempotent — it checks for each entry by exact command string and only appends missing ones. `--force` strips all existing `houtini-` entries first, then re-adds them fresh.

## Uninstall

1. Delete the hook files:
   ```sh
   rm ~/.claude/hooks/houtini-agent-inject.sh ~/.claude/hooks/houtini-read-guard.sh ~/.claude/hooks/houtini-bash-guard.sh ~/.claude/hooks/houtini-remind.sh
   ```
2. Open `~/.claude/settings.json` and remove the three hook entries shown above.
