import { mkdir, writeFile } from "node:fs/promises";
import { evaluate } from "./evaluation.js";
import { configuredDB, postgres } from "./db.js";
// Optional real PostgreSQL concurrency suite MUST use a separate empty test database.
const external = process.env.TEST_DATABASE_URL
  ? postgres(process.env.TEST_DATABASE_URL)
  : undefined;
if (external && process.env.TEST_DATABASE_URL === process.env.DATABASE_URL)
  throw Error("Test and application databases must differ");
if (
  external &&
  (
    await external.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'",
    )
  ).rows.length
)
  throw Error("TEST_DATABASE_URL must point to an empty disposable database");
try {
  const report = await evaluate(external);
  await mkdir("reports", { recursive: true });
  await writeFile("reports/evaluation.json", JSON.stringify(report, null, 2));
  if (process.argv.includes("--save")) {
    const db = configuredDB();
    try {
      await db.query(
        "INSERT INTO evaluation_runs(id,mode,report) VALUES($1,$2,$3)",
        [report.id, report.mode, JSON.stringify(report)],
      );
    } finally {
      await db.close();
    }
  }
  console.table(
    report.rows.map(({ scenario, decision, passed }) => ({
      scenario,
      decision,
      passed,
    })),
  );
  console.log("JSON: reports/evaluation.json");
  if (!report.passed) process.exitCode = 1;
} finally {
  await external?.close();
}
