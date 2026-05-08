// src/tools/queryTool.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pool } from "../config/database.js";
import { logger } from "../utils/logger.js";

type PgError = Error & {
  code?: string;
  severity?: string;
  detail?: string;
  hint?: string;
};

function compactSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, 300);
}

export function registerQueryTool(mcpServer: McpServer) {
  mcpServer.tool(
    "query",
    "Execute SQL queries with read-only transactions",
    {
      sql: z.string(),
    },
    async ({ sql }) => {
      const requestStart = Date.now();
      const sqlPreview = compactSql(sql);
      const connectStart = Date.now();
      const client = await pool.connect();
      const connectMs = Date.now() - connectStart;

      logger.info(
        `[query] pool.connect success connect_ms=${connectMs} sql="${sqlPreview}"`,
      );

      const queryStart = Date.now();

      try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        const result = await client.query(sql);
        const queryMs = Date.now() - queryStart;
        const totalMs = Date.now() - requestStart;

        logger.info(
          `[query] success rows=${result.rowCount ?? result.rows.length} query_ms=${queryMs} total_ms=${totalMs} sql="${sqlPreview}"`,
        );

        return {
          content: [
            { type: "text", text: JSON.stringify(result.rows, null, 2) },
          ],
          isError: false,
        };
      } catch (error) {
        const pgError = error as PgError;
        const queryMs = Date.now() - queryStart;
        const totalMs = Date.now() - requestStart;

        logger.error(
          `[query] failed code=${pgError.code ?? "unknown"} severity=${pgError.severity ?? "unknown"} query_ms=${queryMs} total_ms=${totalMs} message="${pgError.message}" sql="${sqlPreview}"`,
        );
        if (pgError.detail) {
          logger.error(`[query] detail: ${pgError.detail}`);
        }
        if (pgError.hint) {
          logger.error(`[query] hint: ${pgError.hint}`);
        }

        throw error;
      } finally {
        const rollbackStart = Date.now();
        try {
          await client.query("ROLLBACK");
          logger.info(
            `[query] rollback success rollback_ms=${Date.now() - rollbackStart} sql="${sqlPreview}"`,
          );
        } catch (error) {
          const rollbackError = error as PgError;
          logger.warn(
            `[query] rollback failed message="${rollbackError.message}" sql="${sqlPreview}"`,
          );
        } finally {
          client.release();
        }
      }
    },
  );
}
