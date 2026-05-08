import { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../server/server.js";
import { logger } from "../utils/logger.js";

type SessionContext = {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
  clientIp: string;
  createdAt: number;
  lastActivityAt: number;
};

const sessions: Record<string, SessionContext> = {};

const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
const SESSION_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

function getClientIp(req: Request): string {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  if (Array.isArray(forwardedFor) && forwardedFor.length > 0) {
    return forwardedFor[0].split(",")[0].trim();
  }

  return req.ip || req.socket.remoteAddress || "unknown";
}

async function closeSession(sessionId: string, reason: string) {
  const session = sessions[sessionId];
  if (!session) {
    return;
  }

  delete sessions[sessionId];
  logger.info(
    `[session] event=closed session_id=${sessionId} client_ip=${session.clientIp} reason=${reason}`,
  );

  try {
    await session.transport.close();
  } catch (error) {
    logger.warn(`Error closing transport for session ${sessionId}:`, error);
  }

  try {
    await session.mcpServer.close();
  } catch (error) {
    logger.error(`Error closing MCP server for session ${sessionId}:`, error);
  }
}

function touchSession(sessionId: string) {
  const session = sessions[sessionId];
  if (session) {
    session.lastActivityAt = Date.now();
  }
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [sessionId, session] of Object.entries(sessions)) {
    const idleMs = now - session.lastActivityAt;
    if (idleMs > SESSION_IDLE_TTL_MS) {
      logger.warn(
        `Idle session timeout session=${sessionId} idle_ms=${idleMs} ttl_ms=${SESSION_IDLE_TTL_MS}`,
      );
      void closeSession(sessionId, "idle-timeout");
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS);

if (typeof cleanupTimer.unref === "function") {
  cleanupTimer.unref();
}

export async function handleMcpRequest(req: Request, res: Response) {
  const startTime = Date.now();
  const clientIp = getClientIp(req);
  
  logger.info(`[${startTime}] Starting MCP request handling`);
  logger.info(
    `[request] method=${req.method} path=${req.path} client_ip=${clientIp}`,
  );
  logger.info(`Request method: ${req.body?.method}`);
  logger.info(`Request body:`, JSON.stringify(req.body, null, 2));

  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    logger.info(`Session ID from header: ${sessionId}`);

    if (
      (isInitializeRequest(req.body) || req.body.method === "initialize") &&
      !sessionId
    ) {
      logger.info("=== HANDLING INITIALIZE REQUEST ===");

      const eventStore = new InMemoryEventStore();
      const newSessionId = randomUUID();
      logger.info(`Generated new session ID: ${newSessionId}`);

      try {
        logger.info("Creating StreamableHTTPServerTransport...");
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          eventStore,
          onsessioninitialized: (sid) => {
            logger.info(`Session initialized callback fired with ID: ${sid}`);
          },
        });
        logger.info("Transport created successfully");

        const sessionServer = createMcpServer();
        const now = Date.now();

        sessions[newSessionId] = {
          transport,
          mcpServer: sessionServer,
          clientIp,
          createdAt: now,
          lastActivityAt: now,
        };
        logger.info(
          `[session] event=created session_id=${newSessionId} client_ip=${clientIp}`,
        );

        transport.onclose = () => {
          const sid = transport.sessionId || newSessionId;
          const closedSession = sessions[sid];
          const closeIp = closedSession?.clientIp ?? "unknown";
          logger.info(
            `[session] event=transport-close session_id=${sid} client_ip=${closeIp}`,
          );
          void closeSession(sid, "transport-close");
        };

        logger.info("Connecting session MCP server to transport...");
        await sessionServer.connect(transport);
        logger.info("Session MCP server connected to transport");

        res.setHeader("Mcp-Session-Id", newSessionId);
        logger.info(`Set Mcp-Session-Id header: ${newSessionId}`);

        await transport.handleRequest(req, res, req.body);

        const endTime = Date.now();
        logger.info(`Initialize request completed in ${endTime - startTime}ms`);
        return;
      } catch (initError) {
        logger.error("Error during initialization:", initError);

        await closeSession(newSessionId, "initialize-error");

        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: `Initialization failed: ${initError instanceof Error ? initError.message : "Unknown error"}`,
            },
            id: req.body?.id || null,
          });
        }
        return;
      }
    }

    if (sessionId && sessions[sessionId]) {
      touchSession(sessionId);
      logger.info(
        `[session] event=request session_id=${sessionId} client_ip=${clientIp}`,
      );
      logger.info(
        `=== HANDLING REQUEST WITH EXISTING SESSION: ${sessionId} ===`,
      );
      const { transport } = sessions[sessionId];
      await transport.handleRequest(req, res, req.body);
      touchSession(sessionId);

      const endTime = Date.now();
      logger.info(`Session request completed in ${endTime - startTime}ms`);
      return;
    }

    logger.warn(`Invalid or missing session ID: ${sessionId}`);
    logger.warn(`Available sessions: ${Object.keys(sessions).join(", ")}`);
    logger.warn(`Request method: ${req.body?.method}`);

    const errorMessage =
      req.body?.method === "server/info"
        ? "server/info requires a valid session. Please initialize first."
        : "Bad Request: No valid session ID provided";

    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: errorMessage,
      },
      id: req.body?.id || null,
    });
  } catch (error) {
    const endTime = Date.now();
    logger.error(
      `Error handling MCP request after ${endTime - startTime}ms:`,
      error,
    );
    logger.error(
      "Error stack:",
      error instanceof Error ? error.stack : "No stack trace",
    );

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: req.body?.id || null,
      });
    }
  }
}

