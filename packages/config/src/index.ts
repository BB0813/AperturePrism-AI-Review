import { z } from "zod";

export * from "./credentials.js";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  DATABASE_URL: z
    .url()
    .refine(
      (value) =>
        value.startsWith("postgres://") || value.startsWith("postgresql://"),
      {
        message: "DATABASE_URL must use postgres:// or postgresql://",
      },
    ),
  REDIS_URL: z
    .url()
    .refine(
      (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
      {
        message: "REDIS_URL must use redis:// or rediss://",
      },
    ),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(1_000),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** GitHub App used to mint installation tokens for API reads and writes. */
  GITHUB_APP_ID: z.string().min(1).optional(),
  /** Path to the GitHub App private key PEM file. */
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  /** Defaults to the public GitHub API; override for GitHub Enterprise. */
  GITHUB_API_BASE_URL: z.url().optional(),
  /**
   * JSON object mapping model provider names to OpenAI-compatible base URLs,
   * e.g. {"openai-compatible":"https://models.example/v1"}. Used by the
   * analysis worker to build adapters for the candidates in the role policy.
   */
  MODEL_PROVIDER_BASE_URLS: z
    .string()
    .refine(
      (value) => {
        if (value.length === 0) return true;
        try {
          const parsed: unknown = JSON.parse(value);
          return (
            typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed) &&
            Object.values(parsed).every((entry) => typeof entry === "string")
          );
        } catch {
          return false;
        }
      },
      { message: "MODEL_PROVIDER_BASE_URLS must be a JSON object of strings" },
    )
    .optional(),
  /** Base64-encoded 32-byte key that wraps stored provider credentials. */
  CREDENTIAL_MASTER_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "CREDENTIAL_MASTER_KEY must be 32 bytes encoded as base64",
    })
    .optional(),
});

export type AppConfig = Readonly<{
  environment: z.infer<typeof environmentSchema>["NODE_ENV"];
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  logLevel: z.infer<typeof environmentSchema>["LOG_LEVEL"];
  healthCheckTimeoutMs: number;
  githubWebhookSecret: string | undefined;
  githubAppId: string | undefined;
  githubAppPrivateKeyPath: string | undefined;
  githubApiBaseUrl: string | undefined;
  modelProviderBaseUrls: Readonly<Record<string, string>>;
  credentialMasterKey: string | undefined;
}>;

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return Object.freeze({
    environment: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    logLevel: parsed.LOG_LEVEL,
    healthCheckTimeoutMs: parsed.HEALTH_CHECK_TIMEOUT_MS,
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
    githubAppId: parsed.GITHUB_APP_ID,
    githubAppPrivateKeyPath: parsed.GITHUB_APP_PRIVATE_KEY_PATH,
    githubApiBaseUrl: parsed.GITHUB_API_BASE_URL,
    modelProviderBaseUrls: Object.freeze(
      parsed.MODEL_PROVIDER_BASE_URLS
        ? (JSON.parse(parsed.MODEL_PROVIDER_BASE_URLS) as Record<
            string,
            string
          >)
        : {},
    ),
    credentialMasterKey: parsed.CREDENTIAL_MASTER_KEY,
  });
}
