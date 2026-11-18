import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { DB } from "./db.js";
import type { Actor } from "./auth.js";
export const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const operations = z
  .array(z.enum(["read", "summary", "export"]))
  .min(1)
  .max(3);
export const filters = z
  .object({
    site: z.enum(["North", "South"]).optional(),
    min: z.number().min(-1000).max(1000).optional(),
    max: z.number().min(-1000).max(1000).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine(
    (f) => f.min === undefined || f.max === undefined || f.min <= f.max,
    "Invalid range",
  );
export type Filters = z.infer<typeof filters>;
export type Context = {
  actor: Actor;
  project?: string;
  dataset?: string;
  assistant?: string;
  correlation: string;
  deadline?: number;
};
export class Denied extends Error {
  constructor(
    public reason: string,
    public status = 403,
  ) {
    super(reason);
  }
}
export function ensure(
  test: unknown,
  reason: string,
  status = 403,
): asserts test {
  if (!test) throw new Denied(reason, status);
}
export function paramsHash(f: Filters) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        site: f.site ?? null,
        min: f.min ?? null,
        max: f.max ?? null,
        limit: f.limit,
      }),
    )
    .digest("hex");
}
export class Service {
  constructor(public db: DB) {}
  async audit(
    c: Partial<Context>,
    action: string,
    outcome: string,
    reason: string,
    db = this.db,
  ) {
    await db.query(
      "INSERT INTO audit_events(id,actor_id,assistant_session_id,project_id,dataset_id,action,outcome,reason,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        randomUUID(),
        c.actor?.id ?? null,
        c.assistant ?? null,
        c.project ?? null,
        c.dataset ?? null,
        action,
        outcome,
        reason,
        c.correlation ?? randomUUID(),
      ],
    );
  }
  async run<T>(
    c: Context,
    action: string,
    fn: (t: DB) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.tx(async (t) => {
        if (c.deadline) {
          ensure(Date.now() < c.deadline, "assistant_time_limit", 408);
          await t.query("SELECT set_config('statement_timeout',$1,true)", [
            String(Math.max(1, c.deadline - Date.now())),
          ]);
        }
        const result = await fn(t);
        if (c.deadline)
          ensure(Date.now() < c.deadline, "assistant_time_limit", 408);
        await this.audit(c, action, "allow", "policy_satisfied", t);
        return result;
      });
    } catch (e) {
      await this.audit(
        c,
        action,
        "deny",
        e instanceof Denied
          ? e.reason
          : e instanceof z.ZodError
            ? "invalid_input"
            : "operation_failed",
      );
      throw e;
    }
  }
  async member(t: DB, c: Context) {
    const rows = (
      await t.query(
        "SELECT m.user_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.project_id=$2 AND m.active AND u.active FOR UPDATE OF m,u",
        [c.actor.id, c.project],
      )
    ).rows;
    ensure(rows.length, "project_membership_required");
  }
  async reviewer(t: DB, c: Context) {
    ensure(
      c.actor.role === "reviewer" || c.actor.role === "admin",
      "reviewer_required",
    );
    await this.member(t, c);
  }
  async authorize(t: DB, c: Context, op: string) {
    await this.member(t, c);
    ensure(
      (
        await t.query(
          "SELECT 1 FROM project_datasets WHERE project_id=$1 AND dataset_id=$2",
          [c.project, c.dataset],
        )
      ).rows.length,
      "dataset_not_in_project",
    );
    const g = (
      await t.query(
        "SELECT * FROM grants WHERE user_id=$1 AND project_id=$2 AND dataset_id=$3 FOR UPDATE",
        [c.actor.id, c.project, c.dataset],
      )
    ).rows[0];
    ensure(g, "grant_required");
    ensure(!g.revoked_at, "grant_revoked");
    ensure(new Date(g.expires_at).getTime() > Date.now(), "grant_expired");
    ensure(g.operations.includes(op), "operation_not_granted");
  }
  async catalog(c: Context) {
    return this.run(c, "catalog", async (t) => {
      await this.member(t, c);
      return (
        await t.query(
          `SELECT d.*,g.operations,g.expires_at,g.revoked_at FROM datasets d JOIN project_datasets pd ON pd.dataset_id=d.id LEFT JOIN grants g ON g.dataset_id=d.id AND g.project_id=pd.project_id AND g.user_id=$1 WHERE pd.project_id=$2 ORDER BY d.name`,
          [c.actor.id, c.project],
        )
      ).rows;
    });
  }
  async requestAccess(c: Context, body: unknown) {
    return this.run(c, "access.request", async (t) => {
      const b = z
        .object({ operations, reason: z.string().trim().min(8).max(500) })
        .strict()
        .parse(body);
      await this.member(t, c);
      ensure(
        (
          await t.query(
            "SELECT 1 FROM project_datasets WHERE project_id=$1 AND dataset_id=$2",
            [c.project, c.dataset],
          )
        ).rows.length,
        "dataset_not_in_project",
      );
      ensure(
        !(
          await t.query(
            "SELECT 1 FROM access_requests WHERE user_id=$1 AND project_id=$2 AND dataset_id=$3 AND status='pending'",
            [c.actor.id, c.project, c.dataset],
          )
        ).rows.length,
        "request_already_pending",
        409,
      );
      const id = randomUUID();
      await t.query(
        "INSERT INTO access_requests(id,user_id,project_id,dataset_id,operations,reason,status) VALUES($1,$2,$3,$4,$5,$6,'pending')",
        [
          id,
          c.actor.id,
          c.project,
          c.dataset,
          JSON.stringify([...new Set(b.operations)]),
          b.reason,
        ],
      );
      return { id };
    });
  }
  async reviewAccess(c: Context, id: string, body: unknown) {
    return this.run(c, "access.review", async (t) => {
      const b = z
        .object({
          decision: z.enum(["approved", "rejected"]),
          days: z.number().int().min(1).max(30).default(7),
        })
        .strict()
        .parse(body);
      await this.reviewer(t, c);
      const r = (
        await t.query(
          "SELECT * FROM access_requests WHERE id=$1 AND project_id=$2 FOR UPDATE",
          [id, c.project],
        )
      ).rows[0];
      ensure(r && r.status === "pending", "pending_request_required", 409);
      c.dataset = r.dataset_id;
      ensure(r.user_id !== c.actor.id, "cannot_review_own_request");
      if (b.decision === "approved") {
        ensure(
          (
            await t.query(
              "SELECT 1 FROM memberships WHERE user_id=$1 AND project_id=$2 AND active FOR UPDATE",
              [r.user_id, c.project],
            )
          ).rows.length,
          "applicant_membership_required",
        );
        await t.query(
          "INSERT INTO grants(id,user_id,project_id,dataset_id,operations,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,project_id,dataset_id) DO UPDATE SET operations=EXCLUDED.operations,expires_at=EXCLUDED.expires_at,revoked_at=NULL",
          [
            randomUUID(),
            r.user_id,
            c.project,
            r.dataset_id,
            JSON.stringify(r.operations),
            new Date(Date.now() + b.days * 86400000),
          ],
        );
      }
      await t.query(
        "UPDATE access_requests SET status=$1,reviewer_id=$2 WHERE id=$3",
        [b.decision, c.actor.id, id],
      );
      return { status: b.decision };
    });
  }
  async revoke(c: Context, id: string) {
    return this.run(c, "grant.revoke", async (t) => {
      await this.reviewer(t, c);
      const r = (
        await t.query(
          "UPDATE grants SET revoked_at=now() WHERE id=$1 AND project_id=$2 RETURNING id,dataset_id",
          [id, c.project],
        )
      ).rows;
      ensure(r.length, "grant_not_found", 404);
      c.dataset = r[0].dataset_id;
      return { revoked: true };
    });
  }
  async records(t: DB, c: Context, f: Filters) {
    return (
      await t.query(
        "SELECT id,site,value,unit,note FROM records WHERE dataset_id=$1 AND ($2::text IS NULL OR site=$2) AND ($3::float8 IS NULL OR value >= $3) AND ($4::float8 IS NULL OR value <= $4) ORDER BY id LIMIT $5",
        [c.dataset, f.site ?? null, f.min ?? null, f.max ?? null, f.limit],
      )
    ).rows;
  }
  async query(c: Context, raw: unknown, summary = false) {
    return this.run(
      c,
      summary ? "records.summary" : "records.read",
      async (t) => {
        const f = filters.parse(raw);
        await this.authorize(t, c, summary ? "summary" : "read");
        const records = await this.records(t, c, f);
        return summary
          ? {
              count: records.length,
              average: records.length
                ? records.reduce((n, r) => n + Number(r.value), 0) /
                  records.length
                : null,
              unit: "simulated units",
              fictional: true,
            }
          : { records, fictional: true };
      },
    );
  }
  async requestExport(c: Context, raw: unknown) {
    return this.run(c, "export.request", async (t) => {
      const f = filters.parse(raw);
      await this.authorize(t, c, "export");
      const id = randomUUID();
      await t.query(
        "INSERT INTO export_approvals(id,user_id,project_id,dataset_id,params,params_hash,status) VALUES($1,$2,$3,$4,$5,$6,'pending')",
        [
          id,
          c.actor.id,
          c.project,
          c.dataset,
          JSON.stringify(f),
          paramsHash(f),
        ],
      );
      return { id, status: "pending" };
    });
  }
  async reviewExport(c: Context, id: string, body: unknown) {
    return this.run(c, "export.review", async (t) => {
      const b = z
        .object({ decision: z.enum(["approved", "rejected"]) })
        .strict()
        .parse(body);
      await this.reviewer(t, c);
      const r = (
        await t.query(
          "SELECT * FROM export_approvals WHERE id=$1 AND project_id=$2 FOR UPDATE",
          [id, c.project],
        )
      ).rows[0];
      ensure(r && r.status === "pending", "pending_export_required", 409);
      c.dataset = r.dataset_id;
      ensure(r.user_id !== c.actor.id, "cannot_review_own_export");
      await t.query(
        "UPDATE export_approvals SET status=$1,reviewer_id=$2,expires_at=now()+interval '15 minutes' WHERE id=$3",
        [b.decision, c.actor.id, id],
      );
      return { status: b.decision };
    });
  }
  async export(c: Context, id: string, raw: unknown) {
    return this.run(c, "export.execute", async (t) => {
      const f = filters.parse(raw);
      await this.authorize(t, c, "export");
      const consumed = (
        await t.query(
          "UPDATE export_approvals SET consumed_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND project_id=$3 AND dataset_id=$4 AND params_hash=$5 AND status='approved' AND consumed_at IS NULL AND expires_at>clock_timestamp() RETURNING id",
          [id, c.actor.id, c.project, c.dataset, paramsHash(f)],
        )
      ).rows;
      ensure(consumed.length, "valid_unused_export_approval_required");
      const records = await this.records(t, c, f);
      return { records, fictional: true, approval: id };
    });
  }
  async overview(c: Context) {
    return this.run(c, "requests.list", async (t) => {
      await this.member(t, c);
      const review = c.actor.role === "reviewer" || c.actor.role === "admin";
      const access = (
        await t.query(
          "SELECT r.*,u.name AS applicant,d.name AS dataset_name FROM access_requests r JOIN users u ON u.id=r.user_id JOIN datasets d ON d.id=r.dataset_id WHERE r.project_id=$1 AND ($2::boolean OR r.user_id=$3) ORDER BY r.created_at DESC LIMIT 200",
          [c.project, review, c.actor.id],
        )
      ).rows;
      const exports = (
        await t.query(
          "SELECT e.*,u.name AS applicant,d.name AS dataset_name FROM export_approvals e JOIN users u ON u.id=e.user_id JOIN datasets d ON d.id=e.dataset_id WHERE e.project_id=$1 AND ($2::boolean OR e.user_id=$3) ORDER BY e.created_at DESC LIMIT 200",
          [c.project, review, c.actor.id],
        )
      ).rows;
      const grants = (
        await t.query(
          "SELECT g.*,u.name AS applicant,d.name AS dataset_name FROM grants g JOIN users u ON u.id=g.user_id JOIN datasets d ON d.id=g.dataset_id WHERE g.project_id=$1 AND ($2::boolean OR g.user_id=$3)",
          [c.project, review, c.actor.id],
        )
      ).rows;
      return { access, exports, grants };
    });
  }
  async auditList(c: Context, raw: unknown) {
    return this.run(c, "audit.list", async (t) => {
      await this.reviewer(t, c);
      const f = z
        .object({
          outcome: z.enum(["allow", "deny"]).optional(),
          action: z.string().max(80).optional(),
          actor: z.string().max(100).optional(),
          from: z.iso.datetime().optional(),
          to: z.iso.datetime().optional(),
        })
        .strict()
        .parse(raw);
      return (
        await t.query(
          "SELECT * FROM audit_events WHERE project_id=$1 AND ($2::text IS NULL OR outcome=$2) AND ($3::text IS NULL OR action=$3) AND ($4::text IS NULL OR actor_id=$4) AND ($5::timestamptz IS NULL OR created_at >= $5) AND ($6::timestamptz IS NULL OR created_at <= $6) ORDER BY created_at DESC LIMIT 200",
          [
            c.project,
            f.outcome ?? null,
            f.action ?? null,
            f.actor ?? null,
            f.from ?? null,
            f.to ?? null,
          ],
        )
      ).rows;
    });
  }
}