export async function handleMcpDelete(req: Request, res: Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const clientIp = getClientIp(req);
  logger.info(`[request] method=${req.method} path=${req.path} client_ip=${clientIp}`);
  const ownerIp = sessionId ? sessions[sessionId]?.clientIp : undefined;
  logger.info(
    `[session] event=delete-request session_id=${sessionId ?? "undefined"} client_ip=${clientIp} `,
  );

  if (!sessionId || !sessions[sessionId]) {
    logger.warn(
      `[session] event=delete-invalid session_id=${sessionId ?? "undefined"} client_ip=${clientIp}`,
    );
    res
      .status(400)
      .send("Invalid or missing session ID. Please provide a valid session ID.");
    return;
  }

  logger.info(`Closing session for ID: ${sessionId}`);

  try {
    await closeSession(sessionId, "client-delete");

    logger.info(`Session ${sessionId} closed successfully`);

    res.status(200).json({
      jsonrpc: "2.0",
      result: { success: true },
      id: null,
    });
  } catch (error) {
    logger.error("Error closing transport:", error);
    if (!res.headersSent) {
      res.status(500).send("Error closing transport");
    }
  }
}

export async function handleMcpGet(req: Request, res: Response) {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const clientIp = getClientIp(req);
  logger.info(`[request] method=${req.method} path=${req.path} client_ip=${clientIp}`);
  logger.info(
    `[session] event=get-request session_id=${sessionId ?? "undefined"} client_ip=${clientIp}`,
  );

  if (!sessionId || !sessions[sessionId]) {
    logger.warn(`Invalid or missing session ID for GET: ${sessionId}`);
    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
    });
    return;
  }

  touchSession(sessionId);

  try {
    const { transport } = sessions[sessionId];
    await transport.handleRequest(req, res);
    touchSession(sessionId);
  } catch (error) {
    logger.error("Error handling GET MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
}

export async function closeAllTransports() {
  clearInterval(cleanupTimer);

  const sessionIds = Object.keys(sessions);
  logger.info(`Closing ${sessionIds.length} active transports`);

  for (const sessionId of sessionIds) {
    await closeSession(sessionId, "shutdown");
    logger.info(`Transport+server closed for session ID: ${sessionId}`);
  }

  logger.info("All transports closed");
}
