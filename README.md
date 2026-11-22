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

Proposals are developed through collaborator pull requests in this repository, and only **Approved** standards are published to the developer docs.

## Feedback & Reporting Issues

We do not accept external pull requests to this repository. Instead, [GitHub Issues](https://github.com/photon-hq/api-design-standards/issues) are open to everyone:

- **Report a non-conformant Photon API**: If you find any Photon API endpoint that does not follow these standards, please [open an issue](https://github.com/photon-hq/api-design-standards/issues/new) with the HTTP method, path, the standard or rule that is violated, and a sanitized or synthetic example request or response payload (with any credentials, tokens, or sensitive customer data removed) when available.
- **Suggest improvements or new standards**: [Open an issue](https://github.com/photon-hq/api-design-standards/issues/new) describing the problem, proposed convention, and motivating examples.

## Using the Redocly Plugin

`@photon-hq/api-design-standards` is published to GitHub Packages alongside [GitHub Releases](https://github.com/photon-hq/api-design-standards/releases). Configure your project's `.npmrc` to resolve the `@photon-hq` scope from GitHub Packages (authentication requires a GitHub token with `read:packages` scope):

```ini
@photon-hq:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Install `@photon-hq/api-design-standards` alongside `@redocly/cli` (v2):

```bash
pnpm add -D @photon-hq/api-design-standards @redocly/cli
```

Register the `photon-ads` plugin and extend `photon-ads/recommended` in your `redocly.yaml`:

```yaml
plugins:
  - "@photon-hq/api-design-standards/redocly"

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

The external developer documentation overview and each standard live under `ads/`:

```text
ads/
  overview.md      # External developer documentation overview
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

We do not accept external pull requests. To propose a new API Design Standard or suggest a change to an existing one, [open a GitHub issue](https://github.com/photon-hq/api-design-standards/issues/new) describing the problem, proposed contract rules, and motivating examples. Proposals are developed through collaborator pull requests in this repository, and only **Approved** standards are published to the developer docs.

### Collaborator Authoring Checklist

When implementing an approved proposal:

1. Create the next sequential folder under `ads/<num>-<slug>/`.
2. Add `index.md` with YAML frontmatter (`title`, `sidebarTitle`, `description`, `ads`, `status`, `updated`), RFC 2119 normative guidance, concrete Good/Bad examples, and a Lint Rules table.
3. Implement deterministic Redocly rules in `rules.ts`, register them in `src/catalog.ts` and `src/plugin.ts`, and cover valid, invalid, and edge cases in `rules.test.ts`.
4. Ensure `pnpm check` passes cleanly, including `docs:export` parity checks and Mintlify MDX safety validation.

## License

Apache-2.0. See [LICENSE](./LICENSE).
