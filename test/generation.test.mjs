import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compileSchema, generate, loadSchema, LIMITS, writeToStream } from '../src/index.mjs';

const field = (type,extra = {}) => ({ name: 'value', type, ...extra });
const raw = fields => ({ version: 1, namespace: 'test', fields });
const schema = fields => compileSchema(raw(fields));
async function collect(model,opts) { let text = ''; for await (const chunk of generate(model,opts)) text += chunk; return text; }
async function rows(model,opts) { return (await collect(model,opts)).trim().split('\n').map(JSON.parse); }
const all = () => schema([
  { name: 'id', type: 'sequence', prefix: 'usr_' },
  { name: 'number', type: 'integer', min: -100, max: 100 },
  { name: 'enabled', type: 'boolean' },
  { name: 'tier', type: 'choice', values: ['free','team',null,42,false] },
  { name: 'email', type: 'email' },
  { name: 'uuid', type: 'uuid' },
  { name: 'date', type: 'timestamp', from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
  { name: 'owner', type: 'reference', count: 50, start: 5, prefix: 'usr_' },
]);

test('all field types have bounded, usable output with distinct synthetic addresses', async () => {
  const data = await rows(all(),{ rows: 1000 });
  const emails = new Set(); const uuids = new Set();
  for (const [i,row] of data.entries()) {
    assert.equal(row.id,`usr_${i + 1}`);
    assert.ok(Number.isInteger(row.number) && row.number >= -100 && row.number <= 100);
    assert.equal(typeof row.enabled,'boolean');
    assert.ok(['free','team',null,42,false].includes(row.tier));
    assert.match(row.email,/^user-\d+-[a-f0-9]{12}@example\.test$/);
    assert.match(row.uuid,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.ok(row.date >= '2026-01-01T00:00:00.000Z' && row.date <= '2026-01-31T23:59:59.999Z');
    assert.ok(Number(row.owner.slice(4)) >= 5 && Number(row.owner.slice(4)) <= 54);
    emails.add(row.email); uuids.add(row.uuid);
  }
  assert.equal(emails.size,1000); assert.equal(uuids.size,1000);
});
test('same seed gives byte-identical fixtures; random fields change for a different seed', async () => {
  const model = all();
  assert.equal(await collect(model,{ rows: 100, seed: 'one' }),await collect(model,{ rows: 100, seed: 'one' }));
  assert.notEqual(await collect(model,{ seed: 'one' }),await collect(model,{ seed: 'two' }));
});
test('version 1 values match a fixed golden vector across platforms and runtimes',async () => {
  for (const [file,expected] of [
    ['users','a062b091eda9e9c9a1bbf385c5a52ad3c8e1c1237bca2b808101666610cf424f'],
    ['orders','7e8dff0f2906c4711e50bb9f2cf97c0eab273b6d3c1903a14168bb1c22b1b1f3'],
  ]) {
    const model = loadSchema(fileURLToPath(new URL(`../examples/${file}.schema.json`,import.meta.url)));
    const data = await collect(model,{ rows:12,seed:'golden-v1',offset:7 });
    assert.equal(createHash('sha256').update(data).digest('hex'),expected);
  }
});
test('JSONL partitions concatenate exactly including offsets near the maximum', async () => {
  const model = all(); const opts = { seed: 'partition', offset: LIMITS.offset - 100, rows: 100 };
  assert.equal(await collect(model,opts),await collect(model,{ ...opts, rows: 40 }) + await collect(model,{ ...opts, offset: opts.offset + 40, rows: 60 }));
});
test('CSV partitions concatenate exactly when subsequent headers are disabled', async () => {
  const model = all();
  assert.equal(await collect(model,{ format: 'csv', rows: 100 }),await collect(model,{ format: 'csv', rows: 25 }) + await collect(model,{ format: 'csv', header: false, offset: 25, rows: 75 }));
});
test('field additions and reordering preserve existing values, namespaces separate streams', async () => {
  const a = await rows(schema([field('uuid')]),{ rows: 25 });
  const b = await rows(schema([{ name: 'new', type: 'boolean' },field('uuid')]),{ rows: 25 });
  assert.deepEqual(a.map(row => row.value),b.map(row => row.value));
  const other = compileSchema({ ...raw([field('uuid')]), namespace: 'other' });
  assert.notDeepEqual(a,await rows(other,{ rows: 25 }));
});
test('compiled schema is immutable and detached from caller mutation', async () => {
  const input = raw([field('choice',{ values: ['a'] })]); const model = compileSchema(input);
  input.fields[0].values[0] = 'changed'; input.namespace = 'changed';
  assert.deepEqual(await rows(model,{ rows: 1 }),[{ value: 'a' }]);
  assert.throws(() => model.fields[0].values.push('b'),TypeError);
});
test('CSV escapes quotes and delimiters and neutralizes formula strings', async () => {
  const fields = ['=SUM(1,2)',' +1','-20','@cmd','a,"b"'].map((value,i) => ({ name: `f${i}`, type: 'choice', values: [value] }));
  fields.push({ name: 'number', type: 'integer', min: -20, max: -20 });
  assert.equal(await collect(schema(fields),{ rows: 1, format: 'csv' }), 'f0,f1,f2,f3,f4,number\r\n"\'=SUM(1,2)",\' +1,\'-20,\'@cmd,"a,""b""",-20\r\n');
});
test('singleton ranges, numeric sequences and empty prefixes preserve types', async () => {
  const model = schema([{ name:'a',type:'sequence',start:-5,step:3 },{ name:'b',type:'sequence',prefix:'' },{ name:'c',type:'reference',count:1,start:20 },{ name:'d',type:'timestamp',from:'2026-01-01T00:00:00.000Z',to:'2026-01-01T00:00:00.000Z' }]);
  assert.deepEqual((await rows(model,{ rows:1,offset:2 }))[0],{ a:1,b:'3',c:20,d:'2026-01-01T00:00:00.000Z' });
});

const invalid = [
  ['version', { version:2,namespace:'test',fields:[field('boolean')] }],
  ['namespace', { version:1,namespace:'private/name',fields:[field('boolean')] }],
  ['empty fields',raw([])], ['too many fields',raw(Array.from({ length:65 },(_,i) => ({ name:`f${i}`,type:'boolean' })))],
  ['duplicates',raw([field('boolean'),field('uuid')])], ['prototype field',raw([{ name:'constructor',type:'boolean' }])],
  ['unknown schema key',{ ...raw([field('boolean')]),url:'https://example.test' }],
  ['executable field',raw([field('boolean',{ expression:'process.env' })])],
  ['unknown type',raw([field('script')])], ['integer range',raw([field('integer',{ min:2,max:1 })])],
  ['fraction',raw([field('integer',{ min:0.5,max:2 })])], ['oversized integer',raw([field('integer',{ min:0,max:1e12 })])],
  ['empty choice',raw([field('choice',{ values:[] })])], ['object choice',raw([field('choice',{ values:[{}] })])],
  ['long string',raw([field('choice',{ values:['x'.repeat(257)] })])], ['control string',raw([field('choice',{ values:['\t=bad'] })])],
  ['lone surrogate',raw([field('choice',{ values:['\ud800'] })])],
  ['zero references',raw([field('reference',{ count:0 })])], ['null prefix',raw([field('reference',{ count:1,prefix:null })])],
  ['null start',raw([field('sequence',{ start:null })])], ['negative step',raw([field('sequence',{ step:-1 })])],
  ['bad date',raw([field('timestamp',{ from:'2026-02-31T00:00:00.000Z',to:'2026-03-31T00:00:00.000Z' })])],
  ['long date range',raw([field('timestamp',{ from:'2000-01-01T00:00:00.000Z',to:'2100-01-01T00:00:00.000Z' })])],
];
for (const [name,input] of invalid) test(`strict schema rejects ${name}`,() => assert.throws(() => compileSchema(input),{ code:'invalid-schema' }));
test('schema compilation bounds total bytes',() => assert.throws(() => compileSchema({ ...raw([field('boolean')]),extra:'x'.repeat(LIMITS.schemaBytes) }),{ code:'schema-limit' }));
test('generation rejects uncompiled inputs and invalid workload bounds',async () => {
  await assert.rejects(collect(raw([field('boolean')]),{}),{ code:'uncompiled-schema' });
  for (const opts of [{ rows:0 },{ rows:null },{ extra:'unknown' },{ rows:1000001 },{ offset:-1 },{ offset:1000000001 },{ format:'xml' },{ seed:'x'.repeat(257) },{ maxBytes:LIMITS.outputBytes + 1 },{ signal:{} }]) await assert.rejects(collect(all(),opts),{ code:'invalid-options' });
});
test('output budget counts UTF-8 bytes, not JavaScript characters',async () => {
  const model = schema([field('choice',{ values:['🌱'] })]);
  const data = await collect(model,{ rows:1 }); const bytes = Buffer.byteLength(data);
  assert.equal(await collect(model,{ rows:1,maxBytes:bytes }),data);
  await assert.rejects(collect(model,{ rows:1,maxBytes:bytes - 1 }),{ code:'output-limit' });
});
test('cancel before start and during generation, with cooperative event-loop scheduling',async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(collect(all(),{ signal:controller.signal }),{ code:'cancelled' });
  const second = new AbortController(); const timer = setImmediate(() => second.abort());
  let count = 0;
  try { for await (const chunk of generate(all(),{ rows:1000000,signal:second.signal })) { assert.ok(chunk.length); count++; } assert.fail('must cancel'); }
  catch (error) { assert.equal(error.code,'cancelled'); } finally { clearImmediate(timer); }
  assert.ok(count <= 256);
});
test('slow sinks apply backpressure and byte budgets do not hide sink errors',async () => {
  let count = 0; let size = 0;
  const sink = new Writable({ highWaterMark:32,write(chunk,encoding,done) { count++; size += chunk.length; setImmediate(done); } });
  await writeToStream(all(),{ rows:500 },sink); sink.end();
  assert.equal(count,500); assert.ok(size > 1000); assert.ok(sink.writableLength === 0);
  const broken = new Writable({ write(chunk,encoding,done) { done(new Error('PRIVATE_INPUT')); } });
  await assert.rejects(writeToStream(all(),{ rows:10 },broken),{ code:'output-failed',message:'output-failed' });
});
test('100,000 rows stream into a hash sink without collecting the dataset',async () => {
  const hash = createHash('sha256'); let count = 0; let maxQueued = 0;
  const sink = new Writable({ highWaterMark:4096,write(chunk,encoding,done) { hash.update(chunk); count++; maxQueued = Math.max(maxQueued,this.writableLength); done(); } });
  await writeToStream(schema([{ name:'id',type:'sequence' },{ name:'sample',type:'integer',min:0,max:1000000 },{ name:'active',type:'boolean' }]),{ rows:100000 },sink);
  sink.end();
  assert.equal(count,100000); assert.ok(maxQueued < 8192); assert.match(hash.digest('hex'),/^[a-f0-9]{64}$/);
});
