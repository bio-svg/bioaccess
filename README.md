# BioAccess

A research prototype for evaluating delegated access to fictional datasets. Researchers request permissions, human reviewers approve or reject them, and the backend checks every direct or assistant operation. **Not certified for sensitive biological data.** BioAccess applies human-configured policies; it does not classify biological risk.

**Stack:** React, TypeScript, Vite, Express, PostgreSQL, and Zod. The default assistant is a deterministic simulation with no API keys or inference costs. All sample records are invented: no real personal information or biological sequences.

## Run with Docker Compose

Requirements: Docker Engine/Desktop with Compose. From this repository:

```sh
cp .env.example .env
# Windows PowerShell: Copy-Item .env.example .env
# Edit DEMO_PASSWORD: use a password exclusively for this demonstration.
docker compose up --build
```

Open **http://localhost:3000**. Compose waits for PostgreSQL, applies the migration, runs the development seed, and starts Express with the compiled frontend. Database and HTTP ports bind to localhost. No AWS resources are created.

Seed accounts all use the value set in `DEMO_PASSWORD`:

| Account                     | Role          | Project        |
| --------------------------- | ------------- | -------------- |
| `researcher@bioaccess.test` | Researcher    | Atlas (`p1`)   |
| `colleague@bioaccess.test`  | Researcher    | Horizon (`p2`) |
| `reviewer@bioaccess.test`   | Reviewer      | Atlas (`p1`)   |
| `admin@bioaccess.test`      | Administrator | Both           |

The seed hashes passwords using scrypt with random salts. It requires `ALLOW_DEV_SEED=true`, a non-production `NODE_ENV`, and a password of at least 12 characters. It is idempotent: existing passwords, grants, and revocations are not reset.

## Develop with PostgreSQL

Requirements: Node **22.12+**, npm, and PostgreSQL 16 (local or Docker).

```sh
npm ci
cp .env.example .env
docker compose up -d db
npm run migrate
npm run seed
npm run dev
```

Frontend: **http://localhost:5173**; API: port 3000. Vite proxies `/api`. `APP_ORIGIN` must exactly match the browser origin. Using `127.0.0.1` instead of `localhost` requires changing this variable. To serve the built frontend with `npm start`, first run `npm run build` and set `APP_ORIGIN=http://localhost:3000`.

## Disposable demo without Docker

An optional **development-only, in-memory demo** uses PGlite (embedded PostgreSQL). It is not a substitute for the persistent PostgreSQL server setup. Changes disappear when the process stops.

```sh
npm ci
cp .env.example .env
# In .env, set APP_ORIGIN=http://localhost:3000
npm run build
npm run demo
```

Open **http://localhost:3000**. The demo seeds fictional data, runs an isolated evaluation of the actual authorization controls, and makes its report available in the Evaluation panel. New users, grants, sessions, and audit events are discarded on shutdown.

## Demo walkthrough

1. Sign in as `researcher`. Atlas has two datasets. **Reference samples (`d1`)** allows querying, summaries, and requesting exports for seven days. **Comparison measurements (`d2`)** requires access. A third dataset, `d3`, belongs to Horizon.
2. Request access to `d2`, explain the purpose, and choose operations. Include `export` to test the complete export workflow.
3. In a separate browser session, sign in as `reviewer`. Under **Requests**, approve access for seven days or reject it. Users cannot approve their own requests.
4. Return to the researcher, refresh Requests, and query `d2` in **Explorer**. Filters include site, minimum, maximum, and record limit (up to 50). Membership alone does not grant content access.
5. In **Assistant**, select a dataset and try `list datasets`, `query records`, `summarize`, or `request export`. Responses are labeled **DETERMINISTIC SIMULATION**. It is not an LLM. Try `execute SQL` to see a blocked tool request.
6. Request an export from Explorer. The reviewer approves it for 15 minutes. Download JSON from Requests. The approval is bound to that user, project, dataset, and exact filters and can be consumed only once.
7. Revoke the grant as reviewer. Queries, summaries, and future downloads are blocked, including those in an existing assistant conversation. **Revocation cannot recover information already delivered.**
8. Inspect **Audit log**, filtering by `deny` or `records.read`, and **Evaluation**. Administrators can create users, projects, memberships, and fictional datasets, and disable accounts. They do not automatically receive content access.

## Verification and reproducible evaluation

```sh
npm run typecheck
npm test
npm run build
npm run evaluate
# Also save the report to the application database for the Evaluation panel:
npm run evaluate -- --save
```

With Compose running:

```sh
docker compose exec app npm run evaluate -- --save
```

Reports are written to `reports/evaluation.json` and can be downloaded from Evaluation. They record expected action, attempted action, control decision, actual effect, and legitimate task outcome. Tests inspect delivered rows and final approval state, not just response text.

`server/evaluation.ts` implements ten authorization scenarios plus a concurrency test. The misleading-instruction scenario reads an authorized record and deliberately invokes an unauthorized tool. This evaluates the control, **not an LLM's susceptibility to prompt injection**.

Tests use PGlite by default. To repeat the evaluation against a PostgreSQL server, set `TEST_DATABASE_URL` to an **empty, disposable database**, different from `DATABASE_URL`, and run `npm run evaluate`. Nonempty test databases are rejected. The evaluator does not delete or restore an existing database. This option checks concurrency across independent server connections.

Browser tests:

```sh
npx playwright install chromium
npm run build
npm run test:e2e
```

They start an isolated demo on port 3100, use researcher/reviewer/admin accounts, verify an actual JSON download and revocation during chat, and check the mobile layout. Screenshots and traces are generated in `reports/`. No AI provider is contacted.

## Security and limitations

- Identity and role come from validated PostgreSQL sessions. Cookies are HttpOnly, SameSite=Strict, Secure in production, and expire after eight hours. Random tokens are stored as hashes. Writes require a session-bound CSRF token and the exact configured origin. Password recovery, password changes, and MFA are not implemented.
- Central authorization in `server/service.ts` denies by default and checks membership, dataset scope, operation, expiry, and revocation. Export consumption is a conditional atomic UPDATE within a transaction with membership and grant locks.
- The assistant has four allowed tools and acts as the human user. No arbitrary SQL, shell, or model-selected URLs. Limits: 1,000 characters/message, one tool/message, 20 messages/session, 15 messages/minute/IP, 32 KiB/response, an eight-second execution budget, and a three-second provider timeout. No remote provider is implemented; `AssistantProvider` defines the extension contract.
- Audit events cannot be edited or deleted through the API; a trigger rejects UPDATE/DELETE. A database administrator can disable those protections: **this is not immutable storage**. Audit events exclude passwords, API keys, raw session tokens, full dataset contents, and chat text.
- Export permissions govern formal downloads. They cannot stop users copying records they can already view. This is not a data-exfiltration prevention system.
- See [verification notes](docs/verification.md) for results and known build-tool dependency alerts. The lockfile is included for reproducibility.
- Not implemented: tenant isolation, federated identity, DLP, full dataset lifecycle management, high availability, formal retention policies, or an independent security review.
- The proposed contribution is evaluating delegated access workflows for AI agents, **not inventing an identity system**. Validation with data stewards and specialists is pending; no external interviews or validation claims are implied.

## Repository layout

```text
server/          Express, sessions, policies, assistant, migration, seed, evaluation
web/             Responsive React interface
e2e/             Browser workflows
docs/            Architecture, threat model, verification
compose.yaml     Local application + PostgreSQL
```

No services or paid resources are deployed. A conceptual AWS mapping is included in the [architecture and threat model](docs/architecture.md).
