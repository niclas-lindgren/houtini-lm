# Houtini LM — Claude Code Hooks

Two hook scripts integrate houtini-lm into Claude Code's tooling:

- **read-guard** — nudges Claude to use `code_task_files` instead of `Read` when working with source files, keeping file content out of Claude's context window.
- **remind** — injects a reminder about houtini-lm tools when Claude's prompt contains comprehension or write keywords (`explain`, `understand`, `review`, `write`, `implement`, `find all`, etc.).

## Install

Run once from this fork's GitHub repo — no npm publish required:

```sh
npx github:niclas-lindgren/lm install
```

To overwrite existing hooks (e.g. after updating):

```sh
npx github:niclas-lindgren/lm install --force
```

## What gets written

### Hook scripts

```
~/.claude/hooks/houtini-read-guard.sh
~/.claude/hooks/houtini-remind.sh
```

### settings.json entries

Two entries are merged into `~/.claude/settings.json` under `hooks`:

```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Read",
      "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/houtini-read-guard.sh" }]
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

## Uninstall

1. Delete the two hook files:
   ```sh
   rm ~/.claude/hooks/houtini-read-guard.sh ~/.claude/hooks/houtini-remind.sh
   ```
2. Open `~/.claude/settings.json` and remove the two hook entries shown above from the `PreToolUse` and `UserPromptSubmit` arrays.
