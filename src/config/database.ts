import pg from "pg";
import { config } from "./env.js";

const c = config.postgres;

export const databaseUrl = c.connectionString
    ?? `postgresql://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${c.database}?sslmode=require`;

export const resourceBaseUrl = new URL(databaseUrl);
resourceBaseUrl.protocol = "postgres:";
resourceBaseUrl.password = ""; // Clear password for constructing resource URIs

export const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10000,
    query_timeout: 60000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
});

export const SCHEMA_PATH = "schema";
