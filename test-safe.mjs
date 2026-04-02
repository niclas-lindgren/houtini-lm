/**
 * Unit tests for isSafeGhCommand — no LLM server required.
 * Run: node test-safe.mjs
 */
import assert from 'node:assert/strict';
import { isSafeGhCommand } from './dist/fork-tools/gh-safe.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

console.log('\nisSafeGhCommand — allowed commands');
test('gh run view with run id', () => assert.ok(isSafeGhCommand(['gh', 'run', 'view', '123'])));
test('gh run view --log --job', () => assert.ok(isSafeGhCommand(['gh', 'run', 'view', '--log', '--job', '456'])));
test('gh run view --log-failed', () => assert.ok(isSafeGhCommand(['gh', 'run', 'view', '123', '--log-failed'])));
test('gh run view --json jobs', () => assert.ok(isSafeGhCommand(['gh', 'run', 'view', '123', '--json', 'jobs'])));
test('gh run view --repo', () => assert.ok(isSafeGhCommand(['gh', 'run', 'view', '123', '--repo', 'owner/repo'])));
test('gh run list', () => assert.ok(isSafeGhCommand(['gh', 'run', 'list', '--status', 'failure'])));
test('gh api GET (implicit)', () => assert.ok(isSafeGhCommand(['gh', 'api', 'repos/o/r/actions/runs/123/jobs'])));
test('gh api GET (explicit)', () => assert.ok(isSafeGhCommand(['gh', 'api', 'repos/o/r/actions/runs/123', '--method', 'GET'])));
test('gh api with --jq', () => assert.ok(isSafeGhCommand(['gh', 'api', 'repos/o/r/check-runs', '--jq', '.check_runs[]'])));
test('gh api with --paginate', () => assert.ok(isSafeGhCommand(['gh', 'api', 'repos/o/r/actions/runs', '--paginate'])));

console.log('\nisSafeGhCommand — blocked commands');
test('gh run cancel', () => assert.ok(!isSafeGhCommand(['gh', 'run', 'cancel', '123'])));
test('gh run delete', () => assert.ok(!isSafeGhCommand(['gh', 'run', 'delete', '123'])));
test('gh run rerun', () => assert.ok(!isSafeGhCommand(['gh', 'run', 'rerun', '123'])));
test('gh release delete', () => assert.ok(!isSafeGhCommand(['gh', 'release', 'delete', 'v1.0'])));
test('gh issue close', () => assert.ok(!isSafeGhCommand(['gh', 'issue', 'close', '42'])));
test('gh pr merge', () => assert.ok(!isSafeGhCommand(['gh', 'pr', 'merge', '10'])));
test('gh workflow run', () => assert.ok(!isSafeGhCommand(['gh', 'workflow', 'run', 'ci.yml'])));
test('gh api POST', () => assert.ok(!isSafeGhCommand(['gh', 'api', 'repos/o/r/issues', '--method', 'POST'])));
test('gh api DELETE', () => assert.ok(!isSafeGhCommand(['gh', 'api', 'repos/o/r/releases/1', '--method', 'DELETE'])));
test('gh api PATCH via -X', () => assert.ok(!isSafeGhCommand(['gh', 'api', 'repos/o/r/issues/1', '-X', 'PATCH'])));
test('pipe in args', () => assert.ok(!isSafeGhCommand(['gh', 'run', 'view', '123', '|', 'grep', 'error'])));
test('shell injection in --jq', () => assert.ok(!isSafeGhCommand(['gh', 'api', 'repos/o/r', '--jq', '$(rm -rf /)'])));
test('backtick in arg', () => assert.ok(!isSafeGhCommand(['gh', 'run', 'view', '`id`'])));
test('semicolon in arg', () => assert.ok(!isSafeGhCommand(['gh', 'run', 'view', '123;rm -rf /'])));
test('non-gh command', () => assert.ok(!isSafeGhCommand(['bash', '-c', 'rm -rf /'])));
test('non-string element', () => assert.ok(!isSafeGhCommand(['gh', 'run', 'view', 123])));
test('empty array', () => assert.ok(!isSafeGhCommand([])));
test('only gh', () => assert.ok(!isSafeGhCommand(['gh'])));

const total = passed + failed;
console.log(`\n${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}\n`);
if (failed > 0) process.exit(1);
