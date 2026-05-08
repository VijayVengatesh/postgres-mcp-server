#!/usr/bin/env node
import { config } from "./config/env.js";
import { createApp } from "./http/app.js";
import { logger } from "./utils/logger.js";

const { app, closeAllTransports } = createApp();

app.listen(config.server.port, config.server.host, () => {
  logger.info(
    `Stateful server is running on http://${config.server.host}:${config.server.port}/mcp`,
  );
  if (process.env.NODE_ENV !== "production") {
    logger.info(`Local access: http://localhost:${config.server.port}/mcp`);
  }
});

const shutdown = async () => {
  logger.info("Shutting down server...");
  try {
    await closeAllTransports();
  } catch (error) {
    logger.error(`Error closing transports:`, error);
  }

  logger.info("Server shutdown complete");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
