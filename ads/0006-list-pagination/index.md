---
title: "ADS-0006: List Pagination"
sidebarTitle: "ADS-0006 · List Pagination"
description: "Forward opaque token pagination using pageSize, pageToken, and nextPageToken, strict bounds validation, end-of-list omission, deterministic ordering, and unified error contracts across Photon public HTTP APIs."
ads: "0006"
status: "Approved"
updated: "2026-11-26"
---

# ADS-0006: List Pagination

- **Status**: Approved
- **Updated**: 2026-11-26

Consistent list pagination lets callers, generated SDKs, CLIs, and automated agents traverse any paginated collection with one shared iteration loop instead of endpoint-specific cursor names, wrapper objects, or termination heuristics. This standard is part of Photon API Design Standards and uses the keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** as described in RFC 2119.

## Scope

This standard defines the request parameters, response shape, bounds validation, token opacity, error contract, and ordering guarantees for paginated `GET` collection endpoints across Photon public HTTP APIs.

Related concerns are governed by separate standards:

- Resource identifier fields (`id`, `<resource>Id`) and URL path parameter naming (`{<resource>Id}`) are defined in `ADS-0001`.
- Top-level JSON object collection responses (prohibiting bare top-level arrays) are defined in `ADS-0002`.
- Standard collection `GET` semantics and collection-to-item read symmetry are defined in `ADS-0005`.

## Normative Rules

### 1. Forward opaque token pagination (AIP-158)

Paginated `GET` collection endpoints **MUST** use forward opaque token pagination modeled on Google AIP-158:

- **Request query parameters**:
  - `pageSize` (optional `integer`): maximum number of items to return in the current page.
  - `pageToken` (optional `string`, `minLength: 1`): opaque continuation token received as `nextPageToken` from a previous page response.
- **Response field**:
  - `nextPageToken` (optional `string`, `minLength: 1`): direct top-level property alongside the collection array (per `ADS-0002`), omitted on the final page.
- `nextPageToken` **MUST** be placed directly at the top level of the `200 OK` JSON response object and **MUST NOT** be nested inside a wrapper object such as `page`, `pagination`, `pageInfo`, `listMetadata`, or `meta`.
- Pagination contracts **MUST** be symmetric on `GET` operations: any `GET` endpoint declaring `pageSize`, `pageToken`, or top-level `nextPageToken` **MUST** declare all three.
- New endpoints **MUST NOT** use non-standard pagination query parameters (`cursor`, `limit`, `offset`, `page`, `perPage`, `per_page`, `page_size`, `page_token`, `pageNumber`, `page_number`, `after`, `before`, `startingAfter`, `endingBefore`, `starting_after`, `ending_before`, `nextToken`, `next_token`, `continuationToken`, or `continuation_token`) or non-standard pagination response fields (`nextCursor`, `prevCursor`, `previousCursor`, `prevPageToken`, `previousPageToken`, `nextPage`, `hasMore`, `hasNextPage`, `hasPreviousPage`, `pageInfo`, `pagination`, `listMetadata`, or their `snake_case` equivalents).
- Ordering direction and sort criteria **MUST** be expressed through explicit sort query parameters (such as `order` or `orderBy`), not bidirectional cursors (`after`/`before`, `startingAfter`/`endingBefore`, or `prevPageToken`).

### 2. End-of-list termination and partial or empty pages

- When there are no more items to return, the server **MUST** omit `nextPageToken` from the response JSON object.
- Responses **MUST NOT** serialize `"nextPageToken": null` or `"nextPageToken": ""` to indicate the final page.
- In OpenAPI, `nextPageToken` **MUST** be optional (absent from `required`), non-nullable `type: string`, and declare `minLength: 1`.
- A response **MAY** return fewer than `pageSize` items—or `0` items—while still returning a non-empty `nextPageToken` (for example, when server-side authorization or filtering removes entries from an internal storage slice).
- Clients **MUST** continue paginating strictly until `nextPageToken` is absent from the response, and **MUST NOT** terminate early because `items.length < pageSize` or because a page array is empty.

### 3. `pageSize` bounds, strict validation, and cross-page resizing

