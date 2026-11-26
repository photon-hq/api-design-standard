---
title: "ADS-0005: Standard Resource Methods and Lifecycle"
sidebarTitle: "ADS-0005 · Standard Resource Methods"
description: "Standard HTTP methods, read symmetry for addressable resources, canonical success status codes, representation consistency, and URL path naming across Photon public HTTP APIs."
ads: "0005"
status: "Draft"
updated: "2026-11-26"
---

# ADS-0005: Standard Resource Methods and Lifecycle

- **Status**: Draft
- **Updated**: 2026-11-26

Consistent HTTP methods, read symmetry, status codes, and URL structure let callers, generated SDKs, dashboards, CLIs, and automated agents navigate every Photon resource lifecycle without endpoint-specific special cases. This standard is part of Photon API Design Standards and uses the keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** as described in RFC 2119.

## Scope

This standard defines the lifecycle contract for resource collections, addressable items, singletons, and custom state-transition actions across Photon public HTTP APIs:

- Standard HTTP method semantics and prohibited anti-patterns.
- Read symmetry for mutable resources, custom actions, and addressable collections.
- Canonical `2xx` success status codes and representation consistency.
- URL path segment casing and noun conventions.

Related concerns are governed by separate standards:

- Resource identifier fields (`id`, `<resource>Id`) and URL path parameter naming (`{<resource>Id}`) are defined in `ADS-0001`.
- Flat top-level JSON response objects and one-time creation secrets are defined in `ADS-0002`.
- Asynchronous long-running operations (`202 Accepted`, `Operation` schema, polling, and cancellation) are defined in `ADS-0004`.
- Pagination, filtering, and sorting query parameters and request idempotency headers (`Idempotency-Key`) are outside the scope of this standard.

## Normative Rules

### 1. Standard HTTP method semantics

Photon public HTTP APIs **MUST** map standard resource lifecycle operations to standard HTTP methods:

| Operation | Route shape | HTTP method | Semantics |
| --- | --- | --- | --- |
| List collection | `/v1/.../<collection>` | `GET` | Read a collection envelope of resources |
| Create resource | `/v1/.../<collection>` | `POST` | Create a new resource in the collection |
| Get item | `/v1/.../<collection>/{<resource>Id}` | `GET` | Read a single addressable resource |
| Partial update | `/v1/.../<collection>/{<resource>Id}` or `/v1/.../<singleton>` | `PATCH` | Merge-update mutable fields on an existing resource |
| Full replace / upsert | `/v1/.../<collection>/{<resource>Id}` or `/v1/.../<singleton>` | `PUT` | Replace a resource in full or perform an idempotent upsert |
| Delete resource | `/v1/.../<collection>/{<resource>Id}` or `/v1/.../<singleton>` | `DELETE` | Remove or soft-delete a single resource |
| Custom action | `/v1/.../<collection>/{<resource>Id}/<action>` | `POST` | Trigger a domain state transition that does not fit CRUD (for example `revoke`, `cancel`, `rotate`, `retry`, `archive`, `restore`) |

- Static URL path segments **MUST NOT** embed CRUD verbs (`create`, `get`, `list`, `update`, `delete`, `remove`, `fetch`, `edit`, or `add`) either as standalone segments (such as `/v1/projects/create`) or as prefixes (such as `/v1/projects/get-project`, `/v1/getUser`, `/v1/list-projects`, or `/v1/api-keys/delete-key`). Legitimate domain actions such as `revoke`, `cancel`, `rotate`, `retry`, `resend`, `archive`, `restore`, `verify`, `enable`, `disable`, `transfer-ownership`, `preview`, `search`, `query`, and `batch` remain allowed.
- A single endpoint path **MUST NOT** declare both `PUT` and `PATCH`. Choose `PATCH` for partial updates or `PUT` for full replacement and idempotent upsert—never both on the same path.
- `GET` operations **MUST NOT** declare a request body (`requestBody`). Complex queries that exceed query-string limits **SHOULD** use a dedicated `POST` search or query endpoint.
- Collection-level `DELETE` operations (paths not ending in a resource identifier parameter `{<resource>Id}`) **MUST NOT** declare a request body. Single-resource deletes identify the target in the URL path, singleton deletes require no body, and bulk deletions **SHOULD** use a dedicated `POST` batch endpoint.

