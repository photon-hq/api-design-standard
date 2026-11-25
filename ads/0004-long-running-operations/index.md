---
title: "ADS-0004: Long-Running Operations"
sidebarTitle: "ADS-0004 · Long-Running Operations"
description: "Canonical flat Operation schema, status lifecycle invariants, structured nextAction contract, and HTTP polling and cancellation conventions for asynchronous Photon public HTTP APIs."
ads: "0004"
status: "Approved"
updated: "2026-11-25"
---

# ADS-0004: Long-Running Operations

- **Status**: Approved
- **Updated**: 2026-11-25

Consistent asynchronous contracts let callers, generated SDKs, dashboards, CLIs, and AI agents start, poll, resume, and cancel long-running workflows with one shared state machine instead of per-endpoint conventions. This standard is part of Photon API Design Standards and uses the keywords **MUST**, **MUST NOT**, **SHOULD**, and **MAY** as described in RFC 2119.

## Scope and Asynchronous Patterns

Not every `202 Accepted` endpoint requires a separate `Operation` resource. Photon public HTTP APIs distinguish three asynchronous patterns:

1. **Long-Running Operations**: Multi-step provisioning, billing mutations, external provider handshakes, or batch workflows whose asynchronous execution is tracked independently of a single domain entity. These endpoints **MUST** return `202 Accepted` with a `Location` header pointing to `GET <scope>/operations/{operationId}`, an advisory `Retry-After` header when non-terminal, and a canonical flat `Operation` JSON body.
2. **Lifecycle-Bearing Resources**: Domain resources whose own canonical representation carries a durable lifecycle state (for example a resource awaiting provisioning, verification, or review). Creating or mutating such a resource **MAY** return `202 Accepted` with a `Location` header pointing to the resource itself rather than introducing a separate `Operation` resource.
3. **Fire-and-Forget Requests**: Ephemeral or queued signals that have no pollable status resource (for example typing indicators or best-effort queued notifications). These endpoints **MAY** return `202 Accepted` without a `Location` header.

The normative rules below apply to **Long-Running Operations**.

## Normative Rules

### 1. Canonical flat Operation schema

Every `Operation` resource **MUST** be a flat top-level JSON object consistent with `ADS-0002`, modeled as a discriminated union keyed on `status`.

- Responses **MUST NOT** wrap the operation under a single-key envelope such as `{ "operation": { ... } }` or under a generic `data`, `result`, or `payload` envelope.
- Every `status` branch **MUST** declare and require all eight universal fields below using their exact names:

| Field | Type | Requirement |
| --- | --- | --- |
| `id` | `string` | Primary operation identifier per `ADS-0001` (for example `pho_op_01h455vb4pex5vsknk084sn02v`). **MUST NOT** be named `operationId`. The corresponding URL path parameter **MUST** be `{operationId}`. |
| `type` | `string` | Service-defined enum naming the action in `<resource>.<action>` format (for example `plan.change`, `domain.verify`, `connection.authorize`, or `line.provision`). **MUST NOT** be named `kind`. |
| `status` | `string` | Lifecycle discriminator. **MUST NOT** be named `state`. Values **MUST** be a subset of the canonical six-state vocabulary below. |
| `createdAt` | `string` (`date-time`) | RFC 3339 UTC timestamp recording when the operation was created. **MUST NOT** be named `submittedAt`. |
| `updatedAt` | `string` (`date-time`) | RFC 3339 UTC timestamp recording the most recent update to the operation. |
| `completedAt` | `string \| null` (`date-time`) | `null` on every non-terminal status; non-null RFC 3339 UTC timestamp on every terminal status. **MUST NOT** be named `resolvedAt` or `endedAt`. |
| `response` | `<TResponse> \| null` | On `succeeded`, holds the typed operation outcome (matching what a synchronous equivalent would return, or explicit `null` for empty-outcome operations such as asynchronous deletions). On all other statuses, **MUST** be `null`. **MUST NOT** be named `result`. |
| `error` | `ProblemDetails \| null` | On `failed`, **MUST** be a non-null RFC 9457 Problem Details object containing at minimum `type`, `title`, `status`, and `code` (plus optional `detail`, `remediation`, and typed domain extensions such as `retryable`) matching synchronous HTTP error objects. On all other statuses, **MUST** be `null`. **MUST NOT** be named `failure`. |