- `pageSize` **MUST** be an optional, non-nullable `integer` query parameter declaring an explicit `minimum` of at least `1` and an explicit reasonable `maximum`:
  - `100` is recommended for standard resource collections.
  - Up to `200` is recommended for high-throughput event or message streams.
  - OpenAPI schemas **MUST NOT** omit `minimum` or `maximum`, accept `0` or negative values, or use unbounded pseudo-maxima (such as `MAX_SAFE_INTEGER` or values above `1000`).
- Servers **MUST** document their default page size (for example `20` or `50`) in the `pageSize` parameter description.
- Servers **MUST** reject out-of-range values (`0`, negative integers, or integers above `maximum`) and non-integer values with a `4xx` validation error (`400 Bad Request` RFC 9457 Problem Details) rather than silently clamping values or treating `0` as the default.
- Callers **MAY** change `pageSize` on subsequent requests while passing a `pageToken`; the updated `pageSize` applies to that request's page only. Servers **MUST NOT** bind `pageSize` into `pageToken` validation or reject a valid `pageToken` solely because `pageSize` changed between pages.

### 4. Opaque tokens and `400 INVALID_PAGE_TOKEN` error contract

- `pageToken` and `nextPageToken` are opaque strings (`type: string`, `minLength: 1`, optional, non-nullable). Clients **MUST NOT** parse, decode, construct, modify, or persist tokens long-term across sessions.
- Servers **SHOULD** bind page tokens to the active filter parameters, sort parameters, and resource scope, and **SHOULD** protect token integrity and confidentiality (for example using HMAC signatures or authenticated encryption) so internal storage keys and query cursors are neither exposed nor forgeable.
- Malformed, expired, tampered, or filter/sort-mismatched `pageToken` values **MUST** return `400 Bad Request` with `Content-Type: application/problem+json` (RFC 9457 Problem Details) and error code `INVALID_PAGE_TOKEN`.

### 5. Deterministic ordering, consistency, and exact counts

- Paginated collections **MUST** define a deterministic total order—such as a primary sort field paired with a unique `id` tie-breaker—so items with identical primary sort keys do not shift unpredictably between pages.
- Pagination provides best-effort snapshot consistency across concurrent writes; callers that require strict uniqueness across pages **SHOULD** deduplicate items by their canonical `id` (`ADS-0001`).
- Paginated collection responses **MUST NOT** include expensive inline total-count fields such as `total` or `totalCount`. When callers need an exact count, expose a dedicated count endpoint such as `GET /v1/.../<collection>/count` returning `{ "count": 42 }` (per `ADS-0002`).

### 6. Exemptions and deprecation transitions

- **Unpaginated collections**: Bounded static reference catalogs (such as supported countries, permission scopes, event types, or plan catalogs) and small fixed-cap sub-resources are **NOT** required to paginate. Unpaginated endpoints simply omit `pageSize`, `pageToken`, and `nextPageToken`.
- **Unbounded collections**: Collections that grow per tenant, project, organization, or time period **MUST** implement pagination under this standard.
- **Migration transitions**: When migrating an existing endpoint from a legacy pagination scheme, legacy query parameters and response properties explicitly marked `deprecated: true` in OpenAPI **MAY** coexist temporarily alongside canonical `pageSize`, `pageToken`, and `nextPageToken` until removed in a versioned release.

## Examples

### Canonical paginated collection OpenAPI contract

**Good** — optional `pageSize` (`1..100`, documented default), optional `pageToken` (`minLength: 1`), optional non-nullable top-level `nextPageToken` (`minLength: 1`), and `400` RFC 9457 Problem Details for `INVALID_PAGE_TOKEN`:

```yaml
paths:
  /v1/projects/{projectId}/webhooks:
    parameters:
      - name: projectId
        in: path
        required: true
        description: Unique identifier of the project.
        schema:
          type: string
    get:
      operationId: listWebhooks
      summary: List project webhooks
      parameters:
        - name: pageSize
          in: query
          description: Maximum number of webhooks to return per page. Defaults to 20.
          schema:
            type: integer
            minimum: 1
            maximum: 100
        - name: pageToken
          in: query
          description: Opaque continuation token returned by a previous page.
          schema:
            type: string
            minLength: 1
        - name: order
          in: query
          description: Sort direction applied to creation time with id tie-breaker.
          schema:
            type: string
            enum:
              - asc
              - desc
      responses:
        "200":
          description: A page of project webhooks.
          content:
            application/json:
              schema:
                type: object
                required:
                  - items
                properties:
                  items:
                    type: array
                    items:
                      $ref: "#/components/schemas/Webhook"
                  nextPageToken:
                    type: string
                    minLength: 1
                    description: Opaque token for fetching the next page. Omitted on the final page.
        "400":
          description: Invalid pagination parameter or page token.
          content:
            application/problem+json:
              schema:
                $ref: "#/components/schemas/ProblemDetails"
```

