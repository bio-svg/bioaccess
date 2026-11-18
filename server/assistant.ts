import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Service,
  ensure,
  filters,
  identifier,
  type Context,
} from "./service.js";
export interface AssistantProvider {
  readonly mode: "simulation" | "api";
  plan(message: string, dataset: string): Promise<unknown>;
}
export class SimulatedProvider implements AssistantProvider {
  readonly mode = "simulation" as const;
  async plan(message: string, dataset: string) {
    const m = message.toLowerCase();
    return {
      tool: /sql|shell|https?:|command/.test(m)
        ? "execute_sql"
        : /export/.test(m)
          ? "request_export"
          : /summari[sz]e|summary|average/.test(m)
            ? "summarize"
            : /catalog|list/.test(m)
              ? "list_datasets"
              : "query_records",
      dataset,
      filters: { limit: 20 },
    };
  }
}
// No provider API configured in this MVP. Future adapters must return this same untrusted schema.
const call = z
  .object({
    tool: z.enum([
      "list_datasets",
      "query_records",
      "summarize",
      "request_export",
    ]),
    dataset: identifier,
    filters,
  })
  .strict();
export class Assistant {
  constructor(
    private service: Service,
    private provider: AssistantProvider = new SimulatedProvider(),
  ) {}
  async create(c: Context) {
    return this.service.run(c, "assistant.create", async (t) => {
      await this.service.member(t, c);
      const id = randomUUID();
      await t.query(
        "INSERT INTO assistant_sessions(id,user_id,project_id,provider) VALUES($1,$2,$3,$4)",
        [id, c.actor.id, c.project, this.provider.mode],
      );
      return { id, mode: this.provider.mode };
    });
  }
  async message(c: Context, id: string, body: unknown) {
    const b = z
      .object({
        message: z.string().trim().min(1).max(1000),
        dataset: identifier,
      })
      .strict()
      .parse(body);
    const context = { ...c, assistant: id, deadline: Date.now() + 8000 };
    await this.service.run(context, "assistant.message", async (t) => {
      await this.service.member(t, c);
      const used = (
        await t.query(
          "UPDATE assistant_sessions SET messages=messages+1 WHERE id=$1 AND user_id=$2 AND project_id=$3 AND messages<20 RETURNING id",
          [id, c.actor.id, c.project],
        )
      ).rows;
      ensure(used.length, "assistant_session_invalid_or_limit", 429);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const plan = await Promise.race([
        this.provider.plan(b.message, b.dataset),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("provider_timeout")), 3000);
        }),
      ]);
      // Exactly one allowed tool per message; no model-provided identity, role, URL or SQL.
      const result = await this.execute(context, plan);
      const response = {
        mode: this.provider.mode,
        label: "DETERMINISTIC SIMULATION · not an LLM",
        result,
      };
      ensure(
        Buffer.byteLength(JSON.stringify(response)) <= 32768,
        "assistant_response_too_large",
        413,
      );
      return response;
    } finally {
      clearTimeout(timer);
    }
  }
  async execute(c: Context, raw: unknown) {
    const parsed = call.safeParse(raw);
    if (!parsed.success) {
      await this.service.audit(
        c,
        "assistant.tool",
        "deny",
        "tool_outside_scope",
      );
      throw new Error("tool_outside_scope");
    }
    const { tool, dataset, filters: f } = parsed.data;
    const ctx = { ...c, dataset };
    // Session ownership is rechecked even for callers invoking the tool dispatcher directly.
    await this.service.run(ctx, "assistant.tool.validate", async (t) => {
      await this.service.member(t, c);
      ensure(
        (
          await t.query(
            "SELECT id FROM assistant_sessions WHERE id=$1 AND user_id=$2 AND project_id=$3",
            [c.assistant, c.actor.id, c.project],
          )
        ).rows.length,
        "assistant_session_invalid",
      );
    });
    let outcome = "deny";
    try {
      let result: unknown;
      switch (tool) {
        case "list_datasets":
          result = await this.service.catalog(ctx);
          break;
        case "query_records":
          result = await this.service.query(ctx, f);
          break;
        case "summarize":
          result = await this.service.query(ctx, f, true);
          break;
        case "request_export":
          result = await this.service.requestExport(ctx, f);
          break;
      }
      outcome = "allow";
      return result;
    } finally {
      await this.service.db.query(
        "INSERT INTO assistant_operations(id,session_id,tool,outcome,correlation_id) VALUES($1,$2,$3,$4,$5)",
        [randomUUID(), c.assistant, tool, outcome, c.correlation],
      );
    }
  }
}
