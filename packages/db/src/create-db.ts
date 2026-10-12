import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./database.js";

const { Pool } = pg;

export type TabulaDb = Kysely<Database>;

export function createDb(connectionString: string): TabulaDb {
  const pool = new Pool({ connectionString });
  // An idle connection dropped by the server (restart, network blip) is emitted here;
  // without a listener Node treats it as unhandled and exits. The pool replaces it.
  pool.on("error", (err) => {
    console.warn(`[db] idle connection error: ${err.message}`);
  });
  // Same for a connection that drops while checked out; its pending query fails on its own.
  pool.on("connect", (client) => {
    client.on("error", (err) => {
      console.warn(`[db] connection error: ${err.message}`);
    });
  });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}
