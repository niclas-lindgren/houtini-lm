# Fork / Upstream Merge Policy

This repository is a fork. To keep rebases and upstream merges manageable:

- **Prefer adding new files** over modifying existing upstream files
- If an upstream file must be changed, flag it as a merge-conflict risk in the commit message
- New tools, hooks, and extensions should live in separate modules (e.g. `src/fork-tools/`)
- Do not edit `CLAUDE.md` — it is an upstream file; use this file or local `.claude/` overrides instead
