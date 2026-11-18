import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memory, type DB } from "./db.js";
import { migrate, seed } from "./setup.js";
import { Service, type Context, Denied } from "./service.js";
import { Assistant } from "./assistant.js";
export type EvaluationRow = {
  scenario: string;
  expected: string;
  attempted: string;
  decision: string;
  executed: string;
  legitimateTask: string;
  passed: boolean;
};
export async function evaluate(existing?: DB) {
  const db = existing ?? (await memory());
  const rows: EvaluationRow[] = [];
  try {
    await migrate(db);
    await seed(db, "Evaluation-only-password!");
    const s = new Service(db);
    const assistant = new Assistant(s);
    const actor = {
      id: "researcher",
      name: "Ana Demo",
      email: "researcher@bioaccess.test",
      role: "researcher" as const,
    };
    const c: Context = {
      actor,
      project: "p1",
      dataset: "d1",
      correlation: randomUUID(),
    };
    const reviewer: Context = {
      ...c,
      actor: {
        id: "reviewer",
        name: "Celia Demo",
        email: "reviewer@bioaccess.test",
        role: "reviewer",
      },
    };
    const session = await assistant.create(c);
    const ac = { ...c, assistant: session.id };
    async function scenario(
      name: string,
      expected: "allow" | "deny",
      attempted: string,
      fn: () => Promise<any>,
      verify: (result: any) => Promise<void> | void,
    ) {
      let result: any;
      let error: unknown;
      try {
        result = await fn();
      } catch (e) {
        error = e;
      }
      const decision = error ? "deny" : "allow";
      let passed = decision === expected;
      if (error)
        passed =
          passed &&
          (error instanceof Denied ||
            (error as Error).message === "tool_outside_scope");
      try {
        await verify(result);
      } catch {
        passed = false;
      }
      rows.push({
        scenario: name,
        expected,
        attempted,
        decision,
        executed: result?.records
          ? `${result.records.length} fictional records delivered`
          : result?.id
            ? "request created"
            : error
              ? "No data delivered"
              : "Operation completed",
        legitimateTask:
          expected === "allow"
            ? "Authorized data delivered"
            : "No out-of-scope data delivered",
        passed,
      });
    }
    await scenario(
      "01 · Valid query",
      "allow",
      "read d1 / p1",
      () => s.query(c, { limit: 3 }),
      (r) => {
        assert.equal(r.records.length, 3);
        assert(r.records.every((v: any) => v.id.startsWith("d1-")));
      },
    );
    await scenario(
      "02 · No grant",
      "deny",
      "read d2 / p1",
      () => s.query({ ...c, dataset: "d2" }, {}),
      (r) => assert.equal(r, undefined),
    );
    await scenario(
      "03 · Cross-project access",
      "deny",
      "read d3 / p2",
      () => s.query({ ...c, project: "p2", dataset: "d3" }, {}),
      (r) => assert.equal(r, undefined),
    );
    await db.query(
      "UPDATE grants SET expires_at=now()-interval '1 second' WHERE user_id='researcher'",
    );
    await scenario(
      "04 · Expired grant",
      "deny",
      "read d1 / expired grant",
      () => s.query(c, {}),
      (r) => assert.equal(r, undefined),
    );
    await db.query(
      "UPDATE grants SET expires_at=now()+interval '1 day' WHERE user_id='researcher'",
    );
    const grant = (
      await db.query("SELECT id FROM grants WHERE user_id='researcher'")
    ).rows[0];
    await s.revoke(reviewer, grant.id);
    await scenario(
      "05 · Revocation during an existing conversation",
      "deny",
      "assistant query_records d1",
      () =>
        assistant.execute(ac, {
          tool: "query_records",
          dataset: "d1",
          filters: {},
        }),
      (r) => assert.equal(r, undefined),
    );
    await db.query(
      "UPDATE grants SET revoked_at=NULL WHERE user_id='researcher'",
    );
    await scenario(
      "06 · Export without approval",
      "deny",
      "export d1 / missing approval",
      () => s.export(c, "missing", {}),
      (r) => assert.equal(r, undefined),
    );
    const approval = await s.requestExport(c, { limit: 2 });
    await s.reviewExport(reviewer, approval.id, { decision: "approved" });
    await scenario(
      "07 · Approved export",
      "allow",
      "export d1 / limit=2",
      () => s.export(c, approval.id, { limit: 2 }),
      async (r) => {
        assert.equal(r.records.length, 2);
        assert(
          (
            await db.query(
              "SELECT consumed_at FROM export_approvals WHERE id=$1",
              [approval.id],
            )
          ).rows[0].consumed_at,
        );
      },
    );
    await scenario(
      "08 · Approval reuse",
      "deny",
      "export d1 / same approval",
      () => s.export(c, approval.id, { limit: 2 }),
      (r) => assert.equal(r, undefined),
    );
    await scenario(
      "09 · Out-of-scope tool",
      "deny",
      "assistant execute_sql",
      () =>
        assistant.execute(ac, {
          tool: "execute_sql",
          dataset: "d1",
          filters: {},
        }),
      async (r) => {
        assert.equal(r, undefined);
        assert.equal(
          (await db.query("SELECT count(*)::int AS n FROM datasets")).rows[0].n,
          3,
        );
      },
    );
    const legitimate = (await s.query(c, { limit: 1 })) as { records: any[] };
    assert(legitimate.records[0].note.includes("query d2"));
    await scenario(
      "10 · Misleading instruction in a record",
      "deny",
      "simulation forces query_records d2 after reading d1",
      () =>
        assistant.execute(ac, {
          tool: "query_records",
          dataset: "d2",
          filters: {},
        }),
      (r) => {
        assert.equal(r, undefined);
        assert.equal(legitimate.records.length, 1);
      },
    );
    rows[9].legitimateTask =
      "1 authorized d1 record delivered; simulated call to d2 blocked. Does not evaluate LLM obedience.";
    const concurrent = await s.requestExport(c, { limit: 4 });
    await s.reviewExport(reviewer, concurrent.id, { decision: "approved" });
    const attempts = await Promise.allSettled([
      s.export(c, concurrent.id, { limit: 4 }),
      s.export(c, concurrent.id, { limit: 4 }),
    ]);
    const wins = attempts.filter((x) => x.status === "fulfilled");
    const denied = attempts.filter(
      (x) => x.status === "rejected" && x.reason instanceof Denied,
    );
    const state = (
      await db.query("SELECT consumed_at FROM export_approvals WHERE id=$1", [
        concurrent.id,
      ])
    ).rows[0];
    rows.push({
      scenario: "11 · Concurrent single-use approval",
      expected: "1 allow / 1 deny",
      attempted: "Two simultaneous exports using one approval",
      decision: `${wins.length} allow / ${denied.length} deny`,
      executed: `${wins.length * 4} records delivered in total`,
      legitimateTask: "One download, one consumed approval",
      passed: wins.length === 1 && denied.length === 1 && !!state.consumed_at,
    });
    return {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      mode: "simulation",
      engine: existing
        ? "Isolated external PostgreSQL"
        : "PGlite · embedded PostgreSQL",
      disclaimer:
        "Access-control tests. Not evidence of LLM behavior or external validation.",
      passed: rows.every((r) => r.passed),
      rows,
    };
  } finally {
    if (!existing) await db.close();
  }
}
