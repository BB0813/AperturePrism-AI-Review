#!/usr/bin/env node
/**
 * AperturePrism 一键安装脚本（跨平台：Linux / macOS / Windows）
 *
 * 流程：前置检查 → 拉起基础设施（PostgreSQL+pgvector、Redis，可选 Docker）→
 *       生成 .env（不存在时）→ 安装依赖 → 构建 → 应用数据库迁移 → 输出启动指引。
 *
 * 用法：
 *   node scripts/install.mjs                # 完整安装
 *   node scripts/install.mjs --skip-docker  # 使用已有的 DATABASE_URL/REDIS_URL，不启动容器
 *   node scripts/install.mjs --skip-deps    # 跳过 npm install 与构建
 *   node scripts/install.mjs --skip-migrate # 跳过数据库迁移
 *   node scripts/install.mjs --help
 *
 * 已存在 .env 时不会覆盖；GITHUB_* / EMBEDDING_* 等密钥需在 .env 中自行填写。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env");
const ENV_EXAMPLE = join(ROOT, ".env.example");
const COMPOSE_DEV = "docker/docker-compose.dev.yml";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const info = (msg) => console.log(`${CYAN}[INFO]${RESET} ${msg}`);
const ok = (msg) => console.log(`${GREEN}[OK]${RESET} ${msg}`);
const warn = (msg) => console.log(`${YELLOW}[WARN]${RESET} ${msg}`);
const fail = (msg) => console.error(`${RED}[FAIL]${RESET} ${msg}`);

function run(cmd, args, { cwd = ROOT, silent = false } = {}) {
  if (!silent) info(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: silent ? "pipe" : "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  return result.status === 0;
}

function readEnvFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** 解析 .env 文件为键值对象（仅简单 KV，不做变量展开）。 */
function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function envHasUrl() {
  return Boolean(process.env.DATABASE_URL || process.env.REDIS_URL);
}