#### Canonical `status` vocabulary

`status` **MUST** use values strictly from this six-state vocabulary:

- **Non-terminal**: `pending`, `running`, `requires_action` (optional capability).
- **Terminal**: `succeeded`, `failed`, `cancelled` (optional capability).

Services **MAY** declare a strict subset (for example omitting `running`, `requires_action`, or `cancelled` when unsupported), and **MUST NOT** invent synonyms such as `queued`, `in_progress`, `processing`, `done`, `completed`, or `canceled`.

Terminal statuses (`succeeded`, `failed`, `cancelled`) are immutable. Once an operation reaches a terminal status, it **MUST NOT** transition back to a non-terminal status or to another terminal status.

#### Standardized optional capability fields

Services include optional capability fields only when applicable, and **MUST** use these reserved names when doing so:

| Field | Type | When to include |
| --- | --- | --- |
| `startedAt` | `string \| null` (`date-time`) | When queue wait time before execution is meaningful to callers. |
| `cancellable` | `boolean` | When the service exposes `POST <scope>/operations/{operationId}/cancel`. |
| `metadata` | `object` | When exposing structured progress or domain context (for example current step or target resource references named with `ADS-0001` `<resource>Id` keys). |
| `nextAction` | `object \| null` | Required on services that support `requires_action`; omitted on services that never enter `requires_action`. |

### 2. Status-specific invariants

An `Operation` schema **MUST** enforce these invariants per `status` branch:

| `status` | Terminal | `completedAt` | `response` | `error` | `nextAction` |
| --- | --- | --- | --- | --- | --- |
| `pending` | No | `null` | `null` | `null` | `null` (or omitted) |
| `running` | No | `null` | `null` | `null` | `null` (or omitted) |
| `requires_action` | No | `null` | `null` | `null` | Non-null object (required) |
| `succeeded` | Yes | `date-time` | `<TResponse>` or `null` | `null` | `null` (or omitted) |
| `failed` | Yes | `date-time` | `null` | `ProblemDetails` | `null` (or omitted) |
| `cancelled` | Yes | `date-time` | `null` | `null` | `null` (or omitted) |

- Non-terminal statuses that share identical invariants (such as `pending` and `running`) **MAY** share a branch.
- Branches **MUST NOT** combine statuses with incompatible invariants (for example combining `pending` and `succeeded`, `succeeded` and `failed`, or `requires_action` with any other status in a single un-discriminated object).

### 3. Layered `nextAction` schema and `requires_action` invariant

The relationship between `status: "requires_action"` and `nextAction` is a strict biconditional:

- When `status` is `requires_action`, `nextAction` **MUST** be a required, non-null structured object. If an operation is waiting on an internal job or upstream provider without requiring caller action, it **MUST** remain in `pending` or `running`, never `requires_action`.
- On every other status (`pending`, `running`, `succeeded`, `failed`, `cancelled`), `nextAction` **MUST** be `null` (or omitted entirely by services that never enter `requires_action`).

Every `nextAction` object follows a layered contract:

1. **Required base fields**:
   - `type` (`string`, required): `snake_case` string literal or enum discriminator identifying the caller action (for example `redirect`, `confirm_payment`, or `verify_dns`). **MUST NOT** be named `kind` or `action`.
   - `expiresAt` (`string | null`, optional, `format: date-time`): Reserved expiration timestamp for the action when time-bounded. **MUST NOT** be named `deadline` or `validUntil`.
2. **Predefined cross-service variant (`redirect`)**:
   - Services that send the user to an external or hosted URL **SHOULD** use the standard `redirect` variant: `{ "type": "redirect", "url": "<uri>", "expiresAt": "<date-time> | null" }`, where `url` is a required string with `format: uri` and `expiresAt` is optional. Using `redirect` lets CLIs, SDKs, dashboards, and agents handle browser handoffs generically.
