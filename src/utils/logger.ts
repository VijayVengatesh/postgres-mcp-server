// logger.ts

const verbose =
  process.argv.includes("--verbose") || process.env.VERBOSE === "true";

type LogLevel = "info" | "warn" | "error";

const COLORS = {
  info: "\x1b[34m", // Blue
  warn: "\x1b[33m", // Yellow
  error: "\x1b[31m", // Red
  reset: "\x1b[0m",
};

function getTimestamp(): string {
  const now = new Date();
  return now.toISOString(); // ISO format: "2025-04-05T10:00:00Z"
}

const logger = {
  info(...args: any[]) {
    if (verbose) {
      console.log(
        `${COLORS.info}[${getTimestamp()}] INFO:${COLORS.reset}`,
        ...args,
      );
    }
  },
  warn(...args: any[]) {
    if (verbose) {
      console.log(
        `${COLORS.warn}[${getTimestamp()}] WARN:${COLORS.reset}`,
        ...args,
      );
    }
  },
  error(...args: any[]) {
    console.error(
      `${COLORS.error}[${getTimestamp()}] ERROR:${COLORS.reset}`,
      ...args,
    );
  },
};

export { logger };