function dockerAvailable() {
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  if (probe.status !== 0) return false;
  const compose = spawnSync("docker", ["compose", "version"], {
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  return compose.status === 0;
}

function startInfra() {
  if (envHasUrl()) {
    ok("检测到环境变量中已有 DATABASE_URL/REDIS_URL，跳过容器启动");
    return;
  }
  if (existsSync(ENV_FILE)) {
    const env = parseEnv(readEnvFile(ENV_FILE));
    if (env.DATABASE_URL && env.REDIS_URL) {
      ok("检测到 .env 中已有数据库/Redis 连接，跳过容器启动");
      return;
    }
  }
  if (!dockerAvailable()) {
    warn(
      "未检测到 Docker Compose，且未提供 DATABASE_URL/REDIS_URL。\n" +
        "  请手动准备 PostgreSQL(pgvector 扩展) 与 Redis，然后在 .env 中填写连接串后重跑。",
    );
    return;
  }
  info("启动基础设施（PostgreSQL + Redis，docker compose）…");
  if (run("docker", ["compose", "-f", COMPOSE_DEV, "up", "-d"])) {
    ok("基础设施已启动（PostgreSQL :5432 / Redis :6379）");
  } else {
    warn("基础设施启动失败，请检查 docker compose 日志后重试");
  }
}

function generateEnv() {
  if (existsSync(ENV_FILE)) {
    const size = statSync(ENV_FILE).size;
    warn(`已存在 ${ENV_FILE}（${size} 字节），跳过生成，复用现有配置`);
    return;
  }
  const example = readEnvFile(ENV_EXAMPLE);
  if (!example) {
    warn("未找到 .env.example，跳过 .env 生成");
    return;
  }
  const masterKey = randomBytes(32).toString("base64");
  const webuiToken = randomUUID().replaceAll("-", "");
  let content = example
    .replace(/^CREDENTIAL_MASTER_KEY=.*$/m, `CREDENTIAL_MASTER_KEY=${masterKey}`)
    .replace(/^#\s*WEBUI_API_TOKEN=.*$/m, `WEBUI_API_TOKEN=${webuiToken}`);
  writeFileSync(ENV_FILE, content);
  ok(`已生成 ${ENV_FILE}`);
  warn(
    "请在 .env 中补填密钥（GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_PATH / GITHUB_WEBHOOK_SECRET、\n" +
      "  GITHUB_OAUTH_CLIENT_ID / SECRET、EMBEDDING_BASE_URL / EMBEDDING_API_KEY 等），" +
      "否则对应功能不可用",
  );
}

function checkPrereqs() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    fail(`需要 Node.js >= 22（当前 ${process.version}）`);
    return false;
  }
  const npm = spawnSync("npm", ["--version"], {
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  if (npm.status !== 0) {
    fail("未检测到 npm");
    return false;
  }
  ok(`Node ${process.version} / npm ${npm.stdout?.toString().trim() ?? "?"}`);
  return true;
}

function installDeps() {
  info("安装依赖（npm install）…");
  if (!run("npm", ["install"])) {
    fail("依赖安装失败");
    process.exitCode = 1;
    return false;
  }
  ok("依赖安装完成");
  info("构建（npm run build）…");
  if (!run("npm", ["run", "build"])) {
    fail("构建失败");
    process.exitCode = 1;
    return false;
  }
  ok("构建完成");
  return true;
}

function migrate() {
  info("应用数据库迁移（node scripts/migrate.mjs）…");
  if (!run("node", ["scripts/migrate.mjs"])) {
    warn(
      "迁移未成功。请确认 DATABASE_URL 可达、PostgreSQL 已安装 pgvector 扩展，然后重跑：node scripts/migrate.mjs",
    );
    process.exitCode = 1;
    return false;
  }
  ok("数据库迁移完成");
  return true;
}

function summary() {
  console.log("");
  console.log(`${BOLD}${GREEN}安装完成${RESET}`);
  console.log(`${BOLD}──────────────────────────────${RESET}`);
  console.log(`  API：        ${DIM}npm run dev --workspace apps/api${RESET}`);
  console.log(`  分析 Worker：${DIM}npm run dev --workspace apps/analysis-worker${RESET}`);
  console.log(`  索引 Worker：${DIM}npm run dev --workspace apps/index-worker${RESET}`);
  console.log(`  Scheduler：  ${DIM}npm run dev --workspace apps/scheduler${RESET}`);
  console.log(`  Web UI：     ${DIM}cd apps/web && npm install && npm run dev${RESET}`);
  console.log("");
  console.log(`  API 健康检查：${DIM}curl http://127.0.0.1:3000/health/live${RESET}`);
  console.log(`  OAuth 回调：  ${DIM}http://127.0.0.1:3000/auth/callback${RESET}`);
  console.log(`${BOLD}──────────────────────────────${RESET}`);
  console.log(`详情见 README「本地启动」章节。`);
}

function usage() {
  console.log(`AperturePrism 一键安装脚本

用法:
  node scripts/install.mjs [选项]

选项:
  --skip-docker    使用已有的 DATABASE_URL/REDIS_URL，不启动容器
  --skip-deps      跳过 npm install 与构建
  --skip-migrate   跳过数据库迁移
  --help           显示帮助

说明:
  - 已存在 .env 时不会覆盖；自动生成 CREDENTIAL_MASTER_KEY 与 WEBUI_API_TOKEN。
  - GITHUB_* / EMBEDDING_* / GITHUB_OAUTH_* 等密钥需在 .env 中手动填写。`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  const skipDocker = args.includes("--skip-docker");
  const skipDeps = args.includes("--skip-deps");
  const skipMigrate = args.includes("--skip-migrate");

  console.log(`${BOLD}${CYAN}AperturePrism 一键安装${RESET}`);
  console.log("");

  if (!checkPrereqs()) {
    process.exitCode = 1;
    return;
  }

  if (!skipDocker) {
    startInfra();
  } else {
    ok("--skip-docker：使用环境变量/现有 .env 的数据库与 Redis");
  }

  generateEnv();

  if (!skipDeps) {
    if (!installDeps()) return;
  } else {
    ok("--skip-deps：跳过依赖安装与构建");
  }

  if (!skipMigrate) {
    migrate();
  } else {
    ok("--skip-migrate：跳过数据库迁移");
  }

  summary();
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