### 2. Read symmetry for addressable resources

Every addressable resource that can be listed, modified, deleted, or transitioned through a custom action **MUST** be directly readable via `GET`.

#### Mutation-to-read symmetry

- On any addressable item path ending in `{<resource>Id}`, if the path declares `PATCH`, `PUT`, or `DELETE`, or exposes a custom action sub-route `POST .../{<resource>Id}/<action>`, the API **MUST** also expose a single-resource `GET`—either directly on the same item path (`GET .../{<resource>Id}`) or on a hoisted canonical item path (after removing one or more leading `/<scope>/{<scopeId>}` prefixes) with a compatible resource representation.
- On any singleton resource path (not ending in `{<resource>Id}`), if the path declares `PATCH`, `PUT`, or `DELETE` (excluding collection `DELETE` endpoints with a request body), the exact same path **MUST** also declare `GET`.

#### Collection-to-item read symmetry

- Whenever a collection `GET` endpoint returns a collection envelope whose array items declare a canonical `ADS-0001` primary identifier field (`id`), the API **MUST** expose a corresponding single-resource `GET` endpoint:
  1. **Direct child route**: `GET <collectionPath>/{<resource>Id}` (for example `GET /v1/projects/{projectId}/webhooks` paired with `GET /v1/projects/{projectId}/webhooks/{webhookId}`), **OR**
  2. **Hoisted canonical route**: `GET /v1/<resource>/{<resource>Id}` (or a less-nested canonical path obtained by removing one or more leading `/<scope>/{<scopeId>}` pairs after the version prefix, for example `GET /v1/organizations/{organizationId}/projects` paired with `GET /v1/projects/{projectId}`), provided the list item schema and hoisted `GET` response schema are compatible (either referencing the same schema or forming a compatible summary projection whose required properties and `id` type match the canonical item schema).
- Non-resource lookup collections whose items do not carry a primary `id` (such as supported countries, permission scopes, or recommendations) and multi-field composite summaries are outside this requirement.
- Rare append-only streams or audit logs whose items carry an `id` but intentionally have no single-item `GET` endpoint **SHOULD** document the reason explicitly.

### 3. Standard success status codes

Standard resource methods **MUST** use predictable `2xx` HTTP status codes:

| Method / Operation | Canonical success status | Notes |
| --- | --- | --- |
| `GET` | `200 OK` | **MUST NOT** declare `201` or `202`. **MAY** also support `304 Not Modified` for conditional reads. |
| Collection `POST` (create) | `201 Created` or `202 Accepted` | Synchronous creation **MUST** declare `201`. Asynchronous creation **MUST** declare `202` per `ADS-0004`. `200` **MAY** appear alongside `201` or `202` for idempotent replay, but collection creation **MUST NOT** declare only `200` or `204`. |
| Custom action `POST` | `200 OK`, `202 Accepted`, or `204 No Content` | Synchronous state transitions **SHOULD** return `200` with the updated resource or receipt; asynchronous actions return `202` per `ADS-0004`. |
| `PATCH` | `200 OK` or `202 Accepted` | **MUST NOT** declare `204 No Content`. A `200` response **MUST** declare a response body (`content`) returning the updated resource so callers do not need a follow-up `GET`. |
| `PUT` | `200 OK`, `201 Created`, or `202 Accepted` | Return `200` for replacement (or `201` when creating on upsert) with the updated resource representation. |
| `DELETE` | `204 No Content`, `200 OK`, or `202 Accepted` | Synchronous deletion **SHOULD** return `204` with no response body (`content`). **MAY** return `200` with a JSON resource or receipt body for explicit soft-deletion, or `202` for asynchronous deletion. **MUST NOT** declare `201` and **MUST NOT** attach a response body to `204`. |

### 4. Representation consistency

- `GET`, `POST` (`201 Created`), `PATCH` (`200 OK`), and `PUT` (`200 OK` or `201 Created`) for the same resource **SHOULD** return the same canonical flat JSON representation per `ADS-0002`.
- Items returned by a collection `GET` **SHOULD** use the same canonical resource schema or a strict summary projection that preserves `id` and shared field names and types so callers can fetch full details from the corresponding item `GET` without renaming fields.
- Only one-time creation secrets (such as `secret` or `signingSecret`, returned as flat sibling fields per `ADS-0002`) **MAY** be returned exclusively on `POST` `201 Created` and omitted from subsequent `GET` and `PATCH` responses.
- Synchronous `201 Created` responses **SHOULD** include a `Location` response header pointing to the newly created resource's canonical `GET` URL (for example `Location: https://api.photon.codes/v1/projects/prj_01h455vb4pex5vsknk084sn02q/webhooks/whk_01h455vb4pex5vsknk084sn02z`).

