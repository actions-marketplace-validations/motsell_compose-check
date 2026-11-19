#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { analyze, InputError, MAX_INPUT_BYTES, parseCompose } from '../lib/analyze.mjs';
import { errorMessage, render } from '../lib/messages.mjs';

const usage = `Usage: motsell-compose-check [--file PATH] [--json] [--lang en|ru]\n\nRead UTF-8 normalized Docker Compose JSON from stdin, or an explicit regular file.\nExit codes: 0 = analyzed, no important review cues; 1 = important review cues;\n2 = invalid arguments, unreadable input or invalid JSON/configuration.\nReview findings may be present with exit 0.\n`;

function options(args, opts) {
  const seen = new Set();
  let invalid = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!['--file', '--json', '--lang', '--help', '-h'].includes(arg) || seen.has(arg)) {
      invalid = true;
      continue;
    }
    seen.add(arg);
    if (arg === '--file') {
      opts.file = args[++i];
      if (!opts.file) invalid = true;
    } else if (arg === '--lang') {
      const lang = args[++i];
      if (lang !== 'en' && lang !== 'ru') invalid = true;
      else opts.lang = lang;
    } else if (arg === '--json') opts.json = true;
    else opts.help = true;
  }
  if (invalid) throw new InputError('INVALID_ARGS');
}

async function readStdin() {
  if (process.stdin.isTTY) throw new InputError('INPUT_REQUIRED');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new InputError('INPUT_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!size) throw new InputError('INPUT_REQUIRED');
  return Buffer.concat(chunks, size);
}

async function readFile(path) {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path) || /^(?:\\\\|\/\/)/.test(path)) throw new InputError('FILE_NOT_REGULAR');
  // Reject non-regular files before opening; repeat on the open descriptor.
  // On platforms providing these flags, do not follow a final-component symlink
  // or block on a path swapped to a pipe between the two checks.
  const before = await lstat(path);
  if (!before.isFile()) throw new InputError('FILE_NOT_REGULAR');
  if (before.size > MAX_INPUT_BYTES) throw new InputError('INPUT_TOO_LARGE');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) throw new InputError('FILE_NOT_REGULAR');
    if (info.size > MAX_INPUT_BYTES) throw new InputError('INPUT_TOO_LARGE');
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_INPUT_BYTES) throw new InputError('INPUT_TOO_LARGE');
    if (!size) throw new InputError('INPUT_REQUIRED');
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}

async function main() {
  const opts = { lang: 'en', json: false };
  try {
    options(process.argv.slice(2), opts);
    if (opts.help) {
      process.stdout.write(usage);
      return;
    }
    const bytes = opts.file !== undefined ? await readFile(opts.file) : await readStdin();
    const report = analyze(parseCompose(bytes));
    process.stdout.write(opts.json ? JSON.stringify(report, null, 2) + '\n' : render(report, opts.lang));
    process.exitCode = report.findings.some(finding => finding.priority === 'important') ? 1 : 0;
  } catch (error) {
    const code = error instanceof InputError ? error.code : 'INPUT_READ_FAILED';
    process.stderr.write(opts.json
      ? JSON.stringify({ schemaVersion: 1, error: code }) + '\n'
      : `${code}: ${errorMessage(code, opts.lang)}\n`);
    process.exitCode = 2;
  }
}

await main();
