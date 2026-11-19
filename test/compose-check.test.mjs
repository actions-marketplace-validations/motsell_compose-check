import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { analyze, MAX_INPUT_BYTES, MAX_SERVICES, parseCompose } from '../lib/analyze.mjs';

const bin = fileURLToPath(new URL('../bin/compose-check.mjs', import.meta.url));
const example = fileURLToPath(new URL('../examples/compose.json', import.meta.url));
const normalized = { services: { app: { image: 'node:22-alpine' } } };
const noFindingsInput = JSON.stringify(normalized);

function cli(args = [], input = '') {
  const result = spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

function assertCliError(result, code) {
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), { schemaVersion: 1, error: code });
}

function withTemp(testFn) {
  const folder = mkdtempSync(join(tmpdir(), 'motsell-compose-check-test-'));
  try { testFn(folder); }
  finally { rmSync(folder, { recursive: true, force: true }); }
}

test('normalized example mirrors the browser checker and adds dependency review', () => {
  const report = analyze(parseCompose(readFileSync(example)));
  assert.deepEqual(report, {
    schemaVersion: 1, services: 3, possibleDatabases: 1, publishedPortEntries: 1,
    findings: [
      { code: 'DATA_RESTORE_REVIEW', priority: 'review', service: 1 },
      { code: 'BUILD_CONTEXT_REVIEW', priority: 'review', service: 2 },
      { code: 'DEPENDENCY_REVIEW', priority: 'review', service: 2 },
      { code: 'BIND_MOUNT_REVIEW', priority: 'review', service: 3 }
    ]
  });
  const result = cli(['--file', example, '--json']);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), report);
  assert.equal(result.stderr, '');
});

test('possible database without persistence and non-loopback publication is important', () => {
  const db = { services: { database: { image: 'postgres:17', ports: [{ target: 5432, published: '15432' }] } } };
  const result = cli(['--json'], JSON.stringify(db));
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout).findings, [
    { code: 'DATA_MOUNT_NOT_FOUND', priority: 'important', service: 1 },
    { code: 'DATA_PORT_PUBLICATION_REVIEW', priority: 'important', service: 1 }
  ]);
  assert.equal(result.stderr, '');
});

test('loopback mapping is not flagged as non-loopback; restoration is still a manual check', () => {
  const make = host_ip => ({ services: { cache: {
    image: 'redis:7', ports: [{ target: 6379, host_ip }], volumes: [{ type: 'volume', source: 'cachedata', target: '/data' }]
  } } });
  for (const address of ['127.0.0.1', '127.5.8.13', '::1', '0:0:0:0:0:0:0:1', '0:0:0:0:0::0001']) {
    assert.deepEqual(analyze(make(address)).findings.map(f => f.code), ['DATA_RESTORE_REVIEW']);
  }
  for (const address of [undefined, '0.0.0.0', '::', '192.0.2.10']) {
    assert.equal(analyze(make(address)).findings[0].code, 'DATA_PORT_PUBLICATION_REVIEW');
  }
  for (const address of ['${HOST_IP}', '127.999.0.1', 'localhost']) {
    assert.deepEqual(analyze(make(address)).findings.map(f => f.code), ['DATA_RESTORE_REVIEW', 'PORT_MAPPING_REVIEW']);
  }
});

test('typical data-service target triggers a cue even when service/image names are unknown', () => {
  const report = analyze({ services: { foo: { ports: [{ target: '3306', host_ip: '0.0.0.0' }] } } });
  assert.equal(report.possibleDatabases, 0);
  assert.equal(report.findings[0].code, 'DATA_PORT_PUBLICATION_REVIEW');
});