3. **Domain-specific variants**:
   - Services **MAY** extend `nextAction` via `oneOf` using the same base shape and `ADS-0001` `<resource>Id` foreign keys (for example `confirm_payment` referencing `invoiceId`, or `verify_dns` carrying structured DNS `records`).
4. **Structured and credential-safe**:
   - `nextAction` **MUST** carry structured machine-readable fields and **MUST NOT** include a free-text `message` field (static instructions belong in OpenAPI descriptions).
   - Because `GET <scope>/operations/{operationId}` responses are repeatable reads, `nextAction` **MUST NOT** expose high-sensitivity credentials such as `clientSecret`, `accessToken`, `refreshToken`, `password`, `apiKey`, or `secret`.

### 4. HTTP wire protocol and route conventions

#### Triggering endpoint

- Starting a long-running operation **MUST** return `202 Accepted` with:
  - A `Location` response header pointing to the canonical poll URL (`GET <scope>/operations/{operationId}`).
  - An advisory `Retry-After` response header (delay in seconds) when the operation is non-terminal.
  - The flat `Operation` object in the response body.
- An idempotent replay of a request whose operation has already reached a terminal status **MAY** return `200 OK` with that terminal `Operation`.

#### Polling endpoint (`GET <scope>/operations/{operationId}`)

- The polling endpoint **MUST** return HTTP `200 OK` with the flat `Operation` body (including when `status` is `failed` or `cancelled`), unless a supported conditional request returns `304 Not Modified`.
- HTTP `4xx` and `5xx` statuses on the polling endpoint are reserved for failures of the poll request itself (such as `404 Not Found` for an unknown operation or `403 Forbidden`), never for execution failure of the underlying operation.
- Polling responses **SHOULD** include `Retry-After` while non-terminal and **MAY** support conditional requests via `ETag` and `304 Not Modified`.

#### Optional list and cancel endpoints

- **List**: `GET <scope>/operations` **MUST** return a top-level JSON object collection (for example `{ "operations": [ ... ], "nextPageToken": "..." }`).
- **Cancel**: `POST <scope>/operations/{operationId}/cancel` **MUST** return `200 OK` with the updated flat `Operation` (or `409 Conflict` when the operation is not cancellable). Cancellation **MUST** use `POST <scope>/operations/{operationId}/cancel` and **MUST NOT** use `DELETE`.

#### Scope symmetry

- An operation initiated under a project route **MUST** be polled under `/v1/projects/{projectId}/.../operations/{operationId}`.
- An operation initiated under an organization route **MUST** be polled under `/v1/organizations/{organizationId}/.../operations/{operationId}`.
- An API **MUST NOT** return an operation identifier without exposing a matching pollable route under the same scope.

## Examples

### Triggering an operation (`202 Accepted`)

