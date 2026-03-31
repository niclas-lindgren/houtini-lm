---
name: version-bump
description: Bump version in sync across package.json, server.json, and index.ts Server() call, then scaffold a CHANGELOG entry. Use when cutting a new release of houtini-lm.
---

# Version Bump

Bump the `@houtini/lm` package version. The version **must stay in sync** across three files — this skill handles all three atomically.

## Files to update

1. `package.json` — `"version"` field
2. `server.json` — `"version"` field
3. `src/index.ts` — the `new Server({ name: "...", version: "..." })` call (search for `new Server(`)

## Arguments

`$ARGUMENTS` — one of:
- `patch` — increment the patch digit (2.8.0 → 2.8.1)
- `minor` — increment the minor digit (2.8.0 → 2.9.0)
- `major` — increment the major digit (2.8.0 → 3.0.0)
- An explicit version string like `2.9.0`

If no argument is provided, ask the user which bump type before proceeding.

## Steps

1. Read `package.json` to get the current version.
2. Calculate the new version from `$ARGUMENTS`.
3. Update all three files with the new version string — do not change anything else.
4. Prepend a new entry to `CHANGELOG.md` in this format:
   ```
   ## v{NEW_VERSION} — {TODAY_DATE}

   -

   ```
   Leave the bullet blank so the user can fill in the changes.
5. Report what changed: old version → new version, and list the four files touched.

## Do NOT

- Run `npm publish` or `npm run build` — leave that to the user.
- Commit the changes — let the user review the diff first.
- Change anything else in the files beyond the version strings.