test('unresolved normalized fields produce fixed review cues', () => {
  const report = analyze({services: {app: {
    ports: [{target: 80, published: '${PORT}'}],
    volumes: [{type: 'volume', source: '${VOLUME}', target: '/data'}]
  }}});
  assert.deepEqual(report.findings.map(f => f.code), ['MOUNT_MAPPING_REVIEW', 'VOLUME_BACKUP_REVIEW', 'PORT_MAPPING_REVIEW']);
  assert.deepEqual(analyze({services: {app: {ports: [{target: 80, published: {toString: 'private'}}]}}}).findings,
    [{code: 'PORT_MAPPING_REVIEW', priority: 'review', service: 1}]);
});

test('readonly, anonymous, tmpfs and unresolved mounts do not establish persistence', () => {
  for (const mount of [
    { type: 'volume', source: 'data', target: '/data', read_only: true },
    { type: 'volume', target: '/data' },
    { type: 'tmpfs', target: '/data' },
    { type: 'bind', source: '${UNRESOLVED}', target: '/data' },
    'pgdata:/data', { type: 'volume', source: 'pgdata' }
  ]) {
    const report = analyze({ services: { db: { image: 'postgres:17', volumes: [mount] } } });
    assert.equal(report.findings[0].code, 'DATA_MOUNT_NOT_FOUND');
  }
});

test('external resources, host dependencies, architecture and mapping checks remain bounded', () => {
  const config = {
    services: { app: { platform: 'linux/amd64', network_mode: 'host', env_file: [{ path: '/secret/path' }],
      volumes: [{ type: 'volume', source: 'appdata', target: '/data' }, '/unresolved:/data'], ports: ['80:80'] } },
    volumes: { appdata: { external: true } }, networks: { net: { external: true } },
    secrets: { token: { external: true }, local: { file: '/secret/path' } }, configs: { settings: { external: true } }
  };
  assert.deepEqual(analyze(config).findings.map(f => f.code), [
    'MOUNT_MAPPING_REVIEW', 'VOLUME_BACKUP_REVIEW', 'PORT_MAPPING_REVIEW', 'PLATFORM_REVIEW', 'HOST_NETWORK_REVIEW',
    'ENV_FILE_REVIEW', 'EXTERNAL_VOLUMES_REVIEW', 'EXTERNAL_NETWORKS_REVIEW', 'EXTERNAL_SECRETS_REVIEW',
    'EXTERNAL_CONFIGS_REVIEW', 'CONFIG_INPUT_REVIEW'
  ]);
});

test('reporting redacts arbitrary input data including names and paths in both languages', () => {
  const canaries = ['SENSITIVE-SERVICE-NAME-REDACTION-TEST', 'SENSITIVE_IMAGE_TEST', 'SENSITIVE_PATH_TEST', 'SENSITIVE_SECRET_TEST'];
  const json = JSON.stringify({ services: { [canaries[0]]: {
    image: canaries[1], volumes: [{ type: 'bind', source: canaries[2], target: '/data' }],
    environment: { PASSWORD: canaries[3] }
  } } });
  for (const args of [[], ['--lang', 'ru'], ['--json']]) {
    const result = cli(args, json);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes('BIND_MOUNT_REVIEW'));
    assert.equal(result.stderr, '');
    for (const canary of canaries) assert.ok(!result.stdout.includes(canary));
  }
  const invalid = cli(['--json'], json.slice(0, -2));
  assertCliError(invalid, 'INVALID_JSON');
  for (const canary of canaries) assert.ok(!invalid.stderr.includes(canary));
});

test('invalid shape and mapping arrays produce fixed codes', () => {
  for (const value of [null, [], {}, { services: [] }]) {
    assertCliError(cli(['--json'], JSON.stringify(value)), 'INVALID_CONFIG');
  }
  for (const services of [{}, { 'name with spaces': {} }, { app: 42 }, { ['a'.repeat(65)]: {} },
    Object.fromEntries(Array.from({length: MAX_SERVICES + 1}, (_, i) => [`s${i}`, {}]))]) {
    assertCliError(cli(['--json'], JSON.stringify({ services })), 'INVALID_SERVICES');
  }
  for (const value of [{ ports: {} }, { volumes: [true] }, { ports: [null] }, { volumes: 'data' }]) {
    assertCliError(cli(['--json'], JSON.stringify({ services: { app: value } })), 'INVALID_MAPPINGS');
  }
});

