import express from "express";
import cors from "cors";
import { config } from "../config/env.js";
import {
  handleMcpRequest,
  handleMcpDelete,
  handleMcpGet,
  closeAllTransports,
} from "./httpHandler.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", true);

  app.use(
    cors({
      origin: config.server.corsOrigins,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Accept", "Mcp-Session-Id"],
      exposedHeaders: ["Mcp-Session-Id"],
      credentials: true,
      maxAge: 86400,
    }),
  );

  app.options("/mcp", (req, res) => {
    res.status(200).end();
  });

  app.use(express.json());

  app.use((req, res, next) => {
    if (!req.headers.accept) {
      req.headers.accept = "application/json, text/event-stream";
    }
    next();
  });

  app.post("/mcp", handleMcpRequest);
  app.delete("/mcp", handleMcpDelete);
  app.get("/mcp", handleMcpGet);
  app.get("/health", (req, res) => {
    res.status(200).json({ status: "OK", uptime: process.uptime() });
  });

  return { app, closeAllTransports };
}
