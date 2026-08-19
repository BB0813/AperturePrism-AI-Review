import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const taskStatus = pgEnum("task_status", [
  "queued",
  "leased",
  "running",
  "publishing",
  "completed",
  "retry_wait",
  "failed",
  "canceled",
]);

export const pgVector4096 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(4096)";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    if (Array.isArray(value)) return value;
    const str = String(value);
    return str.startsWith("[")
      ? JSON.parse(str)
      : JSON.parse(`[${str.slice(1, -1)}]`);
  },
});

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    githubId: text("github_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    installationId: text("installation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("repositories_github_id_unique").on(table.githubId)],
);

export const githubInstallations = pgTable(
  "github_installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    githubInstallationId: text("github_installation_id").notNull(),
    accountLogin: text("account_login").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("github_installations_external_id_unique").on(
      table.githubInstallationId,
    ),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryId: text("delivery_id").notNull(),
    eventName: varchar("event_name", { length: 100 }).notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingStatus: varchar("processing_status", { length: 20 })
      .default("received")
      .notNull(),
    taskId: uuid("task_id"),
    outcomeReason: varchar("outcome_reason", { length: 100 }),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_delivery_id_unique").on(table.deliveryId),
  ],
);

export const analysisTasks = pgTable(
  "analysis_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskType: varchar("task_type", { length: 50 }).notNull(),
    repositoryId: uuid("repository_id").references(() => repositories.id),
    subjectNumber: integer("subject_number"),
    subjectRevision: text("subject_revision").notNull(),
    policyVersion: text("policy_version").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: taskStatus("status").default("queued").notNull(),
    priority: integer("priority").default(0).notNull(),
    payload: jsonb("payload").notNull(),
    pendingPayload: jsonb("pending_payload"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastErrorCategory: varchar("last_error_category", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("analysis_tasks_dedupe_key_unique").on(table.dedupeKey),
    index("analysis_tasks_claim_idx").on(
      table.status,
      table.nextAttemptAt,
      table.priority,
    ),
    index("analysis_tasks_lease_expiry_idx").on(table.leaseExpiresAt),
  ],
);

export const taskAttempts = pgTable(
  "task_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => analysisTasks.id),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorCategory: varchar("error_category", { length: 100 }),
  },
  (table) => [
    uniqueIndex("task_attempts_task_number_unique").on(
      table.taskId,
      table.attemptNumber,
    ),
  ],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => analysisTasks.id),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("task_events_task_created_idx").on(table.taskId, table.createdAt),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    topic: varchar("topic", { length: 100 }).notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("outbox_events_publish_idx").on(table.publishedAt, table.availableAt),
  ],
);

export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: varchar("provider", { length: 100 }).notNull(),
    name: text("name").notNull(),
    encryptedCredential: text("encrypted_credential").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("provider_accounts_provider_name_unique").on(
      table.provider,
      table.name,
    ),
  ],
);

export const modelRolePolicies = pgTable(
  "model_role_policies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    role: varchar("role", { length: 100 }).notNull(),
    version: text("version").notNull(),
    candidates: jsonb("candidates").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("model_role_policies_role_version_unique").on(
      table.role,
      table.version,
    ),
  ],
);

export const externalPublications = pgTable(
  "external_publications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => analysisTasks.id),
    idempotencyKey: text("idempotency_key").notNull(),
    externalObjectId: text("external_object_id"),
    channel: varchar("channel", { length: 50 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("external_publications_idempotency_unique").on(
      table.idempotencyKey,
    ),
  ],
);

/**
 * Normalized issue documents for duplicate recall. `title`/`body` are the
 * canonical (template-cleaned) text used by the full-text search index; the
 * `*Signals` arrays are the structured error/version/module/language features
 * used by the signal-overlap recall. `embedding` holds the 4096-d vector
 * (nvidia/nv-embed-v1) for vector similarity recall.
 */
export const issueDocuments = pgTable(
  "issue_documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: uuid("repository_id").references(() => repositories.id),
    issueNumber: integer("issue_number").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    versions: text("versions").array().notNull().default([]),
    errorCodes: text("error_codes").array().notNull().default([]),
    paths: text("paths").array().notNull().default([]),
    languages: text("languages").array().notNull().default([]),
    hasStackTrace: boolean("has_stack_trace").default(false).notNull(),
    hasReproduction: boolean("has_reproduction").default(false).notNull(),
    embedding: pgVector4096("embedding"),
    /** sha256 of normalized text+signals; unchanged docs skip re-embedding. */
    contentHash: text("content_hash"),
    indexedAt: timestamp("indexed_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("issue_documents_repo_issue_unique").on(
      table.repositoryId,
      table.issueNumber,
    ),
  ],
);

