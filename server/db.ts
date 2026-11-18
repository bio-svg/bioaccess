import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
export interface DB {
  query(sql: string, params?: any[]): Promise<{ rows: Record<string, any>[] }>;
  tx<T>(fn: (db: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function postgres(url: string): DB {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    statement_timeout: 8000,
  });
  return {
    query: (sql, params) => pool.query(sql, params),
    close: () => pool.end(),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const v = await fn({
          query: (s, p) => c.query(s, p),
          tx: async () => {
            throw Error("Nested transaction");
          },
          close: async () => {},
        });
        await c.query("COMMIT");
        return v;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
export async function memory(): Promise<DB> {
  const p = new PGlite();
  await p.waitReady;
  const wrap = (engine: any): DB => ({
    query: (sql, params = []) => engine.query(sql, params),
    tx: (fn) => engine.transaction((t: any) => fn(wrap(t))),
    close: () => p.close(),
  });
  return wrap(p);
}
export function configuredDB(): DB {
  if (!process.env.DATABASE_URL)
    throw Error("DATABASE_URL is required. See .env.example");
  return postgres(process.env.DATABASE_URL);
}
