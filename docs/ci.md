# Reproducible fixtures in CI

Generate fictional inputs before starting integration tests. Commit schemas rather
than generated datasets. Use the same public seed and schema revision across jobs.
Keep stdout generation out of CI logs unless the fixture values are intended public.

```sh
node bin/fixture-foundry.mjs validate --schema examples/users.schema.json
node bin/fixture-foundry.mjs generate --schema examples/users.schema.json --rows 100 --seed ci-demo --out users.jsonl
node bin/fixture-foundry.mjs generate --schema examples/orders.schema.json --rows 1000 --seed ci-demo --out orders.jsonl
```

The order schema's count of 100 matches the user's step-1 sequence starting at 1.
References are generated mathematically without loading parent data. They do not
read or validate an external database: keep counts, prefixes and starts aligned.
For distributed generation, partition parent IDs into disjoint offset ranges but
set child `count` to the total parent population and `start` to its first ID.

In a fresh checkout, each CI job can generate its own rows with an offset:

```sh
node bin/fixture-foundry.mjs generate --schema examples/orders.schema.json --rows 10000 --offset 20000 --seed ci-demo --max-bytes 16777216 --out shard-2.jsonl
```

This shard equals rows 20,000–29,999 of the full dataset. Shards have independent
byte caps. Assemble in offset order if a single file is needed. Defaults do not use
the current date, machine state or a random seed. The reference population remains
the 100 configured users even when the number of generated orders changes.

Use [Task Relay](https://github.com/Dcastroro/task-relay) to place fixture generation
before tests in a task graph, with its existing timeout and output controls.
[Probe Harbor](https://github.com/Dcastroro/probe-harbor) can wait for the test service
before an integration runner consumes the fixtures. Fixture Foundry does not send
data to that service or execute test commands. Each tool retains one clear job.

An existing output is always rejected. Use a fresh job workspace or a new filename;
do not work around this by overwriting a shared fixture. For datasets larger than
the per-run limits, generate independent bounded shards. Runtime is linear in
rows × fields; memory stays bounded by schema, row and stream buffers. The test
suite streams 100,000 rows to a hash sink and exercises a slow sink separately.

## Diagnostics

| Code | Meaning |
| --- | --- |
| `usage`, `invalid-options` | Unsupported or out-of-range CLI/API options. |
| `invalid-schema`, `schema-limit`, `schema-file` | Schema validation, bounded read or regular-file failure. |
| `output-limit` | Encoded bytes exceeded the configured cap. |
| `output-exists`, `unsafe-output`, `output-failed` | Refused destination or filesystem/stream failure. |
| `cancelled` | AbortSignal or handled process interruption. |
| `uncompiled-schema`, `generation-failed` | API misuse or generation failure. |

Check both exit status and stderr. Errors never include raw schema values, paths,
seed strings or native exception details. Configured values in generated records
are intentional output and are not redacted.
