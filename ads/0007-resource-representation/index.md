---
title: "ADS-0007: Resource Representation Consistency"
sidebarTitle: "ADS-0007 · Resource Representation"
description: "Single canonical resource schemas, per-service Operation resources, cross-method response consistency, strict collection slices, mutation input symmetry, and the x-photon-resource OpenAPI extension across Photon public HTTP APIs."
ads: "0007"
status: "Draft"
updated: "2026-11-28"
---

# ADS-0007: Resource Representation Consistency

- **Status**: Draft
- **Updated**: 2026-11-28

When a resource uses one canonical schema across reads, lists, and mutations, callers, generated SDKs, CLIs, dashboards, and automated agents can cache, diff, and update state without endpoint-specific field mappers or per-method type conversions. This standard is part of Photon API Design Standards and uses the keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** as described in RFC 2119.

## Scope

This standard governs schema consistency across every representation of a resource within Photon public HTTP APIs:

- Single canonical resource schemas anchored to single-resource `GET 200` responses.
- Per-service canonical `Operation` resource modeling for long-running operations.
- Cross-method response consistency across `GET`, `POST`, `PATCH`, and `PUT`.
- Strict subset guarantees for collection `GET` item slices.
- Field-name, type, and writability symmetry for `POST`, `PATCH`, and `PUT` request bodies.
- Declarative schema roles through the `x-photon-resource` OpenAPI extension.

Related concerns are governed by separate standards:

- Resource identifier fields (`id`, `<resource>Id`) and URL path parameter naming (`{<resource>Id}`) are defined in `ADS-0001`.
- Flat top-level JSON response objects and flat one-time creation secrets are defined in `ADS-0002`.
- Long-running operation lifecycle, polling, and `Operation` envelope fields are defined in `ADS-0004`.
- Standard HTTP methods, read symmetry, canonical status codes, URL naming, and RFC 7396 JSON Merge Patch wire rules are defined in `ADS-0005`.
- Forward cursor pagination (`items`, `pageSize`, `pageToken`, `nextPageToken`) is defined in `ADS-0006`.

## Normative Rules

### 1. Canonical Resource Model

Every addressable resource and singleton **MUST** have a single authoritative **canonical resource schema** (`C`), defined by its single-resource `GET 200` representation.

- Whether a resource is retrieved at a direct child path (for example `GET /v1/projects/{projectId}/api-keys/{apiKeyId}`) or at a hoisted canonical path (for example `GET /v1/projects/{projectId}` paired with `GET /v1/organizations/{organizationId}/projects`), that single-resource `GET 200` schema is the source of truth for the resource's field names, types, nullability, and nested structures.
- Single-resource fields **MUST** appear flat at the root JSON object per `ADS-0002`.
- Server-managed attributes (such as `id`, `createdAt`, `updatedAt`, and computed status or audit fields) **SHOULD** be annotated with `readOnly: true` on `C` so documentation, SDK generators, and automated validators can distinguish output-only fields from writable attributes.
- Every other representation of that resource — collection list items, mutation responses, and mutation request bodies — **MUST** derive from `C` rather than inventing parallel field names or incompatible types.

### 2. Per-Service `Operation` Canonical Resource

Long-running operations (defined in `ADS-0004`) **MUST** be modeled as a canonical resource scoped to the owning service or domain (for example `projects.operation` or `billing.operation`), not as a single shared cross-service union across all domains.

- Each service's `Operation` canonical schema **MUST** satisfy the universal `ADS-0004` contract (`id`, `type`, `status`, `createdAt`, `updatedAt`, `completedAt`, `response`, and `error`, plus optional `cancellable`, `nextAction`, and `metadata` with all `ADS-0004` status-specific invariants), while specializing `type`, `response`, `nextAction`, and `metadata` strictly to the operation types that service owns.
- Scoping the canonical `Operation` resource per service keeps generated SDK unions small, prevents unrelated services from coupling their release cycles, and gives each service's `GET .../operations/{operationId}` endpoint a clean canonical schema `C`.
- Asynchronous mutations returning `202 Accepted` return the owning service's canonical `Operation` resource rather than the target domain resource.

### 3. Cross-Method Response Consistency

Every synchronous `2xx` JSON response returning a single resource — `GET 200`, `PATCH 200`, `PUT 200`/`201`, and synchronous collection `POST 200`/`201` — **MUST** be structurally consistent with the resource's canonical `GET 200` representation `C`:

