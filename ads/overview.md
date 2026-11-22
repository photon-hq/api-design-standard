---
title: "API Design Standards"
sidebarTitle: "Overview"
description: "Design conventions behind Photon's public HTTP APIs, why we publish them openly, and how to report inconsistencies."
---

# API Design Standards

**Photon API Design Standards (ADS)** are the public design conventions that govern how Photon structures resources, identifiers, URLs, payloads, and errors across its public HTTP APIs. Every standard published here is approved as a binding convention for new and redesigned Photon endpoints.

## Why We Publish These Standards

1. **Predictability across every API**: Once you integrate with one Photon endpoint, every other endpoint should follow the same conventions—whether you are calling the HTTP API directly, using an SDK, or building with an AI agent.
2. **Transparency and design discipline**: Putting our conventions in writing commits Photon to a consistent design bar as the platform grows, rather than letting endpoints drift ad hoc.
3. **Developer accountability**: Publishing our standards in the open gives developers a clear reference to hold us to whenever an endpoint does not match what we promise.

## Feedback & Reporting Issues

We do not accept external pull requests. Instead, please [open an issue in `photon-hq/api-design-standards`](https://github.com/photon-hq/api-design-standards/issues/new) if:

- You find any Photon API endpoint that does not follow these standards. Include the HTTP method, path, standard number (for example `ADS-0001`), and a sanitized or synthetic request or response example with any credentials, tokens, or sensitive customer data removed.
- You have a suggestion to improve an existing standard or want to propose a new convention we should standardize.
