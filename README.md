# Fixture Foundry

[![CI](https://github.com/Dcastroro/fixture-foundry/actions/workflows/ci.yml/badge.svg)](https://github.com/Dcastroro/fixture-foundry/actions/workflows/ci.yml)
[![Release](https://github.com/Dcastroro/fixture-foundry/actions/workflows/release.yml/badge.svg)](https://github.com/Dcastroro/fixture-foundry/releases)

**Reproducible synthetic test data, streamed locally into JSONL or CSV.**

Create fixtures for integration tests, demos and load-test input without copying
production records. Stable row offsets let independent CI jobs generate partitions
of the same dataset. No services, runtime credentials or npm dependencies.

## Quick start

Requires Node.js 22 or 24 and Git. Releases contain source; this is not published
to npm. Clone the project or download and verify a [source release](https://github.com/Dcastroro/fixture-foundry/releases).

```sh
git clone https://github.com/Dcastroro/fixture-foundry.git
cd fixture-foundry
npm ci --ignore-scripts
node bin/fixture-foundry.mjs validate --schema examples/users.schema.json
node bin/fixture-foundry.mjs generate --schema examples/users.schema.json --rows 100 --seed public-demo --out users.jsonl
node bin/fixture-foundry.mjs generate --schema examples/orders.schema.json --rows 1000 --seed public-demo --out orders.jsonl
npm run demo
```

The orders example references the 100 generated `usr_1` … `usr_100` users. The demo
checks those references and proves that two partitions equal one complete run.
Examples use fictional data and the reserved `example.test` email domain.

## Schema

```json
{
  "version": 1,
  "namespace": "demo",
  "fields": [
    { "name": "id", "type": "sequence", "prefix": "item_" },
    { "name": "owner", "type": "reference", "count": 100, "prefix": "usr_" },
    { "name": "score", "type": "integer", "min": 0, "max": 100 },
    { "name": "status", "type": "choice", "values": ["new", "ready"] },
    { "name": "enabled", "type": "boolean" },
    { "name": "email", "type": "email" },
    { "name": "trace", "type": "uuid" },
    { "name": "created", "type": "timestamp", "from": "2026-01-01T00:00:00.000Z", "to": "2026-01-02T00:00:00.000Z" }
  ]
}
```

| Type | Behavior |
| --- | --- |
| `sequence` | `start + rowIndex × step`; defaults 1/1; optional string prefix. Without prefix, emits a number. |
| `reference` | Picks an integer from `start` through `start + count - 1`; defaults start 1; optional prefix. Targets a step-1 parent sequence. |
| `integer` | Inclusive safe integer bounds `min`/`max` within ±1 billion. |
| `choice` | One of 1–256 string, integer, boolean or null values. Duplicate entries act as weights. |
| `boolean` | Reproducible true/false value. |
| `email` | Synthetic address at `example.test`, containing row index and a deterministic suffix. |
| `uuid` | Deterministic UUID-shaped test identifier with v4 layout bits. Never an authentication token. |
| `timestamp` | Inclusive millisecond range between canonical UTC ISO strings; maximum span 1 trillion ms. |

Namespaces and field names are ASCII identifiers, at most 64 characters. Schema
version must be 1. Unknown keys, duplicate names, nested values, expressions,
network sources and environment interpolation are rejected. Strings have at most
256 UTF-16 code units; controls and unpaired surrogates are rejected.

## Partition and export

```sh
node bin/fixture-foundry.mjs generate --schema examples/users.schema.json --rows 500 --seed public-demo --out part-1.jsonl
node bin/fixture-foundry.mjs generate --schema examples/users.schema.json --rows 500 --offset 500 --seed public-demo --out part-2.jsonl
node bin/fixture-foundry.mjs generate --schema examples/users.schema.json --rows 100 --format csv --out users.csv
```

Concatenating the JSONL partitions in offset order gives exactly the same bytes
as a 1,000-row run. For CSV, keep the header on the first partition and use
`--no-header` on subsequent partitions. JSONL uses LF; CSV uses CRLF and standard
quote escaping. Strings whose first non-whitespace character is `=`, `+`, `-` or
`@` receive an apostrophe prefix to reduce spreadsheet formula interpretation.
This intentionally changes those CSV strings; JSONL preserves them exactly.
Numeric negatives remain numeric. CSV represents null as an empty cell and does
not preserve JSON types.

The generator derives samples from SHA-256 over algorithm version, seed,
namespace, absolute row index and field name, with rejection sampling for integer
ranges. Existing fields retain their values when other fields are added or
reordered. Sequences depend only on row index; other fields also depend on seed
and namespace. The default seed is the public string `fixture-foundry-demo`.
Treat seeds as public configuration. Reproducibility applies to the same algorithm
and schema version; changes to the algorithm require a new schema version.

## Limits and output guarantees

- Schema: 1 MiB, 1–64 fields. Rows: 1–1,000,000 per run; offset: 0–1 billion.
- Output: 512 MiB per run; lower with `--max-bytes`. One row is buffered at a time
  plus bounded stream queues; asynchronous iteration respects sink backpressure.
- Generation yields to cancellation every 256 rows, and checks cancellation on
  every row. No dataset-wide deduplication set, production data read or network I/O.
- `--out` requires an existing parent directory without symlink/junction ancestors.
  It writes a private temporary file and atomically creates the target with a hard
  link, refusing any existing target. Failure/cancellation cleans up the temporary
  file. The filesystem must support hard links; this is atomic visibility, not a
  power-loss durability guarantee. POSIX permissions are 0600; Windows uses its ACLs.
- Use directories you control. Concurrent hostile directory replacement is outside
  the threat model. A forced process kill can leave a `.fixture-foundry-*.tmp` file.
- Stdout is streaming and can contain partial rows already emitted before a later
  error. Check the exit code; use `--out` when you need complete-file publication.

Exit 0: success; 2: invalid input, budget or I/O failure; 130: handled interruption.
Diagnostics are fixed codes on stderr without paths, input values or native error
messages. Validation reports only field count. Generated data itself is intentionally
printed or written: **do not put real secrets or personal records in schema choices,
prefixes or seeds**. The tool does not discover or redact secrets supplied as fixtures.

## JavaScript API

```js
import { loadSchema, generate, writeToFile } from './src/index.mjs';
const schema = loadSchema('examples/users.schema.json');
for await (const chunk of generate(schema, { rows: 100, offset: 0, seed: 'demo' })) {
  // Each Buffer contains one encoded record; consume without collecting everything.
}
await writeToFile(schema, { rows: 100, signal: AbortSignal.timeout(10000) }, 'new-users.jsonl');
```

Also exports `compileSchema(plainJson)`, `writeToStream(schema, options, writable)`,
`FixtureError` and `LIMITS`. Writers take ownership of the stream on failure;
`writeToStream` leaves it open on success. Compile once and reuse the immutable
schema. Supported options match the CLI, plus an AbortSignal and `header` boolean.

## Development and automation

```sh
npm run repo:check
npm run check
npm run demo
```

Tests exercise field semantics, stable partitions, CSV safety, bounded streaming,
100,000-row generation, concurrent publication, cancellation and the CLI. CI checks
Windows/Ubuntu on Node 22/24. Pinned actions, read-only verification jobs, repository
guards and verified source releases keep publication repeatable.

`npm run benchmark` streams one million rows into a hash sink and reports bytes,
elapsed time and sampled peak JavaScript heap. It neither writes the dataset nor
prints records. Measurements depend on machine and runtime; it is a reproducible
workload rather than a performance guarantee.

See [CI integration](docs/ci.md), [security boundaries](SECURITY.md),
[contributing](CONTRIBUTING.md) and [release policy](RELEASING.md). MIT licensed.
