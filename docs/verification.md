# Delivery verification

Date: November 17, 2026. Environment: Windows, Node 22.21.0. Docker and PostgreSQL server were not installed in this environment.

## Checks performed

| Check                  | Result                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | Strict TypeScript check passed                                                                  |
| `npm run build`        | Vite frontend compiled                                                                          |
| `npm test`             | 3 backend test groups passed: authorization, approval state, HTTP sessions, CSRF, role spoofing |
| `npm run evaluate`     | 10 scenarios and 1 concurrency scenario passed                                                  |
| `npm run test:e2e`     | 2 Chromium browser workflows passed                                                             |
| Visual inspection      | Desktop and mobile catalog screenshots reviewed                                                 |
| `npm audit --omit=dev` | 0 reported runtime dependency vulnerabilities                                                   |

Browser tests use separate researcher/reviewer sessions. They verify an actual two-record JSON download, consumed approval, assistant query blocked after revocation, eleven-row evaluation table, and user creation by an administrator. Mobile layout is checked at 390 x 844 without document-level horizontal overflow.

Tests use PGlite, an embedded PostgreSQL engine. The concurrency test starts two operations together and checks one successful delivery and one consumption timestamp. **This does not replace independent PostgreSQL server connection testing.** `TEST_DATABASE_URL` supports that separate verification.

The test server is local and its data is discarded. No AWS, remote models, external API keys, or real datasets are used. Regenerable artifacts in `reports/` are excluded from Git.

## Pending checks and known limitations

- Docker Compose was not executed because Docker is unavailable here. Container startup and PostgreSQL 16 server behavior still need verification.
- No real model or its reaction to misleading instructions was evaluated; only the deterministic provider is implemented.
- No load test, penetration test, data-steward validation, or certification was performed.
- Full `npm audit` reports **4 high-severity transitive development-tool alerts** involving Vite's `picomatch`, `fdir`, and `tinyglobby` dependencies (GHSA-fc5q-39xc-vjpf). `npm audit fix` offered no compatible fix and suggested forcing a downgrade to Vite 6.2.7. That unvalidated downgrade was not applied. User-defined glob patterns are not exposed to the build, but this does not eliminate the alert. Review/update tooling before production use. Do not expose the development server publicly.
- The interface, demo data, simulated assistant commands, reports, browser tests, and documentation use English. The MVP pull request is separate from the earlier empty-README pull request.
