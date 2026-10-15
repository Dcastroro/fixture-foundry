import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream, lstatSync, openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { link, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const LIMITS = Object.freeze({ schemaBytes: 1048576, fields: 64, choices: 256, rows: 1000000, offset: 1000000000, outputBytes: 536870912 });
export class FixtureError extends Error {
  constructor(code) { super(code); this.name = 'FixtureError'; this.code = code; }
}
const fail = code => { throw new FixtureError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = value => typeof value === 'string' && value.length <= 256 && !/[\x00-\x1f\x7f\ud800-\udfff]/u.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
function keys(value, allowed, required = [], code = 'invalid-schema') {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code);
}
const compiled = new WeakSet();

/** Accept plain JSON only; unknown fields and executable extensions are rejected. */
export function compileSchema(input) {
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > LIMITS.schemaBytes) fail('schema-limit');
    keys(input, ['version','namespace','fields'], ['version','namespace','fields']);
    if (input.version !== 1 || !identifier(input.namespace) || !Array.isArray(input.fields) || input.fields.length < 1 || input.fields.length > LIMITS.fields) fail('invalid-schema');
    const names = new Set();
    const fields = input.fields.map(field => {
      if (!object(field) || !identifier(field.name) || names.has(field.name)) fail('invalid-schema');
      names.add(field.name);
      const common = ['name','type'];
      switch (field.type) {
        case 'sequence':
          keys(field, [...common,'start','step','prefix'], common);
          if (!integer(field.start === undefined ? 1 : field.start, -1000000000, 1000000000) || !integer(field.step === undefined ? 1 : field.step, 1, 1000000) || (Object.hasOwn(field,'prefix') && !text(field.prefix))) fail('invalid-schema');
          return Object.freeze({ name: field.name, type: field.type, start: field.start ?? 1, step: field.step ?? 1, ...(Object.hasOwn(field,'prefix') ? { prefix: field.prefix } : {}) });
        case 'integer':
          keys(field, [...common,'min','max'], [...common,'min','max']);
          if (!integer(field.min, -1000000000, 1000000000) || !integer(field.max, field.min, 1000000000)) fail('invalid-schema');
          break;
        case 'choice':
          keys(field, [...common,'values'], [...common,'values']);
          if (!Array.isArray(field.values) || field.values.length < 1 || field.values.length > LIMITS.choices || field.values.some(value => !(text(value) || typeof value === 'boolean' || value === null || integer(value,-1000000000,1000000000)))) fail('invalid-schema');
          return Object.freeze({ ...field, values: Object.freeze([...field.values]) });
        case 'reference':
          keys(field, [...common,'count','start','prefix'], [...common,'count']);
          if (!integer(field.count,1,LIMITS.offset) || !integer(field.start === undefined ? 1 : field.start,-1000000000,1000000000) || (Object.hasOwn(field,'prefix') && !text(field.prefix))) fail('invalid-schema');
          return Object.freeze({ name: field.name, type: field.type, count: field.count, start: field.start ?? 1, ...(Object.hasOwn(field,'prefix') ? { prefix: field.prefix } : {}) });
        case 'timestamp': {
          keys(field, [...common,'from','to'], [...common,'from','to']);
          const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
          if (!iso(field.from) || !iso(field.to) || Date.parse(field.from) > Date.parse(field.to) || Date.parse(field.to) - Date.parse(field.from) > 1000000000000) fail('invalid-schema');
          break;
        }
        case 'boolean': case 'uuid': case 'email':
          keys(field, common, common);
          break;
        default: fail('invalid-schema');
      }
      return Object.freeze({ ...field });
    });
    const schema = Object.freeze({ version: 1, namespace: input.namespace, fields: Object.freeze(fields) });
    compiled.add(schema);
    return schema;
  } catch (error) {
    if (error instanceof FixtureError) throw error;
    fail('invalid-schema');
  }
}

/** Bounded regular-file read. No input contents, paths or parser errors escape. */
export function loadSchema(path) {
  let fd;
  try {
    if (lstatSync(path).isSymbolicLink()) fail('schema-file');
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > LIMITS.schemaBytes) fail('schema-file');
    const bytes = Buffer.alloc(LIMITS.schemaBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > LIMITS.schemaBytes) fail('schema-limit');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0,size));
    return compileSchema(JSON.parse(json));
  } catch (error) {
    if (error instanceof FixtureError) throw error;
    fail('schema-file');
  } finally { if (fd !== undefined) closeSync(fd); }
}

function options(input = {}) {
  keys(input, ['rows','offset','seed','format','header','maxBytes','signal'], [], 'invalid-options');
  const result = { rows: 10, offset: 0, seed: 'fixture-foundry-demo', format: 'jsonl', header: true, maxBytes: LIMITS.outputBytes, ...input };
  if (!integer(result.rows,1,LIMITS.rows) || !integer(result.offset,0,LIMITS.offset) || !text(result.seed) || !['jsonl','csv'].includes(result.format) || typeof result.header !== 'boolean' || !integer(result.maxBytes,1,LIMITS.outputBytes) || (result.signal !== undefined && !(result.signal instanceof AbortSignal))) fail('invalid-options');
  return result;
}

