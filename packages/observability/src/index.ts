import pino, { type Logger, type LoggerOptions } from "pino";

const sensitivePaths = [
  "authorization",
  "cookie",
  "headers.authorization",
  "headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "githubInstallationToken",
  "providerCredential",
  "databaseUrl",
  "redisUrl",
  "prompt",
  "repositorySource",
];

export type Correlation = {
  requestId?: string;
  taskId?: string;
  attemptId?: string;
};

export function createLogger(level: LoggerOptions["level"] = "info"): Logger {
  return pino({
    level,
    redact: { paths: sensitivePaths, censor: "[REDACTED]" },
    base: { service: "apertureprism" },
  });
}

export function withCorrelation(
  logger: Logger,
  correlation: Correlation,
): Logger {
  return logger.child(correlation);
}

export function startTimer(): () => number {
  const startedAt = performance.now();
  return () => performance.now() - startedAt;
}
