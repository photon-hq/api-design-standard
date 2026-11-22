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

## Reporting Non-Conformant Photon APIs

If you find any Photon API endpoint that does not follow these standards, please open an issue in [photon-hq/api-design-standards](https://github.com/photon-hq/api-design-standards/issues/new). Include the HTTP method, path, the standard or rule that is violated, and an example request or response payload when available.

Pull requests are restricted to repository collaborators, while [GitHub Issues](https://github.com/photon-hq/api-design-standards/issues) are open to everyone for violation reports, questions, and standard proposals.

## Using the Redocly Plugin

Releases are currently distributed through [GitHub Releases](https://github.com/photon-hq/api-design-standards/releases); the `@photon-ai/api-design-standards` package is not yet published to npm.

Clone [photon-hq/api-design-standards](https://github.com/photon-hq/api-design-standards) (or check out a release tag) and build the plugin locally:

```bash
git clone https://github.com/photon-hq/api-design-standards.git
cd api-design-standards
pnpm install
pnpm build
```

Install `@redocly/cli` (v2) in your project if you do not already have it:

```bash
pnpm add -D @redocly/cli@2
```

Register the compiled `photon-ads` plugin entrypoint (adjusting the path to your local clone) and extend `photon-ads/recommended` in your `redocly.yaml`:

```yaml
plugins:
  - ../api-design-standards/dist/src/redocly-plugin.js

extends:
  - recommended
  - photon-ads/recommended
```

If you link or install the built checkout locally as `@photon-ai/api-design-standards`, you can reference `"@photon-ai/api-design-standards/redocly"` under `plugins:` instead.

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

Requires Node.js 22.12+ (CI runs Node 24) and pnpm:

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

To propose a new API Design Standard or suggest a change to an existing one, [open a GitHub issue](https://github.com/photon-hq/api-design-standards/issues/new) describing the problem, proposed contract rules, and motivating examples. Pull requests are restricted to repository collaborators.

### Collaborator Authoring Checklist

When implementing an approved proposal:

1. Create the next sequential folder under `ads/<num>-<slug>/`.
2. Add `index.md` with YAML frontmatter (`title`, `sidebarTitle`, `description`, `ads`, `status`, `updated`), RFC 2119 normative guidance, concrete Good/Bad examples, and a Lint Rules table.
3. Implement deterministic Redocly rules in `rules.ts`, register them in `src/catalog.ts` and `src/plugin.ts`, and cover valid, invalid, and edge cases in `rules.test.ts`.
4. Ensure `pnpm check` passes cleanly, including `docs:export` parity checks and Mintlify MDX safety validation.

## License

Apache-2.0. See [LICENSE](./LICENSE).