// Domain separation keeps rows stable across shards and field additions/reordering.
function digest(schema, seed, row, field, counter = 0) {
  return createHash('sha256').update(JSON.stringify([1,seed,schema.namespace,row,field.name,counter])).digest();
}
function sample(schema, seed, row, field, count) {
  const space = 281474976710656; // 2^48, exactly represented; reject modulo bias.
  const ceiling = space - space % count;
  for (let counter = 0; counter < 128; counter += 1) {
    const value = digest(schema,seed,row,field,counter).readUIntBE(0,6);
    if (value < ceiling) return value % count;
  }
  fail('generation-failed');
}
function record(schema, opts, index) {
  const row = Object.create(null);
  for (const field of schema.fields) {
    let value;
    switch (field.type) {
      case 'sequence': value = field.start + index * field.step; break;
      case 'reference': value = field.start + sample(schema,opts.seed,index,field,field.count); break;
      case 'integer': value = field.min + sample(schema,opts.seed,index,field,field.max - field.min + 1); break;
      case 'choice': value = field.values[sample(schema,opts.seed,index,field,field.values.length)]; break;
      case 'boolean': value = sample(schema,opts.seed,index,field,2) === 1; break;
      case 'timestamp': value = new Date(Date.parse(field.from) + sample(schema,opts.seed,index,field,Date.parse(field.to) - Date.parse(field.from) + 1)).toISOString(); break;
      case 'email': value = `user-${index + 1}-${digest(schema,opts.seed,index,field).toString('hex').slice(0,12)}@example.test`; break;
      case 'uuid': {
        const bytes = digest(schema,opts.seed,index,field).subarray(0,16);
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = bytes.toString('hex');
        value = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
        break;
      }
    }
    row[field.name] = Object.hasOwn(field,'prefix') ? field.prefix + value : value;
  }
  return row;
}
function csv(value) {
  let cell = value === null ? '' : String(value);
  // Apply only to strings: numeric negatives remain numeric cells.
  if (typeof value === 'string' && /^\s*[=+\-@]/.test(cell)) cell = "'" + cell;
  return /[",\r\n]/.test(cell) ? '"' + cell.replaceAll('"','""') + '"' : cell;
}

/** Async iteration bounds queued memory and cooperatively yields every 256 rows. */
export async function* generate(schema, input = {}) {
  if (!compiled.has(schema)) fail('uncompiled-schema');
  const opts = options(input);
  let bytes = 0;
  const emit = line => {
    const data = Buffer.from(line);
    bytes += data.length;
    if (bytes > opts.maxBytes) fail('output-limit');
    return data;
  };
  if (opts.signal?.aborted) fail('cancelled');
  if (opts.format === 'csv' && opts.header) yield emit(schema.fields.map(field => csv(field.name)).join(',') + '\r\n');
  for (let n = 0; n < opts.rows; n += 1) {
    if (opts.signal?.aborted) fail('cancelled');
    const row = record(schema,opts,opts.offset + n);
    yield emit(opts.format === 'jsonl' ? JSON.stringify(row) + '\n' : schema.fields.map(field => csv(row[field.name])).join(',') + '\r\n');
    if ((n + 1) % 256 === 0) await new Promise(resolve => setImmediate(resolve));
  }
}

export async function writeToStream(schema, opts, destination) {
  try {
    await pipeline(Readable.from(generate(schema,opts)), destination, { end: false, signal: opts?.signal });
  } catch (error) {
    if (error instanceof FixtureError) throw error;
    fail(opts?.signal?.aborted ? 'cancelled' : 'output-failed');
  }
}

function parentIdentity(parent) {
  const absolute = resolve(parent);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current,part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe-output');
  }
  const stat = lstatSync(absolute);
  return `${realpathSync(absolute)}:${stat.dev}:${stat.ino}`;
}

/** Publish with a same-directory hard link: atomic visibility and no overwrite. */
export async function writeToFile(schema, opts, path) {
  let temp;
  let writer;
  try {
    if (typeof path !== 'string' || !path) fail('unsafe-output');
    const target = resolve(path);
    const parent = dirname(target);
    const identity = parentIdentity(parent);
    try { lstatSync(target); fail('output-exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    temp = join(parent,`.fixture-foundry-${randomUUID()}.tmp`);
    writer = createWriteStream(temp,{ flags: 'wx', mode: 0o600 });
    await pipeline(Readable.from(generate(schema,opts)),writer,{ signal: opts?.signal });
    if (opts?.signal?.aborted) fail('cancelled');
    if (parentIdentity(parent) !== identity) fail('unsafe-output');
    await link(temp,target);
  } catch (error) {
    if (error instanceof FixtureError) throw error;
    fail(opts?.signal?.aborted ? 'cancelled' : error.code === 'EEXIST' ? 'output-exists' : 'output-failed');
  } finally {
    writer?.destroy();
    if (temp) await unlink(temp).catch(() => {});
  }
}