### 5. URL path naming

- Every static URL path segment (excluding `{param}` placeholders, leading version prefixes such as `v1`, and `.well-known`) **MUST** use lowercase `kebab-case` (for example `/v1/projects/{projectId}/api-keys` and `/v1/projects/{projectId}/agent-profile`).
- Static segments **MUST NOT** use `camelCase` (`/apiKeys`), `snake_case` (`/api_keys`), uppercase letters (`/Projects`), dots, or spaces.
- Collection path segments **SHOULD** use plural nouns (for example `projects`, `webhooks`, `api-keys`, `members`, `invoices`), and singleton sub-resource path segments **SHOULD** use singular nouns (for example `agent-profile`).

## Examples

### Standard CRUD resource lifecycle

**Good** — plural kebab-case collection with `GET 200`, `POST 201` + `Location`, direct item `GET 200`, `PATCH 200` returning the updated resource, and `DELETE 204` with no body:

```yaml
paths:
  /v1/projects/{projectId}/webhooks:
    get:
      summary: List project webhooks
      responses:
        "200":
          description: Webhook collection
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/WebhookListResponse"
    post:
      summary: Create a project webhook
      responses:
        "201":
          description: Created webhook
          headers:
            Location:
              description: Canonical URL for the created webhook
              schema:
                type: string
                format: uri
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Webhook"
  /v1/projects/{projectId}/webhooks/{webhookId}:
    get:
      summary: Get a project webhook
      responses:
        "200":
          description: Webhook details
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Webhook"
    patch:
      summary: Update a project webhook
      responses:
        "200":
          description: Updated webhook
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Webhook"
    delete:
      summary: Delete a project webhook
      responses:
        "204":
          description: Webhook deleted
```

### Scoped collection list with hoisted canonical `GET`

**Good** — `GET /v1/organizations/{organizationId}/projects` lists `Project` items and pairs with the hoisted canonical item endpoint `GET /v1/projects/{projectId}`:

```http
GET /v1/organizations/org_01h455vb4pex5vsknk084sn02s/projects HTTP/1.1
Host: api.photon.codes
```

```json
{
  "items": [
    {
      "id": "prj_01h455vb4pex5vsknk084sn02q",
      "organizationId": "org_01h455vb4pex5vsknk084sn02s",
      "name": "Acme Billing",
      "createdAt": "2026-11-26T10:00:00Z"
    }
  ],
  "nextPageToken": null
}
```

```http
GET /v1/projects/prj_01h455vb4pex5vsknk084sn02q HTTP/1.1
Host: api.photon.codes
```

```json
{
  "id": "prj_01h455vb4pex5vsknk084sn02q",
  "organizationId": "org_01h455vb4pex5vsknk084sn02s",
  "name": "Acme Billing",
  "createdAt": "2026-11-26T10:00:00Z"
}
```

### Singleton resource and custom item action

**Good** — singleton `agent-profile` pairs `PATCH` with `GET` on the same path, and custom item action `POST .../api-keys/{apiKeyId}/revoke` pairs with `GET .../api-keys/{apiKeyId}`:

```yaml
paths:
  /v1/projects/{projectId}/agent-profile:
    get:
      summary: Get project agent profile
      responses:
        "200":
          description: Agent profile
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/AgentProfile"
    patch:
      summary: Update project agent profile
      responses:
        "200":
          description: Updated agent profile
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/AgentProfile"
  /v1/projects/{projectId}/api-keys/{apiKeyId}:
    get:
      summary: Get a project API key
      responses:
        "200":
          description: API key details
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ApiKey"
  /v1/projects/{projectId}/api-keys/{apiKeyId}/revoke:
    post:
      summary: Revoke a project API key
      responses:
        "200":
          description: Revoked API key
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ApiKey"
```

### Non-conformant patterns

