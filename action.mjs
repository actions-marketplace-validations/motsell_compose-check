import { spawnSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./bin/compose-check.mjs', import.meta.url));

async function workspaceFile(workspace, input) {
  if (!workspace || !isAbsolute(workspace) || !input || input.length > 4096 ||
      isAbsolute(input) || /^[a-z][a-z\d+.-]*:/i.test(input) ||
      /[\u0000-\u001f\u007f\\]/.test(input) || input.split('/').includes('..')) {
    throw Error('Invalid input path');
  }
  const root = await realpath(workspace);
  if (!(await lstat(root)).isDirectory()) throw Error('Invalid workspace');
  const target = resolve(root, input);
  const within = relative(root, target);
  if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) {
    throw Error('Invalid input path');
  }
  // Reject symlinks in both directory components and the final file.
  const parts = within.split(sep);
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) {
      throw Error('Invalid input path');
    }
  }
  if (await realpath(target) !== target) throw Error('Invalid input path');
  return target;
}

async function main() {
  const failOnImportant = process.env.INPUT_FAIL_ON_IMPORTANT ?? 'false';
  if (!['true', 'false'].includes(failOnImportant)) {
    process.stderr.write('INPUT_INVALID: fail_on_important must be true or false.\n');
    process.exitCode = 2;
    return;
  }
  let file;
  try {
    file = await workspaceFile(process.env.GITHUB_WORKSPACE, process.env.INPUT_JSON_FILE);
  } catch {
    // Do not echo user-supplied paths or underlying filesystem errors.
    process.stderr.write('INPUT_INVALID: select a regular JSON file inside the workspace with no symlink components.\n');
    process.exitCode = 2;
    return;
  }
  // Reuse the existing audited CLI unchanged. The file is a literal argument;
  // the child receives no inherited environment, secrets, or token.
  const result = spawnSync(process.execPath, [cli, '--file', file], {
    shell: false,
    env: {},
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    maxBuffer: 1024 * 1024
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    process.stderr.write('CHECK_FAILED: invalid input, unreadable file, or local checker failure.\n');
    process.exitCode = 2;
    return;
  }
  // CLI output contains only fixed messages and counters, never input values.
  process.stdout.write(result.stdout);
  if (result.status === 1 && failOnImportant === 'false') {
    process.stdout.write('Advisory mode: important review cues require manual review.\n');
  }
  process.exitCode = failOnImportant === 'true' ? result.status : 0;
}

await main().catch(() => {
  process.stderr.write('CHECK_FAILED: local checker failure.\n');
  process.exitCode = 2;
});