/** Persisted structured result of an issue analysis or PR review run. */
export const subjectResults = pgTable(
  "subject_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectType: varchar("subject_type", { length: 20 }).notNull(),
    subjectNumber: integer("subject_number").notNull(),
    repositoryFullName: text("repository_full_name").notNull(),
    revision: text("revision").notNull(),
    taskId: uuid("task_id").references(() => analysisTasks.id),
    result: jsonb("result").notNull(),
    published: boolean("published").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("subject_results_task_unique").on(table.taskId),
    index("subject_results_type_number_idx").on(
      table.subjectType,
      table.subjectNumber,
      table.createdAt,
    ),
  ],
);

/**
 * Runtime-overridable settings that hot-apply without a process restart.
 * `value` is a plain string; an empty/absent row falls back to the env config
 * (WEBUI_API_TOKEN, GITHUB_WEBHOOK_SECRET, LOG_LEVEL). Updated via the API.
 */
export const systemSettings = pgTable(
  "system_settings",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("system_settings_key_idx").on(table.key)],
);

/**
 * Label rules map an analysis field value (e.g. `severity:S1`) to a GitHub
 * label name that the worker applies to an issue after a completed analysis.
 */
export const labelRules = pgTable(
  "label_rules",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("label_rules_key_unique").on(table.key)],
);

/**
 * Users recognized through GitHub OAuth login. Kept lightweight: a login plus
 * an optional display name for the personal settings page; multi-account role
 * management can build on this table later.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    login: text("login").notNull(),
    displayName: text("display_name").default("").notNull(),
    isAdmin: boolean("is_admin").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("users_login_unique").on(table.login)],
);

/**
 * Security audit log: one row per sensitive admin/operator action (role
 * changes, backup import, setup init, settings update, index operations).
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actor: text("actor").default("").notNull(),
    action: text("action").notNull(),
    target: text("target"),
    detail: jsonb("detail").default({}).notNull(),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("audit_logs_created_idx").on(table.createdAt)],
);

/**
 * Registered GitHub accounts used by star_aid: a login plus the AES-GCM sealed
 * PAT. Only the login is ever surfaced; the token stays in the DB.
 */
export const starAidAccounts = pgTable(
  "star_aid_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    login: text("login").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [uniqueIndex("star_aid_accounts_login_unique").on(table.login)],
);

/**
 * Target repositories each star_aid account is asked to star. `starred` flips
 * once the PUT /user/starred/{owner}/{repo} call succeeds; failures are kept in
 * `last_error` so a later sweep can retry.
 */
export const starAidTargets = pgTable(
  "star_aid_targets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => starAidAccounts.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    description: text("description").default("").notNull(),
    starred: boolean("starred").default(false).notNull(),
    starredAt: timestamp("starred_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("star_aid_targets_account_full_name_unique").on(
      table.accountId,
      table.fullName,
    ),
  ],
);

/**
 * Repository memory. `kind` is one of `reflection` | `rule` | `knowledge`:
 * reflections are raw distilled outcomes from completed issue analyses / PR
 * reviews, later merged (consolidated=true) by the memory-consolidation agent
 * into durable `rule`/`knowledge` rows that are fed back into later contexts.
 */
export const repoMemory = pgTable(
  "repo_memory",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repositoryId: uuid("repository_id").references(() => repositories.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    sourceType: text("source_type"),
    sourceRef: text("source_ref"),
    consolidated: boolean("consolidated").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("repo_memory_repo_kind_idx").on(table.repositoryId, table.kind),
    index("repo_memory_consolidated_idx").on(table.consolidated),
  ],
);
