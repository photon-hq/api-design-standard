---
title: "ADS-0001: Resource Identifiers and Path Parameter Naming"
sidebarTitle: "ADS-0001 · Resource Identifiers"
description: "Consistent primary identifier fields, qualified foreign keys, and URL path parameter naming across Photon public HTTP APIs."
ads: "0001"
status: "Approved"
updated: "2026-11-21"
---

# ADS-0001: Resource Identifiers and Path Parameter Naming

- **Status**: Approved
- **Updated**: 2026-11-21

Consistent identifier naming across Photon public HTTP APIs lets callers, generated SDKs, and agents predict field names and URL templates without memorizing per-endpoint conventions. This standard is part of Photon API Design Standards and uses the keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** as described in RFC 2119.

## Normative Rules

### 1. Primary identifier field (`id`)

Every resource object **MUST** use `id` as its own primary identifier field.

- A resource object **MUST NOT** rename its own primary identifier to a resource-prefixed key such as `projectId`, `apiKeyId`, `organizationId`, or `invoiceId`.
- Identifier fields **MUST** use lowercase `id`, never `ID` or `Id`.

### 2. Foreign-key identifier fields (`<resource>Id`)

References to other resources **MUST** be qualified in `lowerCamelCase` with the referenced resource name followed by the `Id` suffix (for example `organizationId`, `projectId`, or `invoiceId`).

- Foreign-key references **MUST NOT** use bare `id`.
- Foreign-key identifier fields **MUST NOT** use `snake_case` (such as `project_id` or `api_key_id`) or an uppercase `ID` suffix (such as `projectID` or `organizationID`).

### 3. URL path parameters (`{<resource>Id}`)

Resource identifier path parameters in URL templates **MUST** use resource-qualified `lowerCamelCase` names ending in `Id` (for example `/v1/projects/{projectId}/api-keys/{apiKeyId}`).

- URL path parameters **MUST NOT** use generic identifier names: `{id}`, `{uuid}`, `{uid}`, `{guid}`, or `{pk}` (case-insensitive).
- All path parameters—including non-identifier parameters such as `{slug}` or `{eventType}`—**MUST** use `lowerCamelCase` and **MUST NOT** use `snake_case` (`{project_id}`), `kebab-case` (`{project-id}`), `PascalCase` (`{ProjectId}`), or an uppercase `ID` suffix (`{projectID}`).

### 4. Path parameter consistency

All routes sharing the same parent resource path prefix **MUST** use the exact same path parameter name.

- An API **MUST NOT** mix different parameter names at the same path position across sibling or nested routes (for example `/v1/projects/{projectId}` alongside `/v1/projects/{id}/api-keys`, or `/v1/organizations/{orgId}` alongside `/v1/organizations/{organizationId}`).

### 5. Identifier format (advisory)

Resource identifiers **SHOULD** be opaque, immutable, type-prefixed strings (for example `prj_01h455vb4pex5vsknk084sn02q`, `key_01h455vb4pex5vsknk084sn02r`, or `org_01h455vb4pex5vsknk084sn02s`) so callers, SDKs, and logs can distinguish resource kinds without positional context. Callers **SHOULD** treat identifiers as opaque strings and **MAY** pass them directly into subsequent URL templates without parsing their internal structure.

## Examples

### Resource JSON objects

**Good** — primary key is `id`, foreign keys are qualified `lowerCamelCase` with `Id`:

```json
{
  "id": "key_01h455vb4pex5vsknk084sn02r",
  "projectId": "prj_01h455vb4pex5vsknk084sn02q",
  "organizationId": "org_01h455vb4pex5vsknk084sn02s",
  "name": "Production server key",
  "createdAt": "2026-11-21T10:00:00Z"
}
```

**Bad** — resource-prefixed primary key (`apiKeyId`), `snake_case`, and uppercase `ID`:

```json
{
  "apiKeyId": "key_01h455vb4pex5vsknk084sn02r",
  "project_id": "prj_01h455vb4pex5vsknk084sn02q",
  "organizationID": "org_01h455vb4pex5vsknk084sn02s",
  "name": "Production server key"
}
```

### Non-resource payloads

Non-resource payloads such as request bodies, aggregate summaries, and error responses are not required to define `id`, while still qualifying foreign keys in `lowerCamelCase`.

Request body for `POST /v1/projects`:

```json
{
  "organizationId": "org_01h455vb4pex5vsknk084sn02s",
  "name": "Acme Billing"
}
```

Response body for `GET /v1/projects/{projectId}/usage`:

```json
{
  "projectId": "prj_01h455vb4pex5vsknk084sn02q",
  "totalCents": 4200
}
```

### URL path templates and OpenAPI parameters

**Good** — resource-qualified `lowerCamelCase` path parameters, consistent across routes:

```yaml
paths:
  /v1/organizations/{organizationId}/projects:
    get:
      summary: List projects in an organization
  /v1/projects/{projectId}:
    get:
      summary: Get a project
  /v1/projects/{projectId}/api-keys/{apiKeyId}:
    get:
      summary: Get a project API key
  /v1/invoices/{invoiceId}:
    get:
      summary: Get an invoice
  /v1/events/{eventType}:
    get:
      summary: Get schema metadata for a non-ID lowerCamelCase parameter
```

**Bad** — generic `{id}`, inconsistent parent parameter names, and non-camelCase casing:

```yaml
paths:
  /v1/organizations/{orgId}/projects:
    get:
      summary: Uses orgId here
  /v1/organizations/{organizationId}:
    get:
      summary: Conflicts with orgId on the same prefix
  /v1/projects/{id}:
    get:
      summary: Uses generic {id}
  /v1/projects/{project_id}/api-keys/{apiKeyID}:
    get:
      summary: Uses snake_case and uppercase ID suffix
```

## Lint Rules

The `@photon-hq/api-design-standards` Redocly plugin (`photon-ads`) enforces ADS-0001 with the following deterministic OpenAPI 3 rules:

| Rule ID | Default Severity | What it enforces |
| --- | --- | --- |
| `photon-ads/ads-0001-resource-primary-id` | `error` | Rejects resource schemas and `GET` item responses that use a resource-prefixed primary ID (such as `projectId` on `Project`) instead of `id`, and rejects malformed ID property casing (`ID`, `Id`, `*_id`, `*ID`) across object schemas. |
| `photon-ads/ads-0001-path-param-naming` | `error` | Rejects generic path parameter names (`{id}`, `{uuid}`, `{uid}`, `{guid}`, `{pk}`) and non-`lowerCamelCase` or uppercase `*ID` path parameters in path templates and `in: path` parameter objects. |
| `photon-ads/ads-0001-path-param-consistency` | `error` | Rejects conflicting path parameter names across routes that share the same normalized parent resource path prefix (for example `/v1/projects/{projectId}` vs `/v1/projects/{id}/api-keys`). |

## Changelog

- **2026-11-21**: Approved and published as `ADS-0001` with deterministic Redocly rules.