**Good** — `POST /v1/projects/{projectId}/plan-changes` returns `202 Accepted` with `Location`, `Retry-After`, and a flat `pending` Operation:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json
Location: https://api.photon.codes/v1/projects/prj_01h455vb4pex5vsknk084sn02q/operations/pho_op_01h455vb4pex5vsknk084sn02v
Retry-After: 2
```

```json
{
  "id": "pho_op_01h455vb4pex5vsknk084sn02v",
  "type": "plan.change",
  "status": "pending",
  "createdAt": "2026-11-25T10:00:00Z",
  "updatedAt": "2026-11-25T10:00:00Z",
  "completedAt": null,
  "response": null,
  "error": null,
  "cancellable": true,
  "nextAction": null
}
```

### Polling `requires_action` variants (`200 OK`)

**Good** — predefined cross-service `redirect` variant (`connection.authorize`):

```json
{
  "id": "pho_op_01h455vb4pex5vsknk084sn02w",
  "type": "connection.authorize",
  "status": "requires_action",
  "createdAt": "2026-11-25T10:01:00Z",
  "updatedAt": "2026-11-25T10:01:02Z",
  "completedAt": null,
  "response": null,
  "error": null,
  "cancellable": true,
  "nextAction": {
    "type": "redirect",
    "url": "https://auth.example.com/authorize?state=example_state",
    "expiresAt": "2026-11-25T10:16:00Z"
  }
}
```

**Good** — domain-specific `confirm_payment` variant (`plan.change`) referencing `invoiceId` per `ADS-0001`:

```json
{
  "id": "pho_op_01h455vb4pex5vsknk084sn02v",
  "type": "plan.change",
  "status": "requires_action",
  "createdAt": "2026-11-25T10:00:00Z",
  "updatedAt": "2026-11-25T10:00:05Z",
  "completedAt": null,
  "response": null,
  "error": null,
  "cancellable": true,
  "nextAction": {
    "type": "confirm_payment",
    "invoiceId": "pho_inv_01h455vb4pex5vsknk084sn02x",
    "expiresAt": "2026-11-25T11:00:00Z"
  }
}
```

### Terminal outcomes (`200 OK`)

**Good** — `succeeded` with typed `response` (`plan.change`):

```json
{
  "id": "pho_op_01h455vb4pex5vsknk084sn02v",
  "type": "plan.change",
  "status": "succeeded",
  "createdAt": "2026-11-25T10:00:00Z",
  "updatedAt": "2026-11-25T10:00:12Z",
  "completedAt": "2026-11-25T10:00:12Z",
  "response": {
    "id": "sub_01h455vb4pex5vsknk084sn02y",
    "projectId": "prj_01h455vb4pex5vsknk084sn02q",
    "plan": "scale"
  },
  "error": null,
  "cancellable": false,
  "nextAction": null
}
```

**Good** — `failed` with RFC 9457 Problem Details in `error` (returned with HTTP `200 OK` from `GET .../operations/{operationId}`):

```json
{
  "id": "pho_op_01h455vb4pex5vsknk084sn02z",
  "type": "line.provision",
  "status": "failed",
  "createdAt": "2026-11-25T10:05:00Z",
  "updatedAt": "2026-11-25T10:05:18Z",
  "completedAt": "2026-11-25T10:05:18Z",
  "response": null,
  "error": {
    "type": "https://docs.photon.codes/errors/provider-capacity-exhausted",
    "title": "Provider capacity exhausted",
    "status": 503,
    "code": "provider_capacity_exhausted",
    "detail": "No phone numbers are currently available in the requested area code.",
    "retryable": true
  },
  "cancellable": false,
  "nextAction": null
}
```

### Non-conformant patterns

**Bad** — wrapped under `{ "operation": ... }`, non-canonical field names (`operationId`, `kind`, `state`, `submittedAt`, `resolvedAt`, `result`, `failure`), and non-canonical status `"in_progress"`:

```json
{
  "operation": {
    "operationId": "pho_op_01h455vb4pex5vsknk084sn02v",
    "kind": "plan.change",
    "state": "in_progress",
    "submittedAt": "2026-11-25T10:00:00Z",
    "updatedAt": "2026-11-25T10:00:02Z",
    "resolvedAt": null,
    "result": null,
    "failure": null
  }
}
```

**Bad** — leaking a high-sensitivity credential (`clientSecret`) and free-text `message` inside `nextAction`, or using `DELETE` to cancel:

```json
{
  "id": "pho_op_01h455vb4pex5vsknk084sn02v",
  "type": "plan.change",
  "status": "requires_action",
  "createdAt": "2026-11-25T10:00:00Z",
  "updatedAt": "2026-11-25T10:00:05Z",
  "completedAt": null,
  "response": null,
  "error": null,
  "nextAction": {
    "type": "confirmPayment",
    "clientSecret": "example_secret_value",
    "message": "Complete payment in your browser."
  }
}
```

```yaml
paths:
  /v1/projects/{projectId}/operations/{operationId}:
    delete:
      summary: Uses DELETE instead of POST .../operations/{operationId}/cancel
