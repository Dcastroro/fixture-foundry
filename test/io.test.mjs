import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileSchema, loadSchema, writeToFile, LIMITS } from '../src/index.mjs';
const CLI = resolve('bin/fixture-foundry.mjs');
const input = { version:1,namespace:'test',fields:[{ name:'id',type:'sequence' }] };
const model = compileSchema(input);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'fixture-foundry-'));
  t.after(() => rmSync(root,{ recursive:true,force:true }));
  return root;
}
const cli = (args,extra = {}) => spawnSync(process.execPath,[CLI,...args],{ encoding:'utf8',timeout:10000,windowsHide:true,...extra });
test('file output publishes complete data and refuses an existing file',async t => {
  const root = fixture(t); const path = join(root,'data.jsonl');
  await writeToFile(model,{ rows:2 },path);
  assert.equal(readFileSync(path,'utf8'),'{"id":1}\n{"id":2}\n');
  await assert.rejects(writeToFile(model,{ rows:3 },path),{ code:'output-exists' });
  assert.deepEqual(readdirSync(root),['data.jsonl']);
  assert.equal(readFileSync(path,'utf8'),'{"id":1}\n{"id":2}\n');
});
test('failed generation leaves no output or temporary file',async t => {
  const root = fixture(t); const path = join(root,'data.jsonl');
  await assert.rejects(writeToFile(model,{ rows:100,maxBytes:10 },path),{ code:'output-limit' });
  assert.equal(existsSync(path),false); assert.deepEqual(readdirSync(root),[]);
});
test('cancellation leaves no file, including during generation',async t => {
  const root = fixture(t); const controller = new AbortController();
  const timer = setImmediate(() => controller.abort());
  await assert.rejects(writeToFile(model,{ rows:1000000,signal:controller.signal },join(root,'data.jsonl')),{ code:'cancelled' });
  clearImmediate(timer); assert.deepEqual(readdirSync(root),[]);
});
test('concurrent publishers never replace each other',async t => {
  const root = fixture(t); const path = join(root,'data.jsonl');
  const result = await Promise.allSettled([writeToFile(model,{ rows:10 },path),writeToFile(model,{ rows:20 },path)]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length,1);
  assert.equal(result.find(item => item.status === 'rejected').reason.code,'output-exists');
  assert.ok([10,20].includes(readFileSync(path,'utf8').trim().split('\n').length));
  assert.deepEqual(readdirSync(root),['data.jsonl']);
});
test('linked parent and existing directory outputs are rejected',async t => {
  const root = fixture(t); const outside = fixture(t); const parent = join(root,'linked');
  symlinkSync(outside,parent,process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeToFile(model,{ rows:1 },join(parent,'data.jsonl')),{ code:'unsafe-output' });
  mkdirSync(join(root,'directory'));
  await assert.rejects(writeToFile(model,{ rows:1 },join(root,'directory')),{ code:'output-exists' });
  assert.deepEqual(readdirSync(outside),[]);
});
test('schema loader bounds files and rejects malformed, oversized and invalid UTF-8 input',t => {
  const root = fixture(t); const path = join(root,'schema.json');
  writeFileSync(path,JSON.stringify(input)); assert.equal(loadSchema(path).fields.length,1);
  for (const bytes of ['{"secret":"PRIVATE_SENTINEL"',Buffer.from([0xff,0xfe]),' '.repeat(LIMITS.schemaBytes + 1)]) {
    writeFileSync(path,bytes); assert.throws(() => loadSchema(path),{ code:'schema-file',message:'schema-file' });
  }
  assert.throws(() => loadSchema(root),{ code:'schema-file' });
});
test('CLI supports offline validation, version and reproducible generation',t => {
  const root = fixture(t); const path = join(root,'schema.json'); writeFileSync(path,JSON.stringify(input));
  const version = cli(['--version']); assert.equal(version.status,0); assert.equal(version.stdout.trim(),'0.1.0');
  const help = cli(['--help']); assert.equal(help.status,0); assert.match(help.stdout,/--offset/);
  const validated = cli(['validate','--schema',path]); assert.equal(validated.status,0); assert.deepEqual(JSON.parse(validated.stdout),{ ok:true,version:1,fields:1 });
  const run = cli(['generate','--schema',path,'--rows','2','--offset','4']);
  assert.equal(run.status,0); assert.equal(run.stderr,''); assert.equal(run.stdout,'{"id":5}\n{"id":6}\n');
  const output = join(root,'out.csv');
  const csv = cli(['generate','--schema',path,'--rows','2','--format','csv','--no-header','--out',output]);
  assert.equal(csv.status,0); assert.equal(csv.stdout,''); assert.equal(readFileSync(output,'utf8'),'1\r\n2\r\n');
});
test('CLI rejects duplicate options, unsupported flags and unsafe workloads without echoing inputs',t => {
  const root = fixture(t); const path = join(root,'PRIVATE_SCHEMA.json'); writeFileSync(path,JSON.stringify(input));
  for (const args of [[],['--rows','1','--rows','2'],['--rows','0'],['--rows','1000001'],['--rows','1e6'],['--format','PRIVATE_FORMAT'],['--token','PRIVATE_TOKEN'],['--no-header']]) {
    const result = cli(args.length ? ['generate','--schema',path,...args] : []);
    assert.equal(result.status,2); assert.equal(result.stdout,''); assert.equal(result.stderr.includes('PRIVATE_'),false); assert.equal(JSON.parse(result.stderr).ok,false);
  }
  writeFileSync(path,'{"PRIVATE_CONFIG":');
  const result = cli(['generate','--schema',path]); assert.equal(result.status,2); assert.equal(result.stdout,''); assert.equal(result.stderr.includes('PRIVATE_'),false);
});
test('CLI output cap returns a fixed error and never publishes a partial file',t => {
  const root = fixture(t); const path = join(root,'schema.json'); writeFileSync(path,JSON.stringify(input));
  const out = join(root,'fixture.jsonl');
  const result = cli(['generate','--schema',path,'--rows','100','--max-bytes','20','--out',out]);
  assert.equal(result.status,2); assert.equal(JSON.parse(result.stderr).error.code,'output-limit'); assert.equal(existsSync(out),false);
  assert.deepEqual(readdirSync(root),['schema.json']);
});
test('environment variables are never read as fixture values',t => {
  const root = fixture(t); const path = join(root,'schema.json');
  writeFileSync(path,JSON.stringify({ ...input,fields:[{ name:'email',type:'email' }] }));
  const result = cli(['generate','--schema',path,'--rows','10'],{ env:{ ...process.env,PRIVATE_TOKEN:'NEVER_COPY_THIS_SENTINEL',DATABASE_URL:'NEVER_COPY_THIS_DATABASE' } });
  assert.equal(result.status,0); assert.equal((result.stdout + result.stderr).includes('NEVER_COPY_THIS'),false);
});
