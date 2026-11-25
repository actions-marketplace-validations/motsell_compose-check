import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compareComposeBytes } from '../lib/compare.mjs';

const bin = fileURLToPath(new URL('../bin/compose-check.mjs', import.meta.url));
const fixture = name => ({name,services:{sample:{image:'postgres:17',
  volumes:[{type:'volume',source:'store',target:'/synthetic/data'}]}},volumes:{store:{name:`${name}_store`}}});
const bytes = value => Buffer.from(JSON.stringify(value));
const command = args => spawnSync(process.execPath,[bin,...args],{encoding:'utf8',timeout:5000});

test('physical volume change is a review item, not a data restore assertion',()=>{
  const report = compareComposeBytes(bytes(fixture('source-demo')),bytes(fixture('destination-demo')));
  assert.equal(report.status,'manual_review_required');
  assert.equal(report.mode,'compare');
  const change = report.findings.find(x=>x.code==='VOLUME_PHYSICAL_NAME_CHANGED');
  assert.deepEqual(change,{code:'VOLUME_PHYSICAL_NAME_CHANGED',priority:'important',scope:'volume',source:1,destination:1,sourceItem:null,destinationItem:null});
  assert(!JSON.stringify(report).includes('source-demo'));
});

test('equal configuration remains a manual review, even with no items',()=>{
  const input=bytes(fixture('same-demo'));
  const report=compareComposeBytes(input,input);
  assert.equal(report.findings.length,0);
  assert.equal(report.status,'manual_review_required');
});

test('CLI compare uses two explicit files, fixed JSON output and existing exit semantics',()=>{
  const dir=mkdtempSync(join(tmpdir(),'motsell-compare-test-'));
  try {
    const a=join(dir,'source.json'), b=join(dir,'destination.json');
    writeFileSync(a,bytes(fixture('source-demo'))); writeFileSync(b,bytes(fixture('destination-demo')));
    const result=command(['--file',a,'--compare',b,'--json']);
    assert.equal(result.status,1); assert.equal(result.stderr,'');
    assert.equal(JSON.parse(result.stdout).mode,'compare');
    assert(!result.stdout.includes(dir)); assert(!result.stdout.includes('source-demo'));
    writeFileSync(b,bytes(fixture('source-demo')));
    assert.equal(command(['--file',a,'--compare',b,'--json']).status,0);
    writeFileSync(b,'not JSON');
    const invalid=command(['--file',a,'--compare',b,'--json']);
    assert.equal(invalid.status,2); assert.equal(invalid.stdout,'');
    assert.deepEqual(JSON.parse(invalid.stderr),{schemaVersion:1,error:'DESTINATION_INVALID_JSON'});
    assert(!invalid.stderr.includes(dir));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