- Every field returned in the response **MUST** exist on `C` with the same name and a compatible (equal or narrower) JSON type, checked recursively through nested objects and arrays.
- Responses **MUST NOT** omit required properties declared on `C`, rename canonical fields, or attach ad-hoc fields absent from `C`.
- The following narrow exceptions apply:
  - **One-time creation secrets (`ADS-0002` §3)**: A synchronous creation response (`POST 200`/`201` or `PUT 201`) **MAY** return a one-time sensitive credential (such as `secret`, `signingSecret`, `clientSecret`, `token`, or `accessToken`) as a flat sibling top-level field alongside all canonical fields of `C`. Subsequent `GET`, `PATCH`, and `DELETE` responses omit the one-time secret while keeping every canonical field identical. Creation responses **MUST NOT** wrap the resource and secret in a split two-key envelope (`{ "apiKey": { ... }, "secret": "..." }`), per `ADS-0002` §3.
  - **Asynchronous operations (`ADS-0004`)**: `202 Accepted` responses (and synchronous idempotent replays that return an `ADS-0004` `Operation` resource) return the owning service's `Operation` schema rather than `C`.
  - **Bodyless responses**: `204 No Content` responses (such as `DELETE 204`) return no body.
- Custom action endpoints (`POST .../{resourceId}/<action>`) and query/utility endpoints (such as `/search`, `/query`, `/preview`, `/validate`, `/batch`, `/count`, or `/status`) are governed by their own action or query contracts and are not required to return `C` unless the action updates and returns the resource itself.

### 4. Collection Slices

Collection `GET 200` endpoints **MAY** return either the full canonical schema `C` for each item in the collection array or a **slice** (strict projection) of `C` that omits expensive, bulky, or nested fields.

- Every property declared on a collection list item **MUST** exist on `C` with the exact same name and a compatible (equal or narrower) type, checked recursively through nested objects and arrays.
- Collection items **MUST NOT** introduce list-only fields absent from `C`, rename canonical fields, or widen a field's type relative to `C`.
- If a computed summary or metadata attribute is useful on collection responses, expose it on `C` as well so single-resource `GET` remains a strict superset of collection list items.
- For hoisted canonical resources (where `GET /v1/organizations/{organizationId}/projects` lists items whose canonical single-resource read lives at `GET /v1/projects/{projectId}`), the list items **MUST** remain a strict slice of the hoisted canonical `GET 200` schema.

### 5. Mutation Input Symmetry

Request bodies for `PATCH`, `PUT`, and collection `POST` **MUST** stay symmetric with canonical `C`:

- **Type and name symmetry**: Every request body property whose name matches a property on `C` **MUST** use a compatible (equal or narrower) type, checked recursively through nested objects and arrays. Fields **MUST NOT** silently change type between write and read (for example accepting an integer on `PATCH` while returning a string on `GET`).
- **No server-managed or `readOnly` inputs**:
  - `PATCH` and `PUT` request bodies **MUST NOT** accept `id`, `createdAt`, `updatedAt`, or any canonical property marked `readOnly: true`.
  - Collection `POST` request bodies **MUST NOT** accept `createdAt`, `updatedAt`, or any canonical property marked `readOnly: true`. Client-supplied `id` on creation is permitted only when `id` is writable (not marked `readOnly: true`) on `C`.
- **Merge Patch compliance on `PATCH`**: Every `PATCH` request body **MUST** additionally satisfy RFC 7396 JSON Merge Patch rules in `ADS-0005` §6 (no required top-level fields outside an explicit union discriminator, and `additionalProperties: false` or `unevaluatedProperties: false`).
- **Non-resource creation inputs**: Collection `POST` request bodies **MAY** accept creation-only input fields that are consumed during resource creation and not stored directly on `C` (for example `templateId`, `initialPlanId`, or `sendInviteEmail`). When the schema carries `x-photon-resource`, declare those inputs explicitly in `nonResourceInputs` (see §6).

### 6. The `x-photon-resource` OpenAPI Extension

Schemas **MAY** declare the `x-photon-resource` OpenAPI vendor extension to make canonical ownership and derived schema roles machine-readable for SDK generation, documentation, and strict static checks.

#### Canonical form

Attach the canonical form to the authoritative component schema `C`:

```yaml
x-photon-resource:
  type: "<domain>.<entity>"
```

- `type` **MUST** match `^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$` — lowercase `kebab-case` domain and entity separated by a single dot (for example `projects.project`, `projects.api-key`, `billing.operation`).
- Every canonical `type` **MUST** be globally unique within an OpenAPI document.
- The canonical object **MUST NOT** include derived keys (`role`, `canonical`, or `nonResourceInputs`).

#### Derived form

Attach the derived form to any slice or mutation schema derived from `C`:

```yaml
x-photon-resource:
  role: "slice" | "create" | "patch" | "replace"
  canonical: "#/components/schemas/<CanonicalSchemaName>"
  nonResourceInputs: # optional; allowed ONLY when role is "create"
    - "templateId"
```