### Multi-page traversal, cross-page resizing, and final page

**Good** — first page (`pageSize=2`), second page resizing `pageSize` to `50` and returning an empty filtered page that still carries `nextPageToken`, followed by the final page omitting `nextPageToken`:

```http
GET /v1/projects/prj_01h455vb4pex5vsknk084sn02q/webhooks?pageSize=2 HTTP/1.1
Host: api.photon.codes
```

```json
{
  "items": [
    {
      "id": "whk_01h455vb4pex5vsknk084sn02u",
      "projectId": "prj_01h455vb4pex5vsknk084sn02q",
      "url": "https://webhooks.example.com/primary",
      "enabled": true
    },
    {
      "id": "whk_01h455vb4pex5vsknk084sn02v",
      "projectId": "prj_01h455vb4pex5vsknk084sn02q",
      "url": "https://webhooks.example.com/audit",
      "enabled": true
    }
  ],
  "nextPageToken": "eyJjIjoiMjAyNi0xMS0yNiJ9"
}
```

```http
GET /v1/projects/prj_01h455vb4pex5vsknk084sn02q/webhooks?pageSize=50&pageToken=eyJjIjoiMjAyNi0xMS0yNiJ9 HTTP/1.1
Host: api.photon.codes
```

```json
{
  "items": [],
  "nextPageToken": "eyJjIjoiMjAyNi0xMS0yN19wMiJ9"
}
```

```http
GET /v1/projects/prj_01h455vb4pex5vsknk084sn02q/webhooks?pageSize=50&pageToken=eyJjIjoiMjAyNi0xMS0yN19wMiJ9 HTTP/1.1
Host: api.photon.codes
```

```json
{
  "items": [
    {
      "id": "whk_01h455vb4pex5vsknk084sn02w",
      "projectId": "prj_01h455vb4pex5vsknk084sn02q",
      "url": "https://webhooks.example.com/archive",
      "enabled": false
    }
  ]
}
```

### Invalid, expired, or mismatched `pageToken` (`400 INVALID_PAGE_TOKEN`)

**Good** — malformed, expired, tampered, or filter-mismatched `pageToken` returns `400 Bad Request` as RFC 9457 Problem Details:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
```

```json
{
  "type": "https://docs.photon.codes/errors/invalid-page-token",
  "title": "Invalid page token",
  "status": 400,
  "code": "INVALID_PAGE_TOKEN",
  "detail": "The supplied pageToken is malformed, expired, or does not match the current filter or sort parameters."
}
```

### Dedicated count endpoint and unpaginated static catalog

**Good** — exact counts use a dedicated `/count` endpoint instead of inline `totalCount`, and bounded static reference catalogs omit pagination fields completely:

```http
GET /v1/organizations/org_01h455vb4pex5vsknk084sn02s/projects/count HTTP/1.1
Host: api.photon.codes
```

```json
{
  "count": 42
}
```

```http
GET /v1/scopes HTTP/1.1
Host: api.photon.codes
```

```json
{
  "items": [
    {
      "name": "projects:read",
      "description": "Read project metadata."
    }
  ]
}
```

### Backward-compatible migration with `deprecated: true`

**Good** — legacy `cursor` / `nextCursor` fields marked `deprecated: true` alongside canonical `pageSize`, `pageToken`, and `nextPageToken` during a migration window:

```yaml
paths:
  /v1/projects/{projectId}/events:
    get:
      operationId: listProjectEvents
      parameters:
        - name: pageSize
          in: query
          description: Maximum number of events per page. Defaults to 50.
          schema:
            type: integer
            minimum: 1
            maximum: 200
        - name: pageToken
          in: query
          description: Opaque continuation token from the previous page.
          schema:
            type: string
            minLength: 1
        - name: cursor
          in: query
          deprecated: true
          description: Deprecated alias for pageToken.
          schema:
            type: string
      responses:
        "200":
          description: Page of project events.
          content:
            application/json:
              schema:
                type: object
                required:
                  - items
                properties:
                  items:
                    type: array
                    items:
                      $ref: "#/components/schemas/Event"
                  nextPageToken:
                    type: string
                    minLength: 1
                  nextCursor:
                    type: string
                    deprecated: true
