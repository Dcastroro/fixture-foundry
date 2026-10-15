# Contributing

Use Node.js 22 or 24. Run `npm ci --ignore-scripts`, `npm run repo:check`,
`npm run check` and `npm run demo`. There are no external runtime or dev packages.

Keep generation deterministic and independent of time, environment, field order
and partition size. A value algorithm change requires a new schema version and
golden-vector regression coverage. Add semantic tests for new fields and boundary
tests for input, output and cancellation. Preserve strict unknown-key rejection.

Never commit production datasets, credentials, local environment files or generated
fixtures. Use fictional examples and fixed diagnostics. Run publication only through
the documented reviewed-tag workflow. Keep changes focused and document behavior.