- `role` **MUST** be one of `"slice"`, `"create"`, `"patch"`, or `"replace"`.
- `canonical` **MUST** be a local JSON Pointer (`#/components/schemas/<Name>`) referring to an existing schema under `components.schemas` that declares canonical `x-photon-resource: { type }`. Dangling pointers, self-references, and derived-to-derived chains are forbidden.
- `nonResourceInputs` is allowed **ONLY** when `role` is `"create"`. When present, it **MUST** be a non-empty array of unique property names, each of which **MUST** exist on the derived schema and **MUST NOT** exist on the canonical schema `C`.

#### Derived role contract

Each derived `role` enforces a strict contract against its canonical schema `C`:

| Role | Allowed properties | `readOnly` / server-managed fields | Additional constraints |
| --- | --- | --- | --- |
| `slice` | Strict subset of `C` with compatible types (recursively) | Allowed (`id`, `createdAt`, etc.) | Used for list summaries and reduced projections |
| `create` | Subset of `C` with compatible types, plus properties listed in `nonResourceInputs` | Forbidden (`readOnly: true`, `createdAt`, `updatedAt`) | Unlisted extra properties are rejected |
| `patch` | Strict subset of `C` with compatible types (recursively) | Forbidden (`readOnly: true`, `id`, `createdAt`, `updatedAt`) | No top-level `required` (except an explicit union discriminator); `additionalProperties: false` (or `unevaluatedProperties: false`) required per `ADS-0005` §6 |
| `replace` | Strict subset of `C` with compatible types (recursively) | Forbidden (`readOnly: true`, `id`, `createdAt`, `updatedAt`) | Full-replacement `PUT` input |

## Examples

### Canonical resource with derived slice, create, and patch schemas

**Good** — one canonical `Project` schema anchored to hoisted `GET /v1/projects/{projectId}`, paired with an explicit `slice`, a `create` input declaring `nonResourceInputs`, an RFC 7396 `patch` input, and a flat `POST 201` one-time secret on `CreatedApiKey` (`ADS-0002` §3):

```yaml
components:
  schemas:
    Project:
      x-photon-resource:
        type: projects.project
      type: object
      required:
        - id
        - organizationId
        - name
        - createdAt
      properties:
        id:
          type: string
          readOnly: true
        organizationId:
          type: string
          readOnly: true
        name:
          type: string
        description:
          type:
            - string
            - "null"
        createdAt:
          type: string
          format: date-time
          readOnly: true

    ProjectSummary:
      x-photon-resource:
        role: slice
        canonical: "#/components/schemas/Project"
      type: object
      required:
        - id
        - name
        - createdAt
      properties:
        id:
          type: string
          readOnly: true
        name:
          type: string
        createdAt:
          type: string
          format: date-time
          readOnly: true

    CreateProjectRequest:
      x-photon-resource:
        role: create
        canonical: "#/components/schemas/Project"
        nonResourceInputs:
          - templateId
      type: object
      required:
        - name
      properties:
        name:
          type: string
        description:
          type:
            - string
            - "null"
        templateId:
          type: string

    PatchProjectRequest:
      x-photon-resource:
        role: patch
        canonical: "#/components/schemas/Project"
      type: object
      additionalProperties: false
      minProperties: 1
      properties:
        name:
          type: string
        description:
          type:
            - string
            - "null"
```

### Per-service `Operation` canonical resource

**Good** — each service declares its own canonical `Operation` schema (`billing.operation`) on its operations route while preserving the `ADS-0004` status invariants and field names (`id`, `type`, `status`, `createdAt`, `updatedAt`, `completedAt`, `response`, `error`):

```yaml
components:
  schemas:
    BillingOperationBase:
      type: object
      required:
        - id
        - type
        - status
        - createdAt
        - updatedAt
        - completedAt
        - response
        - error
      properties:
        id:
          type: string
          readOnly: true
        type:
          type: string
          const: billing.checkout
          readOnly: true
        createdAt:
          type: string
          format: date-time
          readOnly: true
        updatedAt:
          type: string
          format: date-time
          readOnly: true
    BillingOperation:
      x-photon-resource:
        type: billing.operation
      oneOf:
        - allOf:
            - $ref: "#/components/schemas/BillingOperationBase"
            - type: object
              properties:
                status:
                  type: string
                  enum:
                    - pending
                    - running
                completedAt:
                  type: "null"
                response:
                  type: "null"
                error:
                  type: "null"
        - allOf:
            - $ref: "#/components/schemas/BillingOperationBase"
            - type: object
              properties:
                status:
                  type: string
                  const: succeeded
                completedAt:
                  type: string
                  format: date-time
                response:
                  type: object
                  required:
                    - invoiceId
                  properties:
                    invoiceId:
                      type: string
                error:
                  type: "null"
```

