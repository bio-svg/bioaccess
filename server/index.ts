import { configuredDB } from "./db.js";
import { app } from "./app.js";
const db = configuredDB();
const server = app(db).listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () =>
  console.log("BioAccess API ready (simulation provider)"),
);
process.on("SIGTERM", () => server.close(() => void db.close()));
