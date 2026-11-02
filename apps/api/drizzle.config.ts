import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  // Read from the environment; never hardcode a connection string here.
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://till:till@localhost:5432/till",
  },
  verbose: true,
  strict: true,
});
