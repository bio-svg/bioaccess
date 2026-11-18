import { memory } from "./db.js";
import { migrate, seed } from "./setup.js";
import { evaluate } from "./evaluation.js";
import { app } from "./app.js";
if (
  process.env.NODE_ENV === "production" ||
  process.env.ALLOW_DEV_SEED !== "true" ||
  !process.env.DEMO_PASSWORD ||
  process.env.DEMO_PASSWORD.length < 12
)
  throw Error(
    "Disposable demo requires development, ALLOW_DEV_SEED=true and DEMO_PASSWORD (12+ characters)",
  );
process.env.APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3000";
const db = await memory();
await migrate(db);
await seed(db, process.env.DEMO_PASSWORD);
const report = await evaluate();
await db.query("INSERT INTO evaluation_runs(id,mode,report) VALUES($1,$2,$3)", [
  report.id,
  report.mode,
  JSON.stringify(report),
]);
const server = app(db).listen(
  Number(process.env.PORT ?? 3000),
  "127.0.0.1",
  () =>
    console.log(
      "BioAccess disposable local demo ready. Data resets when stopped.",
    ),
);
process.on("SIGTERM", () => server.close(() => void db.close()));