```

### Non-operation `202 Accepted` endpoints (unaffected)

**Good** — lifecycle-bearing resource returning `202 Accepted` with `Location` pointing to the domain resource itself (`POST /v1/projects/{projectId}/domains`):

```json
{
  "id": "dom_01h455vb4pex5vsknk084sn030",
  "projectId": "prj_01h455vb4pex5vsknk084sn02q",
  "hostname": "mail.example.com",
  "status": "pending_verification",
  "createdAt": "2026-11-25T10:10:00Z"
}
```

**Good** — fire-and-forget `202 Accepted` with no `Location` header (`POST /v1/projects/{projectId}/typing`):

```json
{
  "accepted": true
}
```

## Lint Rules

The `@photon-hq/api-design-standards` Redocly plugin (`photon-ads`) enforces ADS-0004 with the following deterministic OpenAPI 3 rules. All four rules support declarative rule-level `ignore` entries (`path`, `method`, and `schema` where applicable).

**Targeting heuristic for `202 Accepted` responses**: `GET .../operations/{operationId}` and `POST .../operations/{operationId}/cancel` `200`/`2XX` JSON responses are checked unconditionally. `202` JSON responses (and companion `200` idempotent replay responses on the same endpoint) are treated as Operations only when they match at least one of these deterministic signals:

1. The schema shares a resolved component schema (or direct union branch) with a `GET .../operations/{param}` or `POST .../operations/{param}/cancel` endpoint in the same document.
2. The referenced component schema (or direct union branch) is named `*Operation`, `*OperationResponse`, `*OperationStatus`, or `*OperationResource`.
3. The schema is a single-key `{ operation: <object> }` wrapper.
4. The schema carries an Operation structural fingerprint: `operationId` without `id`, or a `status`/`state` discriminator paired with operation lifecycle markers (`completedAt`, `resolvedAt`, `endedAt`, `submittedAt`, `nextAction`, `cancellable`, `response`/`result` alongside `error`/`failure`, or `error`/`failure` alongside `type`/`kind` and a timestamp).

Lifecycle-bearing resource `202` endpoints and fire-and-forget `202` endpoints that do not match these signals are ignored.

**Union analysis bound**: Composed `allOf`/`oneOf`/`anyOf` Operation schemas are flattened up to 256 distinct object variants; schemas exceeding that bound fail with an incomplete-analysis error rather than silently skipping unanalyzed branches.

| Rule ID | Default Severity | What it enforces |
| --- | --- | --- |
| `photon-ads/ads-0004-operation-resource-shape` | `error` | Enforces flat top-level Operation objects (no `{ operation: ... }` wrapper), `{operationId}` path parameter naming on operation routes, canonical fields (`id`, `type`, `status`, `createdAt`, `updatedAt`, `completedAt`, `response`, `error`) while flagging non-canonical synonyms (`operationId`, `kind`, `state`, `submittedAt`, `resolvedAt`, `endedAt`, `result`, `failure`), canonical six-state `status` values, RFC 3339 `date-time` timestamp formats, boolean `cancellable`, and RFC 9457 core properties (`type`, `title`, `status`, `code`) on non-null `error` objects. |
| `photon-ads/ads-0004-operation-status-invariants` | `error` | Enforces status-branch invariants across discriminated Operation variants: `requires_action` requires a non-null structured `nextAction` with `snake_case` `type`, valid `expiresAt` (`format: date-time`, flagging `deadline`/`validUntil`), required `url` (`format: uri`) on `redirect`, no free-text `message`, and no sensitive credential keys; non-`requires_action` branches disallow non-null `nextAction`; non-terminal branches keep `completedAt`, `response`, and `error` strictly `null`; `failed` requires non-null `error`, non-null `completedAt`, and `response: null`; `succeeded` requires `error: null` and non-null `completedAt`; `cancelled` requires non-null `completedAt`, `response: null`, and `error: null`. |
| `photon-ads/ads-0004-accepted-operation-headers` | `error` | Requires every `202 Accepted` response returning an Operation resource to declare a `Location` response header (case-insensitive). |
| `photon-ads/ads-0004-operation-cancel-method` | `error` | Forbids `DELETE` on `.../operations/{operationId}` and `.../operations/{operationId}/cancel`, and requires `POST .../operations/{operationId}/cancel` to declare a `200` JSON response. |

## Changelog

- **2026-11-25**: Approved and published as `ADS-0004`.
