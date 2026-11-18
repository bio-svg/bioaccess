import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { DB } from "./db.js";
import {
  hashPassword,
  verifyPassword,
  hashToken,
  secret,
  type Actor,
} from "./auth.js";
import {
  Service,
  Denied,
  ensure,
  identifier,
  type Context,
} from "./service.js";
import { Assistant } from "./assistant.js";
type Authed = Request & {
  actor: Actor;
  csrf: string;
  sessionHash: string;
  correlation: string;
};
export function app(db: DB) {
  const app = express();
  const service = new Service(db);
  const assistant = new Assistant(service);
  const origin = process.env.APP_ORIGIN ?? "http://localhost:5173";
  const secure = process.env.NODE_ENV === "production";
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "16kb" }));
  app.use((req, res, next) => {
    (req as unknown as Authed).correlation = randomUUID();
    res.setHeader("X-Correlation-ID", (req as unknown as Authed).correlation);
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 180,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  app.use("/api", (req, _res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("origin") !== origin
    )
      return next(new Denied("origin_not_allowed"));
    next();
  });
  const cookie = {
    httpOnly: true,
    secure,
    sameSite: "strict" as const,
    path: "/api",
    maxAge: 8 * 3600000,
  };
  app.post(
    "/api/login",
    rateLimit({ windowMs: 60000, limit: 8 }),
    async (req, res) => {
      const b = z
        .object({
          email: z.email().max(200),
          password: z.string().min(1).max(200),
        })
        .strict()
        .parse(req.body);
      const u = (
        await db.query("SELECT * FROM users WHERE email=$1 AND active", [
          b.email.toLowerCase(),
        ])
      ).rows[0];
      // A dummy scrypt keeps unknown accounts on the same password-verification path.
      const ok = await verifyPassword(
        b.password,
        u?.password_hash ?? `${"0".repeat(32)}:${"0".repeat(128)}`,
      );
      if (!u || !ok) {
        await service.audit(
          { correlation: (req as unknown as Authed).correlation },
          "login",
          "deny",
          "invalid_credentials",
        );
        throw new Denied("invalid_credentials", 401);
      }
      const token = secret(),
        csrf = secret();
      await db.query(
        "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
        [hashToken(token), u.id, csrf],
      );
      const user = { id: u.id, name: u.name, email: u.email, role: u.role };
      await service.audit(
        { actor: user, correlation: (req as unknown as Authed).correlation },
        "login",
        "allow",
        "authenticated",
      );
      res.cookie("bioaccess_session", token, cookie).json({ user, csrf });
    },
  );
  app.use("/api", async (req, res, next) => {
    const token = (req.headers.cookie ?? "")
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith("bioaccess_session="))
      ?.slice(18);
    if (!token || !/^[a-f0-9]{64}$/.test(token))
      return next(new Denied("authentication_required", 401));
    const s = (
      await db.query(
        "SELECT u.id,u.name,u.email,u.role,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active",
        [hashToken(token)],
      )
    ).rows[0];
    if (!s) return next(new Denied("session_expired", 401));
    const r = req as Authed;
    r.actor = { id: s.id, name: s.name, email: s.email, role: s.role };
    r.csrf = s.csrf;
    r.sessionHash = hashToken(token);
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.get("x-csrf-token") !== s.csrf
    )
      return next(new Denied("csrf_invalid"));
    next();
  });
  const context = (req: Request): Context => {
    const r = req as Authed;
    return {
      actor: r.actor,
      correlation: r.correlation,
      project: req.params.project
        ? identifier.parse(req.params.project)
        : undefined,
      dataset: req.params.dataset
        ? identifier.parse(req.params.dataset)
        : undefined,
    };
  };
  app.get("/api/me", (req, res) =>
    res.json({
      user: (req as unknown as Authed).actor,
      csrf: (req as unknown as Authed).csrf,
    }),
  );
  app.post("/api/logout", async (req, res) => {
    await db.query("DELETE FROM sessions WHERE token_hash=$1", [
      (req as unknown as Authed).sessionHash,
    ]);
    await service.audit(context(req), "logout", "allow", "session_closed");
    res.clearCookie("bioaccess_session", cookie).json({ ok: true });
  });
  app.get("/api/projects", async (req, res) =>
    res.json(
      (
        await db.query(
          "SELECT p.* FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=$1 AND m.active ORDER BY p.name",
          [(req as unknown as Authed).actor.id],
        )
      ).rows,
    ),
  );
  app.get("/api/projects/:project/datasets", async (req, res) =>
    res.json(await service.catalog(context(req))),
  );
  app.post(
    "/api/projects/:project/datasets/:dataset/requests",
    async (req, res) =>
      res.status(201).json(await service.requestAccess(context(req), req.body)),
  );
  app.get("/api/projects/:project/requests", async (req, res) =>
    res.json(await service.overview(context(req))),
  );
  app.post("/api/projects/:project/requests/:id/review", async (req, res) =>
    res.json(
      await service.reviewAccess(
        context(req),
        identifier.parse(req.params.id),
        req.body,
      ),
    ),
  );
  app.post("/api/projects/:project/grants/:id/revoke", async (req, res) =>
    res.json(
      await service.revoke(context(req), identifier.parse(req.params.id)),
    ),
  );
  app.post("/api/projects/:project/datasets/:dataset/query", async (req, res) =>
    res.json(await service.query(context(req), req.body)),
  );
  app.post(
    "/api/projects/:project/datasets/:dataset/summary",
    async (req, res) =>
      res.json(await service.query(context(req), req.body, true)),
  );
  app.post(
    "/api/projects/:project/datasets/:dataset/exports",
    async (req, res) =>
      res.status(201).json(await service.requestExport(context(req), req.body)),
  );
  app.post("/api/projects/:project/exports/:id/review", async (req, res) =>
    res.json(
      await service.reviewExport(
        context(req),
        identifier.parse(req.params.id),
        req.body,
      ),
    ),
  );
  app.post(
    "/api/projects/:project/datasets/:dataset/exports/:id/download",
    async (req, res) => {
      const result = await service.export(
        context(req),
        identifier.parse(req.params.id),
        req.body,
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="bioaccess-fictional.json"',
      );
      res.json(result);
    },
  );
  app.get("/api/projects/:project/audit", async (req, res) =>
    res.json(await service.auditList(context(req), req.query)),
  );
  app.post("/api/projects/:project/assistant", async (req, res) =>
    res.status(201).json(await assistant.create(context(req))),
  );
  app.post(
    "/api/projects/:project/assistant/:id/messages",
    rateLimit({ windowMs: 60000, limit: 15 }),
    async (req, res) =>
      res.json(
        await assistant.message(
          context(req),
          identifier.parse(req.params.id),
          req.body,
        ),
      ),
  );
  const admin = async (
    req: Request,
    action: string,
    fn: (t: DB) => Promise<unknown>,
  ) =>
    service.run(context(req), action, async (t) => {
      ensure(
        (req as unknown as Authed).actor.role === "admin",
        "admin_required",
      );
      return fn(t);
    });
  app.get("/api/admin", async (req, res) =>
    res.json(
      await admin(req, "admin.list", async (t) => ({
        users: (
          await t.query(
            "SELECT id,name,email,role,active FROM users ORDER BY name",
          )
        ).rows,
        projects: (await t.query("SELECT * FROM projects ORDER BY name")).rows,
        datasets: (await t.query("SELECT * FROM datasets ORDER BY name")).rows,
        memberships: (await t.query("SELECT * FROM memberships")).rows,
      })),
    ),
  );
  app.post("/api/admin/users", async (req, res) =>
    res.status(201).json(
      await admin(req, "admin.user.create", async (t) => {
        const b = z
          .object({
            name: z.string().trim().min(2).max(100),
            email: z.email().max(200),
            password: z.string().min(12).max(128),
            role: z.enum(["researcher", "reviewer", "admin"]),
          })
          .strict()
          .parse(req.body);
        const id = randomUUID();
        await t.query(
          "INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)",
          [
            id,
            b.name,
            b.email.toLowerCase(),
            await hashPassword(b.password),
            b.role,
          ],
        );
        return { id };
      }),
    ),
  );
  app.post("/api/admin/users/:id", async (req, res) =>
    res.json(
      await admin(req, "admin.user.update", async (t) => {
        const b = z
          .object({
            active: z.boolean(),
            role: z.enum(["researcher", "reviewer", "admin"]),
          })
          .strict()
          .parse(req.body);
        ensure(
          req.params.id !== (req as unknown as Authed).actor.id,
          "cannot_change_own_account",
        );
        const result = await t.query(
          "UPDATE users SET active=$1,role=$2 WHERE id=$3 RETURNING id",
          [b.active, b.role, identifier.parse(req.params.id)],
        );
        ensure(result.rows.length, "user_not_found", 404);
        return result.rows[0];
      }),
    ),
  );
  app.post("/api/admin/projects", async (req, res) =>
    res.status(201).json(
      await admin(req, "admin.project.create", async (t) => {
        const b = z
          .object({
            name: z.string().min(2).max(100),
            description: z.string().max(500).default(""),
          })
          .strict()
          .parse(req.body);
        const id = randomUUID();
        await t.query("INSERT INTO projects VALUES($1,$2,$3)", [
          id,
          b.name,
          b.description,
        ]);
        await t.query("INSERT INTO memberships VALUES($1,$2,true)", [
          (req as unknown as Authed).actor.id,
          id,
        ]);
        return { id };
      }),
    ),
  );
  app.post("/api/admin/memberships", async (req, res) =>
    res.json(
      await admin(req, "admin.membership.update", async (t) => {
        const b = z
          .object({
            user: identifier,
            project: identifier,
            active: z.boolean(),
          })
          .strict()
          .parse(req.body);
        await t.query(
          "INSERT INTO memberships VALUES($1,$2,$3) ON CONFLICT(user_id,project_id) DO UPDATE SET active=EXCLUDED.active",
          [b.user, b.project, b.active],
        );
        return { ok: true };
      }),
    ),
  );
  app.post("/api/admin/datasets", async (req, res) =>
    res.status(201).json(
      await admin(req, "admin.dataset.create", async (t) => {
        const b = z
          .object({
            name: z.string().min(2).max(100),
            description: z.string().max(500),
            project: identifier,
          })
          .strict()
          .parse(req.body);
        const id = randomUUID();
        await t.query(
          "INSERT INTO datasets(id,name,description) VALUES($1,$2,$3)",
          [id, b.name, b.description],
        );
        await t.query("INSERT INTO project_datasets VALUES($1,$2)", [
          b.project,
          id,
        ]);
        await t.query("INSERT INTO records VALUES($1,$2,$3,$4,$5,$6)", [
          randomUUID(),
          id,
          "North",
          12.5,
          "simulated units",
          "Fictional record created by the prototype.",
        ]);
        return { id };
      }),
    ),
  );
  app.get("/api/evaluations", async (req, res) => {
    ensure(
      ["reviewer", "admin"].includes((req as unknown as Authed).actor.role),
      "reviewer_required",
    );
    res.json(
      (
        await db.query(
          "SELECT * FROM evaluation_runs ORDER BY created_at DESC LIMIT 20",
        )
      ).rows,
    );
  });
  app.get("/api/evaluations/:id/report", async (req, res) => {
    ensure(
      ["reviewer", "admin"].includes((req as unknown as Authed).actor.role),
      "reviewer_required",
    );
    const r = (
      await db.query("SELECT report FROM evaluation_runs WHERE id=$1", [
        identifier.parse(req.params.id),
      ])
    ).rows[0];
    ensure(r, "report_not_found", 404);
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="bioaccess-evaluation.json"',
    );
    res.json(r.report);
  });
  app.use("/api", (_req, _res, next) =>
    next(new Denied("endpoint_not_found", 404)),
  );
  app.use(express.static(resolve("dist"), { index: "index.html" }));
  app.use(
    async (
      error: unknown,
      req: Request,
      res: Response,
      _next: NextFunction,
    ) => {
      const status =
        error instanceof Denied
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : 400 === Number((error as any)?.status)
              ? 400
              : 500;
      const reason =
        error instanceof Denied
          ? error.reason
          : error instanceof z.ZodError
            ? "invalid_input"
            : (error as any)?.message === "tool_outside_scope"
              ? "tool_outside_scope"
              : "operation_failed";
      try {
        await service.audit(
          {
            actor: (req as unknown as Authed).actor,
            correlation: (req as unknown as Authed).correlation,
            project:
              typeof req.params.project === "string"
                ? req.params.project
                : undefined,
          },
          "http.request",
          "deny",
          reason,
        );
      } catch {
        /* Never log secrets or request payloads. */
      }
      res.status(reason === "tool_outside_scope" ? 403 : status).json({
        error: reason,
        correlation: (req as unknown as Authed).correlation,
      });
    },
  );
  return app;
}
