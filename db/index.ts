import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../lib/env";
import * as schema from "./schema";

export * from "./schema";

// All request-time database access uses the pooled URL. Export the pool so
// durable integrations (such as the Linq thread state store) do not create a
// second connection pool for every Vercel function instance.
export const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle({ client: pool, schema });
