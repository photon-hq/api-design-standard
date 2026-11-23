---
title: "ADS-0003: Idempotency-Key Usage by HTTP Method"
sidebarTitle: "ADS-0003 · Idempotency-Key"
description: "Where Photon public HTTP APIs accept the Idempotency-Key request header, and how servers treat it on methods that are already idempotent."
ads: "0003"
status: "Draft"
updated: "2026-11-23"
---

# ADS-0003: Idempotency-Key Usage by HTTP Method

- **Status**: Draft
- **Updated**: 2026-11-23

The `Idempotency-Key` request header lets a client retry a non-idempotent request without repeating its side effect. Methods that HTTP already defines as idempotent do not need it, and a key that every request must carry makes plain retries fail. This standard defines which operations may declare `Idempotency-Key` and how servers treat the header everywhere else. It is part of Photon API Design Standards and uses the keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** as described in RFC 2119.

## References

- [RFC 9110, Section 9.2.2: Idempotent Methods](https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2) defines `PUT`, `DELETE`, and the safe methods (`GET`, `HEAD`, `OPTIONS`, `TRACE`) as idempotent, and `POST` and `PATCH` as not idempotent by definition.
- [The Idempotency-Key HTTP Header Field (draft-ietf-httpapi-idempotency-key-header-09)](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header-09) defines the header and its server behavior for non-idempotent methods.

## Normative Rules

### 1. `POST` and non-idempotent `PATCH` operations MAY declare `Idempotency-Key`

A `POST` operation, or a `PATCH` operation whose effect is not idempotent, **MAY** declare an `Idempotency-Key` header parameter.

- The `Idempotency-Key` header **MUST** be optional. An operation **MUST NOT** declare it with `required: true`, and a server **MUST NOT** reject a request because the header is absent.
- A `PATCH` operation whose effect is already idempotent (for example, a merge patch that sets fields to given values) **SHOULD NOT** declare `Idempotency-Key`.

### 2. Other methods MUST NOT declare `Idempotency-Key`

`GET`, `HEAD`, `OPTIONS`, `PUT`, and `DELETE` operations **MUST NOT** declare an `Idempotency-Key` header parameter, at the operation level or the path level.

- A `PUT` or `DELETE` operation that needs a key to be safe to retry is not idempotent. Model it as a `POST` operation instead.

### 3. Servers MUST ignore `Idempotency-Key` on other methods

When a `GET`, `HEAD`, `OPTIONS`, `PUT`, or `DELETE` request carries an `Idempotency-Key` header, the server **MUST** ignore the header.

- The server **MUST NOT** process the header: no response replay, no key validation, and no key storage.
- The server **MUST NOT** reject the request because of the header.

### 4. Out of scope

This standard does not cover `202 Accepted` responses with `Location` polling, or `ETag` and `If-Match` compared with an `expectedVersion` field.

## Examples

### `POST` operations

**Good**: optional `Idempotency-Key` on a `POST` operation:

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
```

**Bad**: required `Idempotency-Key` on a `POST` operation:

```yaml
paths:
  /v1/projects/{projectId}/messages:
    post:
      operationId: sendMessage
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          schema:
            type: string
```

### Idempotent methods

**Good**: `PUT` and `DELETE` operations without `Idempotency-Key`:

```yaml
paths:
  /v1/projects/{projectId}/settings:
    put:
      operationId: replaceProjectSettings
    delete:
      operationId: resetProjectSettings
```

**Bad**: `Idempotency-Key` on a `PUT` operation, and on a path that has a `DELETE` operation:

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
    delete:
      operationId: resetProjectSettings
```

## Lint Rules

The `@photon-hq/api-design-standards` Redocly plugin (`photon-ads`) enforces ADS-0003 with the following deterministic OpenAPI 3 rules. Both rules match the header name without regard to case, check operation-level and path-level parameters (an operation-level parameter overrides a path-level one), and follow `$ref` parameters and path items. They do not accept `ignore` entries: an operation that violates this standard fails lint until it is fixed.

| Rule ID | Default Severity | What it enforces |
| --- | --- | --- |
| `photon-ads/ads-0003-idempotency-key-method` | `error` | Rejects an `Idempotency-Key` header parameter on `GET`, `HEAD`, `OPTIONS`, `PUT`, and `DELETE` operations. |
| `photon-ads/ads-0003-idempotency-key-optional` | `error` | Rejects an `Idempotency-Key` header parameter with `required: true` on `POST` and `PATCH` operations. |

Lint cannot tell an idempotent `PATCH` operation from a non-idempotent one, so the rules allow an optional `Idempotency-Key` on every `PATCH` operation. Rule 3 is runtime behavior that an OpenAPI document cannot show, so lint does not check it.

## Changelog

- **2026-11-23**: Drafted as `ADS-0003`.
