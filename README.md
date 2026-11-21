# Photon API Design Standards

Public HTTP API design standards and deterministic [Redocly](https://redocly.com/docs/cli/) OpenAPI lint rules for Photon APIs.

Each standard in **Photon API Design Standards (ADS)** defines a service-agnostic contract guarantee for external developers, SDK consumers, and automated clients, co-located with its executable lint rules and test suite.

## Standards Index

| Standard | Title | Status | Rules |
| --- | --- | --- | --- |
| [ADS-0001](./ads/0001-resource-identifiers/index.md) | Resource Identifiers and Path Parameter Naming | Approved | `photon-ads/ads-0001-resource-primary-id`, `photon-ads/ads-0001-path-param-naming`, `photon-ads/ads-0001-path-param-consistency` |

### Status Lifecycle

- **Draft**: Problem space identified; conventions are not yet settled.
- **Reviewing**: Core direction is agreed, with open questions under review.
- **Approved**: Binding default for new and redesigned Photon public HTTP APIs.
- **Deprecated**: Superseded by a newer standard.

## Using the Redocly Plugin

Install `@photon-ai/api-design-standards` alongside `@redocly/cli` (v2):

```bash
pnpm add -D @photon-ai/api-design-standards @redocly/cli
```

Register the `photon-ads` plugin and extend `photon-ads/recommended` in your `redocly.yaml`:

```yaml
plugins:
  - "@photon-ai/api-design-standards/redocly"

extends:
  - recommended
  - photon-ads/recommended
```

You can also override individual rule severities under `rules:`:

```yaml
rules:
  photon-ads/ads-0001-resource-primary-id: error
  photon-ads/ads-0001-path-param-naming: error
  photon-ads/ads-0001-path-param-consistency: error
```

Run Redocly against your OpenAPI 3 specification:

```bash
npx redocly lint openapi.yaml --config redocly.yaml
```

## Repository Layout

Each standard lives in its own co-located folder under `ads/`:

```text
ads/
  0001-resource-identifiers/
    index.md       # Authoritative Markdown specification and rule table
    rules.ts       # Deterministic Redocly OpenAPI 3 rules
    rules.test.ts  # Unit and end-to-end Redocly CLI tests
```

## Running Checks Locally

Requires Node.js 22+ (CI runs Node 24) and pnpm:

```bash
pnpm install
pnpm check
```

Individual commands:

- `pnpm typecheck` — strict TypeScript check across source, rules, scripts, and tests.
- `pnpm lint` — Biome formatting and linting check.
- `pnpm build` — compiles the TypeScript plugin package into `dist/`.
- `pnpm test` — runs unit tests and end-to-end `redocly lint` verification.
- `pnpm redocly:check` — lints the reference OpenAPI 3.1 fixture with `redocly.yaml`.
- `pnpm docs:export` — builds and validates `artifacts/docs-reference.json` for documentation publishing.
- `pnpm check:public` — verifies tracked files contain only public-safe content.

## Proposing a New Standard

1. Open an issue or pull request proposing the next sequential ADS number under `ads/<num>-<slug>/`.
2. Add `index.md` with YAML frontmatter (`title`, `sidebarTitle`, `description`, `ads`, `status`, `updated`), RFC 2119 normative guidance, concrete Good/Bad examples, and a Lint Rules table.
3. Implement deterministic Redocly rules in `rules.ts`, register them in `src/catalog.ts` and `src/plugin.ts`, and cover valid, invalid, and edge cases in `rules.test.ts`.
4. Ensure `pnpm check` passes cleanly, including `docs:export` parity checks and Mintlify MDX safety validation.

## License

Apache-2.0. See [LICENSE](./LICENSE).
