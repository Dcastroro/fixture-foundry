# Security policy

Fixture Foundry runs locally without runtime service credentials, external
packages, network requests, shell execution or environment-value interpolation.
It generates fictional fixtures rather than transforming production records.

Schemas are data, never executable expressions. Input/output budgets, strict
schema validation, fixed diagnostic codes, CSV formula neutralization and atomic
no-overwrite file output are tested. JSONL preserves configured choices and prefixes;
users must not place secrets or personal data in those fields. Seeds are public and
deterministic; generated UUIDs and values must never serve as passwords or tokens.

Use a directory you control. Linked output ancestors are rejected, but hostile
concurrent filesystem mutation is outside scope. Input parent links are resolved by
the OS; the schema leaf must be a regular unlinked file. No recursive file discovery
occurs. CSV protection targets common spreadsheet formula prefixes; import untrusted
data with safe spreadsheet settings. This is not a complete spreadsheet sandbox.

The repository guard blocks selected credential patterns and sensitive file types
without printing matches. It is a heuristic, not proof of absence of secrets. CI
uses read-only permissions; release publication uses GitHub's ephemeral job token.

Report a suspected vulnerability through the repository's private GitHub security
reporting feature if available. Otherwise open an issue requesting a private
channel without posting exploit payloads, credentials or personal information.