### Non-conformant patterns

**Bad** — list item with extra list-only property and type drift, `PATCH` accepting `readOnly` `createdAt` and missing `additionalProperties: false`, `PATCH 200` returning a mismatched shape, and invalid `x-photon-resource` pointers:

```yaml
components:
  schemas:
    BadProjectListItem:
      x-photon-resource:
        role: slice
        canonical: "#/components/schemas/Project"
      type: object
      properties:
        id:
          type: integer
        listOnlyBadge:
          type: string

    BadPatchProjectRequest:
      x-photon-resource:
        role: patch
        canonical: "#/components/schemas/Project"
      type: object
      required:
        - name
      properties:
        id:
          type: string
        createdAt:
          type: string
          format: date-time
        name:
          type: string

    BadDerivedAnnotation:
      x-photon-resource:
        role: slice
        canonical: "#/components/schemas/NonExistentResource"
        nonResourceInputs:
          - templateId
      type: object
      properties:
        id:
          type: string
```

## Lint Rules

The `@photon-hq/api-design-standards` Redocly plugin (`photon-ads`) enforces ADS-0007 using a two-tier model with five deterministic OpenAPI 3 rules. All five rules run at `error` severity in `photon-ads/recommended` and support declarative rule-level `ignore` entries (`path`, optional `method`, and optional `schema`).

- **Tier 1 (zero-annotation structural rules)**: `photon-ads/ads-0007-response-representation-consistency`, `photon-ads/ads-0007-collection-slice-subset`, and `photon-ads/ads-0007-mutation-input-symmetry` operate automatically on OpenAPI path topology without requiring `x-photon-resource`. Direct child routes (`.../{resourceId}`) and hoisted canonical routes (stripping one or more leading `/<scope>/{<scopeParam>}` pairs after any version prefix and confirming schema overlap) are resolved automatically.
- **Tier 2 (`x-photon-resource` rules)**: `photon-ads/ads-0007-resource-annotation-valid` and `photon-ads/ads-0007-derived-schema-compatibility` validate every `x-photon-resource` annotation and enforce strict role contracts (`slice`, `create`, `patch`, `replace`) against the referenced canonical component schema.

| Rule ID | Default Severity | What it enforces |
| --- | --- | --- |
| `photon-ads/ads-0007-response-representation-consistency` | `error` | Requires `PATCH 200`, `PUT 200`/`201`, and synchronous collection `POST 200`/`201` JSON responses to be structurally consistent with the resource's canonical single-resource `GET 200` schema (allowing flat one-time creation secrets per `ADS-0002` §3 and excluding `ADS-0004` `Operation` responses and `204` responses). |
| `photon-ads/ads-0007-collection-slice-subset` | `error` | Requires every collection `GET 200` list item schema to be a strict property and type subset of its corresponding direct or hoisted canonical single-resource `GET 200` schema (recursively across nested objects and arrays). |
| `photon-ads/ads-0007-mutation-input-symmetry` | `error` | Requires every `PATCH`, `PUT`, and collection `POST` JSON request body property overlapping with the canonical `GET 200` schema to use a compatible type recursively, and rejects `readOnly: true` canonical properties as well as server-managed `createdAt`/`updatedAt` (and `id` on `PATCH`/`PUT`). |
| `photon-ads/ads-0007-resource-annotation-valid` | `error` | Validates every `x-photon-resource` extension: enforces canonical `type` format (`^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$`) and document-wide uniqueness, validates derived `role` (`slice`, `create`, `patch`, `replace`) and local `#/components/schemas/<Name>` pointer to an existing canonical schema (no dangling refs, self-refs, or derived chains), and validates `nonResourceInputs` (allowed only on `create`, non-empty unique strings declared on the derived schema and absent from the canonical schema). |
| `photon-ads/ads-0007-derived-schema-compatibility` | `error` | Enforces strict role compatibility for every derived `x-photon-resource` schema against its canonical schema: property/type subsetting (excluding declared `nonResourceInputs` on `create`), `readOnly`/server-managed field rejection on `create`/`patch`/`replace`, and RFC 7396 optional-fields plus `additionalProperties: false` (or `unevaluatedProperties: false`) checks on `patch`. |

## Changelog

- **2026-11-28**: Drafted `ADS-0007` defining the canonical resource model, per-service `Operation` canonical resources, cross-method response consistency, collection slices, mutation input symmetry, and the `x-photon-resource` OpenAPI extension.