**Bad** — CRUD verbs in URL segments, `camelCase`/`snake_case` paths, both `PUT` and `PATCH` on one path, `GET` with `requestBody`, collection `DELETE` with `requestBody`, collection `POST` returning only `200`, `PATCH 204`, `DELETE 204` with a response body, and an addressable list with no item `GET`:

```yaml
paths:
  /v1/projects/create-project:
    post:
      summary: Embeds CRUD verb in path
  /v1/projects/{projectId}/apiKeys:
    get:
      summary: Uses camelCase path segment and lacks single-item GET
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          description: List of API keys
          content:
            application/json:
              schema:
                type: object
                properties:
                  items:
                    type: array
                    items:
                      $ref: "#/components/schemas/ApiKey"
    post:
      summary: Collection creation returning only 200 instead of 201 or 202
      responses:
        "200":
          description: Created
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ApiKey"
    delete:
      summary: Collection DELETE with requestBody
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                apiKeyIds:
                  type: array
                  items:
                    type: string
      responses:
        "204":
          description: Deleted with disallowed body
          content:
            application/json:
              schema:
                type: object
  /v1/projects/{projectId}/agent_profile:
    put:
      summary: Declares both PUT and PATCH on one path and uses snake_case
      responses:
        "200":
          description: Replaced
    patch:
      summary: Partial update returning 204 instead of 200 with body
      responses:
        "204":
          description: No content
```

## Lint Rules

The `@photon-hq/api-design-standards` Redocly plugin (`photon-ads`) enforces ADS-0005 with the following deterministic OpenAPI 3 rules. All four rules run at `error` severity in `photon-ads/recommended` and support declarative rule-level `ignore` entries (`path` and optional `method`).

**Collection-envelope and hoisted-route heuristic**: `photon-ads/ads-0005-addressable-resource-read` classifies a `GET` endpoint on a non-parameterized path as an addressable collection only when its `200` (or fallback `2XX`) JSON response resolves to an object without a top-level `id`, containing exactly one top-level array property whose item object schema declares a scalar `id`, with all other top-level properties limited to standard collection/pagination metadata (`nextPageToken`, `prevPageToken`, `previousPageToken`, `cursor`, `nextCursor`, `hasMore`, `totalCount`, `total`, `count`, `limit`, `pageSize`, `page`, `pageInfo`, and related pagination fields). Non-resource lookup lists without `id` and composite summaries are excluded automatically. Hoisted canonical `GET` routes are matched by stripping one or more leading `/<scope>/{<scopeParam>}` pairs immediately after any leading version prefix (`v1`, `v2`, etc.) and checking schema compatibility (matching component `$ref` or compatible `id` type, required list-item property subset, and non-`id` property overlap).

| Rule ID | Default Severity | What it enforces |
| --- | --- | --- |
| `photon-ads/ads-0005-addressable-resource-read` | `error` | Requires a corresponding single-resource `GET` (direct or schema-compatible hoisted canonical route) for every item route declaring `PATCH`, `PUT`, `DELETE`, or a custom action `POST .../{param}/<action>`, requires `GET` on every singleton declaring `PATCH`, `PUT`, or bodyless `DELETE`, and requires a direct or schema-compatible hoisted item `GET` for every addressable collection `GET` whose items declare a canonical scalar `id`. |
| `photon-ads/ads-0005-standard-http-methods` | `error` | Rejects CRUD verbs in static URL path segments (`create`, `get`, `list`, `update`, `delete`, `remove`, `fetch`, `edit`, `add` and their kebab/snake/camel prefixes), rejects declaring both `PUT` and `PATCH` on the same path, rejects `GET` with `requestBody`, and rejects collection-level `DELETE` (paths not ending in `{param}`) with `requestBody`. |
| `photon-ads/ads-0005-standard-status-codes` | `error` | Rejects `201` and `202` on `GET`; requires `201` or `202` on collection creation `POST` endpoints (paths not ending in `{param}` that also declare `GET` or a `{param}` child path); rejects `204` and bodyless `200` on `PATCH`; and rejects `201` and `204` with a response `content` body on `DELETE`. |
| `photon-ads/ads-0005-url-path-naming` | `error` | Requires every static URL path segment (excluding `{param}` placeholders, leading version prefixes `v[0-9]+`, and `.well-known`) to use lowercase `kebab-case`. |

## Changelog

- **2026-11-26**: Drafted as `ADS-0005`.
