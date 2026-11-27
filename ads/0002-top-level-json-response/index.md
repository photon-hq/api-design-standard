---
title: "ADS-0002: Top-Level JSON Response Structure"
sidebarTitle: "ADS-0002 · Top-Level JSON Responses"
description: "Flat top-level JSON objects for Photon public HTTP API responses, prohibiting bare arrays, single-resource wrapper envelopes, and split resource-and-secret creation wrappers."
ads: "0002"
status: "Approved"
updated: "2026-11-22"
---

# ADS-0002: Top-Level JSON Response Structure

- **Status**: Approved
- **Updated**: 2026-11-22

Consistent top-level JSON response shapes let callers, generated SDKs, and agents read resource fields directly without unwrapping per-endpoint envelopes or switching parsing logic between creation and retrieval responses. This standard is part of Photon API Design Standards and uses the keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** as described in RFC 2119.

## Normative Rules

### 1. Top-level JSON responses MUST be JSON objects

Every `2xx` JSON response (`application/json` or `application/*+json`) **MUST** have a JSON object at the root.

- Responses **MUST NOT** return a bare JSON array (`[...]`) at the top level, because top-level arrays cannot be extended with pagination cursors or collection metadata without a breaking change.
- Responses **MUST NOT** return a top-level JSON primitive (`"ok"`, `true`, `42`, or `null`).
- `204 No Content` responses and non-JSON media types (such as binary downloads or plain text) are unaffected by this rule.

### 2. Single-resource responses MUST be returned directly at the top level

`GET`, `POST`, `PATCH`, `PUT`, and `DELETE` responses returning a single resource **MUST** place the resource's fields directly at the root object (`{ "id": "...", ... }`).

- Responses **MUST NOT** wrap a single resource in a single-key resource envelope (such as `{ "apiKey": { ... } }`, `{ "project": { ... } }`, or `{ "organization": { ... } }`).
- Responses **MUST NOT** wrap a single resource under a generic envelope key (`data`, `result`, or `payload`), whether alone or paired with metadata keys such as `meta`.

### 3. Creation responses with one-time secrets MUST remain flat

When a `POST` endpoint creates a resource and returns a one-time sensitive value (such as `secret`, `signingSecret`, `clientSecret`, `token`, or `accessToken`), the response **MUST** return the resource directly at the top level with the one-time value as a sibling top-level property.

- Subsequent `GET`, `PATCH`, and `DELETE` responses for the same resource omit the one-time secret while keeping every other top-level resource field in the exact same position.
- Creation responses **MUST NOT** split the resource and one-time secret into a two-key wrapper envelope such as `{ "apiKey": { ... }, "secret": "..." }` or `{ "destination": { ... }, "signingSecret": "..." }`.

### 4. Allowed multi-field and non-resource top-level objects

Top-level JSON objects are **NOT** restricted to single resources. The following shapes are explicitly allowed:

- **Collections**: Top-level objects wrapping a list array, with or without pagination fields (for example `{ "items": [ ... ], "nextPageToken": "eyJjIjoiMjAyNi0xMS0yNiJ9" }`, with `nextPageToken` omitted on the final page per `ADS-0006`).
- **Free-form key-value maps**: Open dictionary objects with dynamic keys (for example label or attribute maps).
- **Scalar utility responses**: Objects returning scalar summaries, counts, or links (for example `{ "count": 42 }` or `{ "url": "https://example.com/..." }`).
- **Multi-entity composite responses**: Objects returning two or more peer entities (for example `{ "operation": { ... }, "resource": { ... } }`).
- **Nullable sub-objects with or without sibling metadata**: Objects whose sub-object property may be `null` (for example `{ "subscription": null, "timeZone": "UTC" }`).

## Examples

### Single-resource responses (`GET`, `PATCH`)

**Good** — resource fields returned directly at the top level (`GET /v1/projects/{projectId}/api-keys/{apiKeyId}`):

```json
{
  "id": "key_01h455vb4pex5vsknk084sn02r",
  "projectId": "prj_01h455vb4pex5vsknk084sn02q",
  "organizationId": "org_01h455vb4pex5vsknk084sn02s",
  "name": "Production server key",
  "createdAt": "2026-11-22T10:00:00Z"
}
```

**Bad** — wrapped in a single-key resource envelope:

```json
{
  "apiKey": {
    "id": "key_01h455vb4pex5vsknk084sn02r",
    "projectId": "prj_01h455vb4pex5vsknk084sn02q",
    "organizationId": "org_01h455vb4pex5vsknk084sn02s",
    "name": "Production server key",
    "createdAt": "2026-11-22T10:00:00Z"
  }
}
```

**Bad** — wrapped in a generic `data` envelope (alone or alongside `meta`):

