# Architecture and threat model

## Trust boundaries

```text
React (untrusted)
  -> Express: session, origin, CSRF, Zod, request limits
    -> Service: membership + grant + operation + expiry + revocation
      -> PostgreSQL: transaction, conditional consumption, records, audit

Chat -> simulated provider -> untrusted plan -> tool dispatcher
     -> same Service, using the human identity and assistant session
```

There is one backend. PostgreSQL is the source of truth. Neither UI roles nor assistant response text prove authorization. Assistant sessions bind a human owner and project; each tool call rechecks ownership and current permissions. The provider has no database connection or administrator credentials.

## Data model

- `users`, `memberships`, `projects`: local identity and project scope. Disabling membership blocks future operations in that project.
- `datasets`, `project_datasets`, `records`: catalog metadata and fictional records. Catalog responses never include dataset rows.
- `access_requests`, `grants`: human-reviewed requests and user/project/dataset grants with operations, expiry, and revocation. New approvals replace the old operation set rather than silently accumulating privileges.
- `export_approvals`: normalized filters, SHA-256 parameter hash, scope, reviewer, status, expiry, and consumption timestamp. The API cannot change parameters after submission.
- `sessions`: token hashes, CSRF secrets, and expiry. Current identity and role are loaded on every request.
- `assistant_sessions`, `assistant_operations`: message budget and tool outcomes without conversation contents.
- `audit_events`: actor, project, dataset, action, outcome, reason, assistant session, and correlation ID. No mutation API and a defensive UPDATE/DELETE trigger.
- `evaluation_runs`: structured results of isolated executions, exportable as JSON.

## Authorization sequence

1. Validate session and active account; check CSRF and origin for writes.
2. Validate structured inputs and reject unknown fields.
3. Check active project membership and dataset assignment.
4. Check the specific grant, operation, expiry, and revocation.
5. For exports, require an unexpired, unused approval for the same actor, project, dataset, and parameter hash.
6. Read records, append audit events, and commit before returning data.

Memberships and grants are locked during the transaction. If an export obtains authorization locks first, a concurrent revocation waits and the already-authorized download may finish. If revocation commits first, subsequent exports are blocked. No delivered information can be retrieved or committed operations retroactively canceled.

Consumption uses `UPDATE ... WHERE consumed_at IS NULL ... RETURNING id`. A second transaction cannot consume the same approval. If retrieval or auditing fails before commit, consumption rolls back. Approval expiry uses PostgreSQL's current wall clock in the conditional UPDATE.

## Threats and controls

| Threat                                      | Control and limitation                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Forged `role` or `user_id`                  | Server session and strict schemas; frontend fields are never proof of authorization                               |
| Cross-project/dataset IDOR                  | Membership and scoped grants checked for every content operation                                                  |
| Existing assistant session after revocation | Tool-time revalidation, no authorization cache                                                                    |
| Instructions embedded in records            | Content is untrusted; the dispatcher and Service enforce effects independently of the plan                        |
| Unauthorized tools, SQL, SSRF               | Closed tool enum and Zod parameters; no shell, arbitrary code, or arbitrary fetch                                 |
| Export replay or race                       | Exact scope, expiry, transactional consumption, concurrent test                                                   |
| CSRF or stolen sessions                     | SameSite, HttpOnly, production Secure cookies, origin and CSRF validation; HTTPS and host security still required |
| XSS in dataset/chat text                    | React text escaping, no raw HTML, Helmet CSP                                                                      |
| Brute force/resource abuse                  | scrypt, per-IP limits, 16 KiB request bodies, bounded queries, chat budgets, SQL timeouts                         |
| Reviewer exceeds assigned scope             | Reviewer/admin role plus membership; no self-approval                                                             |
| Audit tampering                             | No mutation API and defensive trigger; does not protect against a privileged DBA or compromised host              |
| Copying delivered data                      | Out of scope: displayed records and downloaded files cannot be withdrawn                                          |

Rate limits are process-local, not distributed. `trust proxy` is disabled; deployment behind a proxy requires explicitly configured trusted networks. The Compose database account is development-only. Production needs separate migration/runtime database roles, least privilege, TLS, managed secrets, retention policies, and an independent review.

## Future AWS mapping (conceptual only)

| Local component                  | Possible AWS component                                                          |
| -------------------------------- | ------------------------------------------------------------------------------- |
| Static frontend                  | Private S3 bucket + CloudFront                                                  |
| Express                          | ECS/Fargate container behind ALB                                                |
| PostgreSQL                       | RDS PostgreSQL in private subnets                                               |
| Connection credentials           | Secrets Manager and container IAM role                                          |
| TLS / names                      | ACM and managed DNS                                                             |
| Operational logs without secrets | CloudWatch Logs with explicit retention                                         |
| Audit export                     | Separate retention-controlled storage; S3 Object Lock if justified              |
| Future identity                  | Existing IdP such as Cognito; retain project/operation authorization in backend |

No Terraform/CDK, AWS credentials, provisioning, or compliance claims are included. Consult data stewards, domain specialists, and security reviewers before deployment. Application logs are not regulatory immutability guarantees.

## Future real-model provider

`AssistantProvider` distinguishes `simulation` and `api`, but only simulation is implemented. A real adapter needs current official provider documentation, backend-only environment variables for key/model, request cancellation, validated output schemas, and the same tool boundary. Prompt-injection evaluation of an LLM requires a separate real-model run labeled with model/version. Do not extrapolate simulation results to real models.
