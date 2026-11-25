---
title: "ADS-0003: Idempotency-Key"
sidebarTitle: "ADS-0003 · Idempotency-Key"
description: "Where Photon public HTTP APIs accept the Idempotency-Key request header, its format, scope, and retry semantics, and the problem responses it requires."
ads: "0003"
status: "Draft"
updated: "2026-11-25"
---

# ADS-0003: Idempotency-Key

- **Status**: Draft
- **Updated**: 2026-11-25

The `Idempotency-Key` request header lets a client retry a non-idempotent request without repeating its side effect. Methods that HTTP already defines as idempotent do not need it, and a key that every request must carry makes plain retries fail. This standard defines which operations may declare `Idempotency-Key`, the key format, how servers scope and deduplicate keyed requests, and the responses clients can rely on. It is part of Photon API Design Standards and uses the keywords **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** as described in RFC 2119.

## References

- [RFC 9110, Section 9.2.2: Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2) defines `PUT`, `DELETE`, and the safe methods (`GET`, `HEAD`, `OPTIONS`, `TRACE`) as idempotent, and `POST` and `PATCH` as not idempotent by definition.
- [The Idempotency-Key HTTP Header Field (draft-ietf-httpapi-idempotency-key-header-09)](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-09) defines the header and its server behavior for non-idempotent methods.
- [RFC 9562: Universally Unique IDentifiers (UUIDs)](https://www.rfc-editor.org/rfc/rfc9562) defines UUID version 4.

## Normative Rules

### 1. `POST` and non-idempotent `PATCH` operations MAY declare `Idempotency-Key`

A `POST` operation, or a `PATCH` operation whose effect is not idempotent, **MAY** declare an `Idempotency-Key` header parameter.

- The `Idempotency-Key` header **MUST** be optional. An operation **MUST NOT** declare it with `required: true`, and a server **MUST NOT** reject a request because the header is absent.
- The `IdempotencyKeyRequiredProblem` problem (code `IDEMPOTENCY_KEY_REQUIRED`) **MUST NOT** appear in an API contract.
- A `PATCH` operation whose effect is already idempotent (for example, a merge patch that sets fields to given values) **SHOULD NOT** declare `Idempotency-Key`.

### 2. Other methods MUST NOT declare `Idempotency-Key`

`GET`, `HEAD`, `OPTIONS`, `PUT`, and `DELETE` operations **MUST NOT** declare an `Idempotency-Key` header parameter, at the operation level or the path level.

- An operation that needs keyed deduplication to be safe to retry is not idempotent. Model it as a `POST` operation instead.

### 3. Servers MUST ignore `Idempotency-Key` on other methods

When a `GET`, `HEAD`, `OPTIONS`, `PUT`, or `DELETE` request carries an `Idempotency-Key` header, the server **MUST** ignore the header.

- The server **MUST NOT** process the header: no deduplication or replay, no key validation, and no key storage.
- The server **MUST NOT** reject the request because of the header.
- These methods are idempotent because repeating them converges on the same domain state, not because the server replays an earlier response.

### 4. Key format and SDK behavior

- The header name **MUST** be `Idempotency-Key`.
- The value **MUST** be 1 to 255 printable ASCII characters, matching `^[\x21-\x7e]{1,255}$`, sent as a bare string. Servers **MUST NOT** strip or normalize RFC 9651 string quotes, so `"abc"` and `abc` are different keys.
- Clients **SHOULD** use a random UUID version 4 (RFC 9562) and **SHOULD NOT** put personal or sensitive data in a key.
- Generated Photon SDKs **SHOULD** generate a UUID version 4 when the caller gives no key on an operation that declares `Idempotency-Key`, and **SHOULD** reuse that key across their automatic retries of the same call.
- Servers **MUST** validate the key syntax before any lookup or execution, and **MUST** reject an invalid key with `400` `IdempotencyKeyInvalidProblem` (code `IDEMPOTENCY_KEY_INVALID`).

### 5. Scope and request fingerprint

- A key **MUST** be scoped to the authenticated tenant (project or organization) and the operation. The server **MUST** take the tenant from verified credentials, never from untrusted client input.
- Reusing a key on a different operation **MUST NOT** deduplicate against, or return the result of, the other operation.
- Servers **SHOULD** store keys hashed or under an HMAC, not in plain text.
- The request fingerprint **MUST** cover the operation, the path parameters, the query parameters, and the request body (as canonical JSON or raw bytes).
- When a request reuses a key within the same scope with a different fingerprint, the server **MUST** return `422` `IdempotencyKeyReusedProblem` (code `IDEMPOTENCY_KEY_REUSED`). It **MUST NOT** execute the operation and **MUST NOT** return the earlier result.

### 6. Same-key retries and error boundaries

A keyed retry deduplicates the side effect and returns a semantically equivalent response. It is not a byte-for-byte replay of the first HTTP response.

- After the first execution completes with a `2xx` or a terminal domain `4xx` outcome, a retry with the same key and a matching fingerprint **MUST NOT** repeat the side effect, and **MUST** return a response consistent with that completed outcome.
- That response **MAY** carry new per-request metadata such as `requestId` and `traceId`, **NEED NOT** be byte-identical to the first response, and **NEED NOT** carry an `Idempotent-Replayed` header.
- An operation that does not declare `Idempotency-Key` **MUST NOT** declare an `Idempotent-Replayed` response header.
- Errors raised before execution **MUST NOT** be stored as terminal outcomes: authentication and authorization failures, `429` rate limiting, request and header validation failures (including `400` `IDEMPOTENCY_KEY_INVALID`), and the `409`, `422`, and `503` idempotency problems. Transient `5xx` errors **MUST NOT** be stored as terminal outcomes either. Clients **MAY** retry these with the same key.

### 7. Concurrent requests, store availability, and retention

- While the first request for a key is still running, a concurrent request with the same key **MUST** get `409` `IdempotencyRequestInProgressProblem` (code `IDEMPOTENCY_REQUEST_IN_PROGRESS`) with a `Retry-After` response header in seconds. The server does not store this response, and the client **SHOULD** wait and retry with the same key and request.
- When the idempotency store or coordinator is unavailable, the server **MUST** fail closed with `503` `IdempotencyUnavailableProblem` (code `IDEMPOTENCY_UNAVAILABLE`), and **MUST NOT** run the operation without it.
- Servers **MUST** keep a completed idempotency record for at least 24 hours from completion. Retries **MUST NOT** extend that expiry, an in-progress claim **MUST NOT** expire while the request is still running, and the API documentation **MUST** publish the retention window.

### 8. Out of scope

This standard does not cover `202 Accepted` responses with `Location` polling, or `ETag` and `If-Match` compared with an `expectedVersion` field.

## Examples

### Declaring the key on `POST`

**Good**: an optional key with the canonical name and schema, and the idempotency problems:

```yaml
paths:
  /v1/projects/{projectId}/messages:
    post:
      operationId: sendMessage
      parameters:
        - name: Idempotency-Key
          in: header
          required: false
          schema:
            type: string
            minLength: 1
            maxLength: 255
            pattern: "^[\x21-\x7e]{1,255}$"
      responses:
        "201":
          description: Message sent.
          headers:
            Idempotent-Replayed:
              schema:
                type: boolean
        "400":
          description: Invalid request or idempotency key.
          content:
            application/problem+json:
              schema:
                oneOf:
                  - $ref: "#/components/schemas/IdempotencyKeyInvalidProblem"
                  - $ref: "#/components/schemas/ValidationFailedProblem"
        "409":
          description: A request with this key is still running.
          headers:
            Retry-After:
              schema:
                type: integer
          content:
            application/problem+json:
              schema:
                $ref: "#/components/schemas/IdempotencyRequestInProgressProblem"
        "422":
          description: The key was used with a different request.
          content:
            application/problem+json:
              schema:
                $ref: "#/components/schemas/IdempotencyKeyReusedProblem"
        "503":
          description: Idempotency is temporarily unavailable.
          content:
            application/problem+json:
              schema:
                $ref: "#/components/schemas/IdempotencyUnavailableProblem"
```

**Bad**: a required, lowercase key with a non-standard schema, the `IdempotencyKeyRequiredProblem`, a non-registry conflict problem, and no `409` in-progress or `503` responses:

```yaml
paths:
  /v1/projects/{projectId}/messages:
    post:
      operationId: sendMessage
      parameters:
        - name: idempotency-key
          in: header
          required: true
          schema:
            type: string
            format: uuid
      responses:
        "400":
          description: Missing or invalid key.
          content:
            application/problem+json:
              schema:
                oneOf:
                  - $ref: "#/components/schemas/IdempotencyKeyInvalidProblem"
                  - $ref: "#/components/schemas/IdempotencyKeyRequiredProblem"
        "422":
          description: Conflict.
          content:
            application/problem+json:
              schema:
                $ref: "#/components/schemas/IdempotencyConflictProblem"
```

### Idempotent methods

**Good**: `PUT` and `DELETE` operations without `Idempotency-Key` or `Idempotent-Replayed`:

```yaml
paths:
  /v1/projects/{projectId}/settings:
    put:
      operationId: replaceProjectSettings
      responses:
        "200":
          description: Settings replaced.
    delete:
      operationId: resetProjectSettings
      responses:
        "204":
          description: Settings reset.
```

**Bad**: `Idempotency-Key` on a `PUT` operation and at path level for a `DELETE` operation, and `Idempotent-Replayed` on a response of an operation that cannot take a key:

```yaml
paths:
  /v1/projects/{projectId}/settings:
    parameters:
      - name: idempotency-key
        in: header
        schema:
          type: string
    put:
      operationId: replaceProjectSettings
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Settings replaced.
          headers:
            Idempotent-Replayed:
              $ref: "#/components/headers/Idempotent-Replayed"
    delete:
      operationId: resetProjectSettings
      responses:
        "204":
          description: Settings reset.
```

## Lint Rules

The `@photon-hq/api-design-standards` Redocly plugin (`photon-ads`) enforces ADS-0003 with the following deterministic OpenAPI 3 rules. They find the header by a case-insensitive name match and check every operation-level and path-level declaration. An operation-level parameter overrides a path-level one only when its name matches exactly, as OpenAPI defines. The rules follow `$ref` parameters, path items, responses, and schemas, and look through `oneOf`, `anyOf`, and `allOf` problem schemas. A problem counts when its component schema name or its `code` constant matches. The rules do not accept `ignore` entries: an operation that violates this standard fails lint until it is fixed.

| Rule ID | Default Severity | What it enforces |
| --- | --- | --- |
| `photon-ads/ads-0003-idempotency-key-method` | `error` | Rejects an `Idempotency-Key` header parameter on `GET`, `HEAD`, `OPTIONS`, `PUT`, and `DELETE` operations. |
| `photon-ads/ads-0003-idempotency-key-optional` | `error` | Rejects an `Idempotency-Key` header parameter with `required: true` on `POST` and `PATCH` operations. |
| `photon-ads/ads-0003-idempotency-key-name` | `error` | Rejects an idempotency key header on `POST` and `PATCH` operations whose name is not spelled exactly `Idempotency-Key`. |
| `photon-ads/ads-0003-idempotency-key-schema` | `error` | Rejects an `Idempotency-Key` header on `POST` and `PATCH` operations whose schema is not `type: string`, `minLength: 1`, `maxLength: 255`, `pattern: ^[\x21-\x7e]{1,255}$`. |
| `photon-ads/ads-0003-idempotency-no-required-problem` | `error` | Rejects any operation response whose schema references `IdempotencyKeyRequiredProblem` or the `IDEMPOTENCY_KEY_REQUIRED` code. |
| `photon-ads/ads-0003-idempotent-replayed-header` | `error` | Rejects an `Idempotent-Replayed` response header on any operation that is not a `POST` or `PATCH` operation declaring `Idempotency-Key`. It does not require the header. |
| `photon-ads/ads-0003-idempotency-problems` | `error` | On `POST` and `PATCH` operations that declare `Idempotency-Key`, requires `application/problem+json` responses for `400` `IdempotencyKeyInvalidProblem`, `409` `IdempotencyRequestInProgressProblem` with a `Retry-After` header, `422` `IdempotencyKeyReusedProblem`, and `503` `IdempotencyUnavailableProblem`, and rejects `IdempotencyConflictProblem` on `409` and `422`. |

Lint cannot tell an idempotent `PATCH` operation from a non-idempotent one, so the rules allow an optional `Idempotency-Key` on every `PATCH` operation. Rules 3, 5, 6, and 7 and the runtime parts of rule 4 describe server behavior that an OpenAPI document cannot show, so lint does not check them.

## Changelog

- **2026-11-25**: Added key format, scope, fingerprint, retry, concurrency, availability, and retention rules, with five more lint rules.
- **2026-11-23**: Drafted as `ADS-0003`.