```

### Non-conformant patterns

**Bad** — legacy query parameters (`limit`, `offset`, `cursor`, `startingAfter`), required or unbounded `pageSize`, `minimum: 0`, nullable or required `nextPageToken`, `hasMore`, inline `totalCount`, and nested `pagination` / `pageInfo` wrappers:

```yaml
paths:
  /v1/projects/{projectId}/webhooks:
    get:
      summary: Uses non-standard parameters and invalid bounds
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
        - name: offset
          in: query
          schema:
            type: integer
        - name: pageSize
          in: query
          required: true
          schema:
            type: integer
            minimum: 0
            maximum: 9007199254740991
      responses:
        "200":
          description: Non-conformant paginated response
          content:
            application/json:
              schema:
                type: object
                required:
                  - items
                  - nextPageToken
                  - hasMore
                properties:
                  items:
                    type: array
                    items:
                      $ref: "#/components/schemas/Webhook"
                  nextPageToken:
                    type:
                      - string
                      - "null"
                  hasMore:
                    type: boolean
                  pagination:
                    type: object
                    properties:
                      nextCursor:
                        type: string
```

**Bad** — returning `"nextPageToken": null`, `"nextPageToken": ""`, `hasMore`, `totalCount`, or a nested `pageInfo` object on the wire:

```json
{
  "items": [],
  "nextPageToken": null,
  "hasMore": false,
  "totalCount": 1240,
  "pageInfo": {
    "hasNextPage": false
  }
}
```

## Lint Rules

The `@photon-hq/api-design-standards` Redocly plugin (`photon-ads`) enforces ADS-0006 with the following deterministic OpenAPI 3 rules. All three rules run at `error` severity in `photon-ads/recommended`, resolve `$ref` Path Items, Parameters, Responses, and Schemas (including `allOf`/`oneOf`/`anyOf` compositions), skip migration parameters and properties explicitly marked `deprecated: true`, and support declarative rule-level `ignore` entries (`path` and optional `method`, plus optional `schema` on `photon-ads/ads-0006-pagination-response-shape`).

| Rule ID | Default Severity | What it enforces |
| --- | --- | --- |
| `photon-ads/ads-0006-standard-pagination-params` | `error` | Merges path-level and operation-level `parameters` on `GET` operations (operation overriding matching `(name, in)`), rejects non-deprecated legacy pagination query parameters (`cursor`, `limit`, `offset`, `page`, `perPage`, `per_page`, `page_size`, `page_token`, `pageNumber`, `page_number`, `after`, `before`, `startingAfter`, `endingBefore`, `starting_after`, `ending_before`, `nextToken`, `next_token`, `continuationToken`, `continuation_token`), and enforces pagination symmetry so any `GET` declaring non-deprecated `pageSize`, `pageToken`, or `200`/`2XX` JSON `nextPageToken` declares all three. |
| `photon-ads/ads-0006-page-size-bounds` | `error` | Requires non-deprecated `GET` query `pageSize` to be optional, non-nullable `integer` with explicit `minimum >= 1` and `minimum <= maximum <= 1000`, and requires non-deprecated `GET` query `pageToken` to be optional, non-nullable `string` with explicit `minLength >= 1`. |
| `photon-ads/ads-0006-pagination-response-shape` | `error` | On `GET` `200` (or `2XX` fallback) JSON object response variants, requires non-deprecated top-level `nextPageToken` to be optional (not in `required`), non-nullable `string`, and `minLength >= 1`; rejects non-deprecated legacy top-level pagination fields (`nextCursor`, `prevCursor`, `previousCursor`, `prevPageToken`, `previousPageToken`, `nextPage`, `hasMore`, `hasNextPage`, `hasPreviousPage`, `pageInfo`, `pagination`, `listMetadata`, and `snake_case` equivalents); and rejects non-deprecated top-level object wrappers nesting pagination indicators. |

## Changelog

- **2026-11-26**: Approved and published as `ADS-0006`.
