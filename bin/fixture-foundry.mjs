#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { loadSchema, writeToFile, writeToStream, FixtureError } from '../src/index.mjs';

const HELP = `Fixture Foundry — deterministic local synthetic test data
Usage:
  fixture-foundry validate --schema FILE
  fixture-foundry generate --schema FILE [--rows N] [--offset N] [--seed TEXT]
    [--format jsonl|csv] [--no-header] [--max-bytes N] [--out NEW_FILE]
  fixture-foundry --version

Output defaults to stdout. Diagnostics are fixed codes on stderr.
File output refuses existing files and requires an existing, unlinked parent.
Seeds and schemas are public fixture configuration, never credentials.
`;
const controller = new AbortController();
const cancel = () => controller.abort();
process.on('SIGINT',cancel);
process.on('SIGTERM',cancel);
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help','--version'].includes(args[0])) {
    process.stdout.write(args[0] === '--help' ? HELP : JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version + '\n');
  } else {
    const command = args.shift();
    if (!['validate','generate'].includes(command)) throw new FixtureError('usage');
    const values = new Map();
    while (args.length) {
      const key = args.shift();
      const allowed = command === 'validate' ? ['--schema'] : ['--schema','--rows','--offset','--seed','--format','--no-header','--max-bytes','--out'];
      if (!allowed.includes(key) || values.has(key)) throw new FixtureError('usage');
      if (key === '--no-header') { values.set(key,true); continue; }
      const value = args.shift();
      if (value === undefined || value.startsWith('--')) throw new FixtureError('usage');
      values.set(key,value);
    }
    if (!values.has('--schema')) throw new FixtureError('usage');
    const schema = loadSchema(values.get('--schema'));
    if (command === 'validate') process.stdout.write(JSON.stringify({ ok: true, version: 1, fields: schema.fields.length }) + '\n');
    else {
      const opts = { signal: controller.signal };
      for (const [flag,key] of [['--rows','rows'],['--offset','offset'],['--max-bytes','maxBytes']]) {
        if (values.has(flag)) {
          if (!/^(0|[1-9]\d{0,11})$/.test(values.get(flag))) throw new FixtureError('usage');
          opts[key] = Number(values.get(flag));
        }
      }
      if (values.has('--seed')) opts.seed = values.get('--seed');
      if (values.has('--format')) opts.format = values.get('--format');
      if (values.has('--no-header')) {
        if (opts.format !== 'csv') throw new FixtureError('usage');
        opts.header = false;
      }
      if (values.has('--out')) await writeToFile(schema,opts,values.get('--out'));
      else await writeToStream(schema,opts,process.stdout);
    }
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: error instanceof FixtureError ? error.code : 'operation-failed' } }) + '\n');
  process.exitCode = controller.signal.aborted ? 130 : 2;
} finally {
  process.removeListener('SIGINT',cancel);
  process.removeListener('SIGTERM',cancel);
}
