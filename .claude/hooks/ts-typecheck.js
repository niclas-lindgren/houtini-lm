#!/usr/bin/env node
// PostToolUse hook: runs tsc --noEmit after editing .ts files in this project.
// Prints type errors to stdout so Claude sees them as immediate feedback.

import { execSync } from "child_process";
import { readFileSync } from "fs";

const PROJECT_ROOT = new URL("../..", import.meta.url).pathname;

let input;
try {
  input = JSON.parse(readFileSync("/dev/stdin", "utf8"));
} catch {
  process.exit(0);
}

const filePath = input?.tool_input?.file_path ?? "";
if (!filePath.endsWith(".ts")) process.exit(0);

try {
  execSync("npx tsc --noEmit", { cwd: PROJECT_ROOT, stdio: "pipe" });
} catch (err) {
  const output = err.stdout?.toString() ?? err.stderr?.toString() ?? "";
  process.stdout.write(
    `[ts-typecheck] TypeScript errors after edit:\n${output}\n`
  );
  process.exit(2); // exit 2 = non-blocking feedback (warn, don't block)
}