test('size limit applies to bytes at both boundaries, and invalid UTF-8 is rejected', () => {
  const exact = Buffer.from(noFindingsInput.padEnd(MAX_INPUT_BYTES, ' '));
  assert.equal(exact.length, MAX_INPUT_BYTES);
  assert.equal(cli(['--json'], exact).status, 0);
  assertCliError(cli(['--json'], Buffer.concat([exact, Buffer.from(' ')])), 'INPUT_TOO_LARGE');
  const utf8 = Buffer.alloc(MAX_INPUT_BYTES + 1, 'Ж');
  assertCliError(cli(['--json'], utf8), 'INPUT_TOO_LARGE');
  assertCliError(cli(['--json'], Buffer.from([0xc3, 0x28])), 'INVALID_JSON');
  assertCliError(cli(['--json']), 'INPUT_REQUIRED');
});

test('explicit file supports spaces and rejects directories, symlinks, URLs and missing names', () => withTemp(dir => {
  const file = join(dir, 'config with spaces.json');
  writeFileSync(file, noFindingsInput);
  const result = cli(['--file', file, '--json']);
  assert.equal(result.status, 0);
  assertCliError(cli(['--json', '--file', dir]), 'FILE_NOT_REGULAR');
  assertCliError(cli(['--json', '--file', 'https://example.invalid/config.json']), 'FILE_NOT_REGULAR');
  assertCliError(cli(['--json', '--file', '\\\\not-a-server\\share\\config.json']), 'FILE_NOT_REGULAR');
  assertCliError(cli(['--json', '--file']), 'INVALID_ARGS');
  assertCliError(cli(['--json', '--file', join(dir, 'PRIVATE_MISSING_FILENAME')]), 'INPUT_READ_FAILED');
  if (process.platform !== 'win32') {
    const link = join(dir, 'link.json');
    symlinkSync(file, link);
    assertCliError(cli(['--json', '--file', link]), 'FILE_NOT_REGULAR');
    assertCliError(cli(['--json', '--file', '/dev/null']), 'FILE_NOT_REGULAR');
  }
}));

test('file input enforces the same byte limit and does not leak filename', () => withTemp(dir => {
  const file = join(dir, 'PRIVATE_FILE_TEST.json');
  writeFileSync(file, Buffer.from(noFindingsInput.padEnd(MAX_INPUT_BYTES, ' ')));
  assert.equal(cli(['--json', '--file', file]).status, 0);
  writeFileSync(file, Buffer.alloc(MAX_INPUT_BYTES + 1));
  assertCliError(cli(['--json', '--file', file]), 'INPUT_TOO_LARGE');
  const absent = cli(['--file', join(dir, 'PRIVATE_FILE_NOT_FOUND.json')]);
  assert.equal(absent.status, 2);
  assert.equal(absent.stdout, '');
  assert.ok(!absent.stderr.includes('PRIVATE_FILE_NOT_FOUND'));
}));

test('JSON output is language-independent and invalid options never echo their values', () => {
  const en = cli(['--json', '--lang', 'en'], noFindingsInput);
  const ru = cli(['--json', '--lang', 'ru'], noFindingsInput);
  assert.equal(en.stdout, ru.stdout);
  assert.deepEqual(JSON.parse(en.stdout).findings, []);
  assertCliError(cli(['--json', '--lang', 'PRIVATE_BAD_OPTION'], noFindingsInput), 'INVALID_ARGS');
  assertCliError(cli(['--json', '--private-argument'], noFindingsInput), 'INVALID_ARGS');
  assertCliError(cli(['--private-argument', '--json'], noFindingsInput), 'INVALID_ARGS');
  assertCliError(cli(['--json', '--json'], noFindingsInput), 'INVALID_ARGS');
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('motsell-compose-check'));
});