```json
{
  "data": {
    "id": "prj_01h455vb4pex5vsknk084sn02q",
    "organizationId": "org_01h455vb4pex5vsknk084sn02s",
    "name": "Acme Billing"
  },
  "meta": {
    "requestId": "req_01h455vb4pex5vsknk084sn02t"
  }
}
```

### Creation responses with one-time secrets (`POST`)

**Good** — flat resource at the root with the one-time `secret` as a sibling top-level field (`POST /v1/projects/{projectId}/api-keys`):

```json
{
  "id": "key_01h455vb4pex5vsknk084sn02r",
  "projectId": "prj_01h455vb4pex5vsknk084sn02q",
  "organizationId": "org_01h455vb4pex5vsknk084sn02s",
  "name": "Production server key",
  "createdAt": "2026-11-22T10:00:00Z",
  "secret": "example_one_time_api_key_secret"
}
```

**Good** — flat webhook destination with the one-time `signingSecret` as a sibling field (`POST /v1/projects/{projectId}/destinations`):

```json
{
  "id": "dst_01h455vb4pex5vsknk084sn02u",
  "projectId": "prj_01h455vb4pex5vsknk084sn02q",
  "url": "https://webhooks.example.com/events",
  "enabled": true,
  "createdAt": "2026-11-22T10:00:00Z",
  "signingSecret": "example_one_time_signing_secret"
}
```

**Bad** — two-key wrapper splitting the created resource and its one-time secret:

```json
{
  "apiKey": {
    "id": "key_01h455vb4pex5vsknk084sn02r",
    "projectId": "prj_01h455vb4pex5vsknk084sn02q",
    "organizationId": "org_01h455vb4pex5vsknk084sn02s",
    "name": "Production server key",
    "createdAt": "2026-11-22T10:00:00Z"
  },
  "secret": "example_one_time_api_key_secret"
}
```

```json
{
  "destination": {
    "id": "dst_01h455vb4pex5vsknk084sn02u",
    "projectId": "prj_01h455vb4pex5vsknk084sn02q",
    "url": "https://webhooks.example.com/events",
    "enabled": true
  },
  "signingSecret": "example_one_time_signing_secret"
}
```

### Collections vs. bare arrays

**Good** — collection wrapped in a top-level JSON object (`GET /v1/projects/{projectId}/api-keys`):

```json
{
  "items": [
    {
      "id": "key_01h455vb4pex5vsknk084sn02r",
      "projectId": "prj_01h455vb4pex5vsknk084sn02q",
      "organizationId": "org_01h455vb4pex5vsknk084sn02s",
      "name": "Production server key",
      "createdAt": "2026-11-22T10:00:00Z"
    }
  ]
}
```

**Bad** — bare top-level JSON array:

```json
[
  {
    "id": "key_01h455vb4pex5vsknk084sn02r",
    "projectId": "prj_01h455vb4pex5vsknk084sn02q",
    "organizationId": "org_01h455vb4pex5vsknk084sn02s",
    "name": "Production server key"
  }
]
```

### Allowed composite, nullable-subobject, and utility responses

**Good** — scalar utility response (`GET /v1/organizations/{organizationId}/projects/count`):

```json
{
  "count": 42
}
```

**Good** — nullable sub-object paired with sibling metadata (`GET /v1/projects/{projectId}/subscription`):

```json
{
  "subscription": null,
  "timeZone": "UTC"
}
```

**Good** — multi-entity composite response (`POST /v1/projects/{projectId}/exports`):

```json
{
  "operation": {
    "id": "opr_01h455vb4pex5vsknk084sn02v",
    "status": "pending"
  },
  "resource": {
    "id": "prj_01h455vb4pex5vsknk084sn02q",
    "organizationId": "org_01h455vb4pex5vsknk084sn02s",
    "name": "Acme Billing"
  }
}
```

## Lint Rules

The `@photon-hq/api-design-standards` Redocly plugin (`photon-ads`) enforces ADS-0002 on `2xx` `application/json` and `application/*+json` responses (excluding `application/problem+json`, which is reserved for RFC 9457 error responses) with the following deterministic OpenAPI 3 rules:

| Rule ID | Default Severity | What it enforces |
| --- | --- | --- |
| `photon-ads/ads-0002-top-level-json-object` | `error` | Rejects `2xx` JSON responses whose top-level schema or union branch is an array, primitive, or `null` instead of a JSON object. |
| `photon-ads/ads-0002-no-single-resource-wrapper` | `error` | Rejects `2xx` JSON responses that wrap a single non-nullable structured object in a single-key resource envelope or under a generic `data`, `result`, or `payload` envelope key. |
| `photon-ads/ads-0002-flat-creation-secret` | `error` | Rejects `POST` `2xx` JSON responses that use a two-key wrapper pairing a non-nullable structured object with a string one-time secret or token field (`secret`, `*Secret`, `token`, `*Token`). |

## Changelog

- **2026-11-22**: Approved and published as `ADS-0002`.
