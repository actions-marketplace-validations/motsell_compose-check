import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const action = fileURLToPath(new URL('../action.mjs', import.meta.url));
const normal = JSON.stringify({ services: { app: { image: 'node:22-alpine' } } });
const important = JSON.stringify({ services: { database: {
  image: 'postgres:17', environment: { EXAMPLE_VALUE: 'synthetic-value-not-for-logs' }
} } });

function temporary(fn) {
  const folder = mkdtempSync(join(tmpdir(), 'motsell-action-test-'));
  try { fn(folder); }
  finally { rmSync(folder, { recursive: true, force: true }); }
}

function run(workspace, file, failOnImportant) {
  const env = { GITHUB_WORKSPACE: workspace, GITHUB_TOKEN: 'synthetic-token-not-for-logs' };
  if (file !== undefined) env.INPUT_JSON_FILE = file;
  if (failOnImportant !== undefined) env.INPUT_FAIL_ON_IMPORTANT = failOnImportant;
  const result = spawnSync(process.execPath, [action], { env, cwd: workspace, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-(?:token|value)-not-for-logs/);
  return result;
}

test('fixed normal report and default advisory mode for important cues', () => temporary(folder => {
  writeFileSync(join(folder, 'normal.json'), normal);
  writeFileSync(join(folder, 'important.json'), important);
  const clean = run(folder, 'normal.json');
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /Services: 1/);
  assert.equal(clean.stderr, '');
  const advisory = run(folder, 'important.json');
  assert.equal(advisory.status, 0);
  assert.match(advisory.stdout, /DATA_MOUNT_NOT_FOUND/);
  assert.match(advisory.stdout, /Advisory mode/);
  assert.equal(advisory.stderr, '');
  const gate = run(folder, 'important.json', 'true');
  assert.equal(gate.status, 1);
  assert.match(gate.stdout, /DATA_MOUNT_NOT_FOUND/);
  assert.doesNotMatch(gate.stdout, /Advisory mode/);
}));

test('workspace paths with leading dots, spaces and literal punctuation work', () => temporary(folder => {
  mkdirSync(join(folder, 'sub folder'));
  const file = `sub folder/compose (draft) $notes; 'v1'.json`;
  writeFileSync(join(folder, file), normal);
  const report = run(folder, `./${file}`);
  assert.equal(report.status, 0);
  assert.match(report.stdout, /Services: 1/);
  assert.doesNotMatch(report.stdout + report.stderr, /sub folder|\$notes|draft/);
}));

test('missing, outside, parent, URLs, special paths and symlinks fail without echo', () => temporary(folder => {
  const workspace = join(folder, 'workspace');
  mkdirSync(workspace);
  const outside = join(folder, 'outside-private.json');
  writeFileSync(outside, normal);
  mkdirSync(join(folder, 'outside-dir'));
  writeFileSync(join(folder, 'outside-dir', 'outside-private.json'), normal);
  writeFileSync(join(workspace, 'inside.json'), normal);
  symlinkSync(outside, join(workspace, 'outside-link.json'));
  symlinkSync(join(workspace, 'inside.json'), join(workspace, 'inside-link.json'));
  symlinkSync(join(folder, 'outside-dir'), join(workspace, 'linked-dir'), 'dir');
  for (const path of [undefined, '', '.', 'missing.json', outside, '../outside-private.json',
    'https://example.invalid/private.json', 'C:/private.json', 'some\\private.json', '//example.invalid/file.json',
    'outside-link.json', 'inside-link.json', 'linked-dir/outside-private.json', 'private\nname.json']) {
    const result = run(workspace, path);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^INPUT_INVALID:/);
    assert.doesNotMatch(result.stderr, /outside-private|example\.invalid|private\.json|private\nname/);
  }
}));

test('invalid config, oversized file and invalid gating option fail with fixed messages', () => temporary(folder => {
  writeFileSync(join(folder, 'invalid.json'), '{"token":"synthetic-value-not-for-logs"');
  writeFileSync(join(folder, 'large.json'), Buffer.alloc(250001, 32));
  writeFileSync(join(folder, 'normal.json'), normal);
  for (const file of ['invalid.json', 'large.json']) {
    const result = run(folder, file);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^CHECK_FAILED:/);
    assert.doesNotMatch(result.stderr, /invalid\.json|large\.json/);
  }
  const result = run(folder, 'normal.json', 'yes');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^INPUT_INVALID:/);
}));
