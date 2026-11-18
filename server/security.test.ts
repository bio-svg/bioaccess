import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./evaluation.js";
import { memory } from "./db.js";
import { migrate, seed } from "./setup.js";
import { app } from "./app.js";
import { Service, Denied, type Context } from "./service.js";
import { Assistant } from "./assistant.js";
test("10 authorization scenarios and concurrent export", async () => {
  const report = await evaluate();
  assert.equal(report.rows.length, 11);
  for (const row of report.rows) assert(row.passed, JSON.stringify(row));
});
test("exact scope, grants, audit log, and assistant limits", async () => {
  const db = await memory();
  try {
    await migrate(db);
    await seed(db, "Only-test-password!");
    const s = new Service(db);
    const c: Context = {
      actor: {
        id: "researcher",
        name: "Test",
        email: "researcher@bioaccess.test",
        role: "researcher",
      },
      project: "p1",
      dataset: "d1",
      correlation: "test",
    };
    const reviewer = {
      ...c,
      actor: { ...c.actor, id: "reviewer", role: "reviewer" as const },
    };
    const a = await s.requestExport(c, { site: "North", limit: 2 });
    await s.reviewExport(reviewer, a.id, { decision: "approved" });
    await assert.rejects(
      s.export(c, a.id, { site: "South", limit: 2 }),
      Denied,
    );
    assert.equal(
      (
        await db.query("SELECT consumed_at FROM export_approvals WHERE id=$1", [
          a.id,
        ])
      ).rows[0].consumed_at,
      null,
    );
    assert.equal(
      (await s.export(c, a.id, { site: "North", limit: 2 })).records.length,
      2,
    );
    const expired = await s.requestExport(c, {});
    await s.reviewExport(reviewer, expired.id, { decision: "approved" });
    await db.query(
      "UPDATE export_approvals SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [expired.id],
    );
    await assert.rejects(s.export(c, expired.id, {}), Denied);
    await db.query(
      "UPDATE grants SET operations='[\"read\"]' WHERE user_id='researcher'",
    );
    await assert.rejects(s.query(c, {}, true), Denied);
    await assert.rejects(db.query("DELETE FROM audit_events"));
    assert(
      (await db.query("SELECT id FROM audit_events WHERE outcome='deny'")).rows
        .length >= 3,
    );
    const assistant = new Assistant(s);
    const session = await assistant.create(c);
    for (let i = 0; i < 20; i++)
      await assistant.message(c, session.id, {
        message: "list",
        dataset: "d1",
      });
    await assert.rejects(
      assistant.message(c, session.id, { message: "list", dataset: "d1" }),
      Denied,
    );
    await db.query(
      "UPDATE memberships SET active=false WHERE user_id='researcher'",
    );
    await assert.rejects(s.query(c, {}), Denied);
  } finally {
    await db.close();
  }
});
test("HTTP: session, CSRF, validation, and untrusted roles", async () => {
  const db = await memory();
  await migrate(db);
  await seed(db, "Only-test-password!");
  const server = app(db).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}/api`;
  try {
    const anon = await fetch(base + "/projects");
    assert.equal(anon.status, 401);
    const login = await fetch(base + "/login", {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: "researcher@bioaccess.test",
        password: "Only-test-password!",
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert(login.headers.get("set-cookie")!.includes("HttpOnly"));
    const { csrf } = (await login.json()) as any;
    const query = base + "/projects/p1/datasets/d1/query";
    const headers = {
      origin: "http://localhost:5173",
      cookie,
      "content-type": "application/json",
      "x-csrf-token": csrf,
    };
    assert.equal(
      (
        await fetch(query, {
          method: "POST",
          headers: {
            cookie,
            origin: headers.origin,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(query, { method: "POST", headers, body: "{}" })).status,
      200,
    );
    assert.equal(
      (
        await fetch(query, {
          method: "POST",
          headers,
          body: JSON.stringify({ role: "admin", user_id: "admin" }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(base + "/admin", { headers: { cookie } })).status,
      403,
    );
    assert.equal(
      (
        await fetch(query, {
          method: "POST",
          headers: { ...headers, origin: "https://evil.test" },
          body: "{}",
        })
      ).status,
      403,
    );
    await fetch(base + "/logout", { method: "POST", headers, body: "{}" });
    assert.equal(
      (await fetch(base + "/me", { headers: { cookie } })).status,
      401,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  }
});
