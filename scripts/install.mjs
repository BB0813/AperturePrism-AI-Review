#!/usr/bin/env node
/**
 * AperturePrism 一键安装脚本（跨平台：Linux / macOS / Windows）
 *
 * 支持两种安装方式（交互二选一，或 --mode 指定）：
 *   1. 源码安装（默认）：本机直接跑 Node；Docker 可选，仅用于 PostgreSQL+Redis 基础设施
 *   2. Docker Compose 全栈安装：全部服务容器化（GHCR 镜像），适合生产/服务器
 *
 * 依赖处理：检测 Node / Docker Compose；加 --auto-install 可自动安装缺失依赖
 * （Linux/macOS 用包管理器或官方二进制，Windows 用 winget/choco）。
 *
 * 用法：
 *   node scripts/install.mjs                    # 交互选择安装方式
 *   node scripts/install.mjs --mode=compose     # 直接 Docker Compose 全栈安装
 *   node scripts/install.mjs --mode=source      # 直接源码安装
 *   node scripts/install.mjs --yes              # 跳过交互（默认源码安装）
 *   node scripts/install.mjs --auto-install     # 缺失 Node/Docker 时自动安装
 *   node scripts/install.mjs --verify           # Compose 模式叠加 compose.verify.yml（NAS 地址池耗尽）
 *   node scripts/install.mjs --skip-docker      # 源码模式：使用已有 DATABASE_URL/REDIS_URL
 *   node scripts/install.mjs --skip-deps        # 跳过 npm install 与构建
 *   node scripts/install.mjs --skip-migrate     # 跳过数据库迁移
 *   node scripts/install.mjs --help
 *
 * 已存在 .env / .env.production 时不会覆盖；GITHUB_* / EMBEDDING_* 等密钥需自行填写。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(ROOT, ".env");
const ENV_EXAMPLE = join(ROOT, ".env.example");
const ENV_PROD_FILE = join(ROOT, ".env.production");
const COMPOSE_DEV = "docker/docker-compose.dev.yml";
const COMPOSE_PROD = "docker/docker-compose.prod.yml";
const COMPOSE_VERIFY = "docker/compose.verify.yml";
const NODE_MIN = 22;
const NODE_FALLBACK_VERSION = "v22.14.0";

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

/* ---------- CLI options ---------- */

function parseArgs(args) {
  const opts = {
    mode: null, // "source" | "compose" | null(交互选择)
    yes: false,
    autoInstall: false,
    verify: false,
    skipDocker: false,
    skipDeps: false,
    skipMigrate: false,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--yes" || a === "-y") opts.yes = true;
    else if (a === "--auto-install") opts.autoInstall = true;
    else if (a === "--verify") opts.verify = true;
    else if (a === "--skip-docker") opts.skipDocker = true;
    else if (a === "--skip-deps") opts.skipDeps = true;
    else if (a === "--skip-migrate") opts.skipMigrate = true;
    else if (a === "--mode") opts.mode = args[++i];
    else if (a.startsWith("--mode=")) opts.mode = a.slice("--mode=".length);
    else warn(`忽略未知参数: ${a}`);
  }
  if (opts.mode && !["source", "compose"].includes(opts.mode)) {
    fail(`--mode 只支持 source / compose，收到: ${opts.mode}`);
    process.exit(1);
  }
  return opts;
}

/* ---------- helpers ---------- */

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
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function envHasUrl() {
  return Boolean(process.env.DATABASE_URL || process.env.REDIS_URL);
}

function commandExists(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], {
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  return r.status === 0;
}

function isRoot() {
  if (process.platform === "win32") {
    const r = spawnSync("net", ["session"], { stdio: "pipe", shell: true });
    return r.status === 0;
  }
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/** 交互提问；非 TTY 或 --yes 时直接返回默认值，避免 CI/管道下卡死。 */
async function prompt(question, dflt = "") {
  if (opts.yes || !process.stdin.isTTY) return dflt;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim() || dflt;
  } finally {
    rl.close();
  }
}

/* ---------- dependency detection / auto-install ---------- */

function dockerAvailable() {
  const probe = spawnSync(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    { stdio: "pipe", shell: process.platform === "win32" },
  );
  if (probe.status !== 0) return false;
  const compose = spawnSync("docker", ["compose", "version"], {
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  return compose.status === 0;
}

function nodeInfo() {
  return {
    major: Number(process.versions.node.split(".")[0]),
    ok: Number(process.versions.node.split(".")[0]) >= NODE_MIN,
  };
}

/** 查询 Node 官方 dist 最新的 v22 LTS 版本号。 */
async function fetchLatestNodeLts() {
  try {
    const res = await fetch("https://nodejs.org/dist/index.json", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return NODE_FALLBACK_VERSION;
    const list = (await res.json()) || [];
    const v22 = list.find((e) => e.version.startsWith("v22.") && e.lts);
    return v22?.version ?? NODE_FALLBACK_VERSION;
  } catch {
    return NODE_FALLBACK_VERSION;
  }
}

async function linuxInstallNode() {
  if (!isRoot()) {
    warn(
      "自动安装 Node 需要 root 权限（当前非 root）。请以 root 运行或使用 sudo，或手动安装 https://nodejs.org/",
    );
    return false;
  }
  if (!commandExists("curl") || !commandExists("tar")) {
    warn("自动安装 Node 需要 curl 与 tar");
    return false;
  }
  const ver = await fetchLatestNodeLts();
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const dir = `node-${ver}-linux-${arch}`;
  const url = `https://nodejs.org/dist/${ver}/${dir}.tar.xz`;
  const tmp = join(ROOT, ".node-tmp");
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  info(`下载 ${url}`);
  if (!run("curl", ["-fsSL", url, "-o", join(tmp, "node.tar.xz")])) return false;
  if (!run("tar", ["-xJf", join(tmp, "node.tar.xz"), "-C", tmp])) return false;
  const extracted = join(tmp, dir);
  for (const sub of ["bin", "include", "lib", "share"]) {
    run("cp", ["-rf", `${join(extracted, sub)}/.`, `/usr/local/${sub}/`]);
  }
  rmSync(tmp, { recursive: true, force: true });
  ok(`Node ${ver} 已安装到 /usr/local`);
  return true;
}

function windowsInstallNode() {
  if (commandExists("winget")) {
    if (
      run("winget", [
        "install",
        "--id",
        "OpenJS.NodeJS.LTS",
        "--exact",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ])
    ) {
      warn("Node 已安装。请关闭并重开终端（刷新 PATH）后重新运行本脚本。");
      return true;
    }
  }
  if (commandExists("choco")) {
    if (run("choco", ["install", "nodejs-lts", "-y"])) {
      warn("Node 已安装。请关闭并重开终端（刷新 PATH）后重新运行本脚本。");
      return true;
    }
  }
  warn("未找到 winget/choco。请手动安装 Node.js >= 22：https://nodejs.org/");
  return false;
}

function macInstallNode() {
  if (commandExists("brew")) {
    if (run("brew", ["install", "node"])) return true;
  }
  warn("未找到 Homebrew。请手动安装 Node.js >= 22：https://nodejs.org/");
  return false;
}

async function installNode() {
  if (process.platform === "darwin") return macInstallNode();
  if (process.platform === "win32") return windowsInstallNode();
  return linuxInstallNode();
}

/** 确保 Node >= NODE_MIN；版本过低时按需自动安装并用新 Node 重新执行自身。 */
async function ensureNode() {
  const { ok: okNode } = nodeInfo();
  if (okNode) {
    ok(`Node ${process.version}`);
    return true;
  }
  if (!opts.autoInstall) {
    fail(
      `需要 Node.js >= ${NODE_MIN}（当前 ${process.version}）。可加 --auto-install 自动安装，或手动升级 https://nodejs.org/`,
    );
    return false;
  }
  warn(`Node ${process.version} 低于 ${NODE_MIN}，尝试自动安装…`);
  if (!(await installNode())) return false;
  if (process.platform !== "win32") {
    // 用新安装的 Node 重新执行完整安装流程（当前进程仍是旧 Node）。
    const newBin = "/usr/local/bin/node";
    info("使用新安装的 Node 重新执行安装流程…");
    const r = spawnSync(newBin, [process.argv[1], ...process.argv.slice(2)], {
      stdio: "inherit",
    });
    process.exit(r.status ?? 0);
  }
  warn("请重开终端刷新 PATH 后重新运行本脚本。");
  return true;
}

function installDocker() {
  if (process.platform === "darwin") {
    if (commandExists("brew")) {
      return run("brew", ["install", "--cask", "docker"]);
    }
    warn("未找到 Homebrew。请手动安装 Docker Desktop：https://www.docker.com/products/docker-desktop/");
    return false;
  }
  if (process.platform === "win32") {
    if (commandExists("winget")) {
      return run("winget", [
        "install",
        "--id",
        "Docker.DockerDesktop",
        "--exact",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ]);
    }
    if (commandExists("choco")) {
      return run("choco", ["install", "docker-desktop", "-y"]);
    }
    warn("未找到 winget/choco。请手动安装 Docker Desktop：https://www.docker.com/products/docker-desktop/");
    return false;
  }
  if (!isRoot()) {
    warn("自动安装 Docker 需要 root 权限（当前非 root）。请以 root 运行或使用 sudo。");
    return false;
  }
  if (commandExists("apt-get")) {
    return run("bash", ["-c", "apt-get update -y && apt-get install -y docker.io docker-compose-plugin"]);
  }
  if (commandExists("dnf")) {
    return run("bash", ["-c", "dnf install -y docker docker-compose-plugin"]);
  }
  if (commandExists("yum")) {
    return run("bash", ["-c", "yum install -y docker docker-compose-plugin"]);
  }
  if (commandExists("apk")) {
    return run("bash", ["-c", "apk add --no-cache docker docker-compose-plugin"]);
  }
  warn("未能识别包管理器。请手动安装 Docker + Compose 插件：https://docs.docker.com/engine/install/");
  return false;
}

/** Compose 模式强制要求 Docker Compose（缺失时按需自动安装）。 */
function ensureDocker() {
  if (dockerAvailable()) {
    ok("已检测到 Docker Compose");
    return true;
  }
  if (opts.autoInstall) {
    warn("未检测到 Docker Compose，尝试自动安装…");
    if (installDocker()) {
      warn("Docker 安装后请启动 Docker 服务再重跑本脚本（Linux: systemctl start docker）。");
      return dockerAvailable();
    }
  }
  warn(
    "未检测到 Docker Compose。可加 --auto-install 自动安装，或手动安装：https://docs.docker.com/engine/install/",
  );
  return false;
}

function checkNpm() {
  const r = spawnSync("npm", ["--version"], {
    stdio: "pipe",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    fail("未检测到 npm（Node 安装通常自带，请检查 PATH）");
    return false;
  }
  ok(`npm ${r.stdout?.toString().trim() ?? "?"}`);
  return true;
}

/* ---------- compose 全栈安装 ---------- */

/** Compose 子命令公共参数（-f prod [-f verify] --env-file）。 */
function composeArgs() {
  const files = ["-f", COMPOSE_PROD];
  if (opts.verify) files.push("-f", COMPOSE_VERIFY);
  return [...files, "--env-file", ENV_PROD_FILE];
}

/** 生成 .env.production（不存在时）：随机密钥 + 指向 compose 服务的连接串。 */
function generateProdEnv() {
  if (existsSync(ENV_PROD_FILE)) {
    const size = statSync(ENV_PROD_FILE).size;
    warn(`已存在 ${ENV_PROD_FILE}（${size} 字节），复用现有配置`);
    return;
  }
  const example = readEnvFile(ENV_EXAMPLE);
  if (!example) {
    warn("未找到 .env.example，跳过生成");
    return;
  }
  const password = randomBytes(16).toString("hex");
  const masterKey = randomBytes(32).toString("base64");
  const webuiToken = randomUUID().replaceAll("-", "");
  const dbUser = "apertureprism";
  const dbName = "apertureprism";
  let content = example
    .replace(/^CREDENTIAL_MASTER_KEY=.*$/m, `CREDENTIAL_MASTER_KEY=${masterKey}`)
    .replace(/^#\s*WEBUI_API_TOKEN=.*$/m, `WEBUI_API_TOKEN=${webuiToken}`)
    .replace(/^#?\s*POSTGRES_PASSWORD=.*$/m, `POSTGRES_PASSWORD=${password}`)
    .replace(
      /^#?\s*DATABASE_URL=.*$/m,
      `DATABASE_URL=postgresql://${dbUser}:${password}@postgres:5432/${dbName}`,
    )
    .replace(/^#?\s*REDIS_URL=.*$/m, `REDIS_URL=redis://redis:6379`);
  writeFileSync(ENV_PROD_FILE, content);
  ok(`已生成 ${ENV_PROD_FILE}`);
  warn(
    "部分密钥为空（GITHUB_* / EMBEDDING_* 等），对应功能暂不可用。可先继续安装，装完后" +
      "在 WebUI「系统配置」页或安装向导补填，无需改 .env 重启。",
  );
}

async function installCompose() {
  console.log(`${BOLD}${CYAN}▶ Docker Compose 全栈安装${RESET}`);
  if (opts.skipDocker) warn("--skip-docker 不适用于 compose 模式，已忽略");
  if (!ensureDocker()) return false;
  generateProdEnv();
  const confirm = opts.yes
    ? "y"
    : await prompt("  确认继续安装（拉取镜像并启动全栈）？[y/N]: ", "n");
  if (opts.yes) ok("--yes 已生效，自动确认继续安装");
  if (confirm.toLowerCase() !== "y") {
    warn("已取消安装");
    return false;
  }
  info("拉取镜像（docker compose pull）…");
  if (!run("docker", ["compose", ...composeArgs(), "pull"])) {
    fail("镜像拉取失败");
    return false;
  }
  info("应用数据库迁移（docker compose run --rm migrate）…");
  if (!run("docker", ["compose", ...composeArgs(), "run", "--rm", "migrate"])) {
    warn(`迁移未成功，请确认 ${ENV_PROD_FILE} 中 DATABASE_URL 可达、pgvector 可用`);
  }
  info("启动全栈（docker compose up -d）…");
  if (!run("docker", ["compose", ...composeArgs(), "up", "-d"])) {
    fail("全栈启动失败");
    return false;
  }
  ok("Docker Compose 全栈已启动");
  summaryCompose();
  return true;
}

function summaryCompose() {
  console.log("");
  console.log(`${BOLD}${GREEN}安装完成${RESET}`);
  console.log(`${BOLD}──────────────────────────────${RESET}`);
  console.log(`  Web UI：  ${DIM}http://localhost${RESET}（默认 80，可在 .env.production 用 WEB_PORT 修改）`);
  console.log(`  API：     ${DIM}http://localhost:30001/health/live${RESET}（可用 API_PORT 修改）`);
  console.log(`  查看状态：${DIM}docker compose -f ${COMPOSE_PROD} --env-file .env.production ps${RESET}`);
  console.log(`  查看日志：${DIM}docker compose -f ${COMPOSE_PROD} --env-file .env.production logs -f api${RESET}`);
  console.log(`${BOLD}──────────────────────────────${RESET}`);
  console.log(`升级：修改 ${ENV_PROD_FILE} 中 IMAGE_TAG=vX.Y.Z 后重跑本脚本，或 docker compose pull && up -d。`);
}

/* ---------- 源码安装 ---------- */

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
        "  请手动准备 PostgreSQL(pgvector 扩展) 与 Redis，然后在 .env 中填写连接串后重跑，\n" +
        "  或加 --auto-install 自动安装 Docker 后重新运行。",
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
  console.log(`  API 健康检查：${DIM}curl http://127.0.0.1:30001/health/live${RESET}`);
  console.log(`  OAuth 回调：  ${DIM}http://127.0.0.1:30001/auth/callback${RESET}`);
  console.log(`${BOLD}──────────────────────────────${RESET}`);
  console.log(`详情见 README「本地启动」章节。`);
}

async function installSource() {
  console.log(`${BOLD}${CYAN}▶ 源码安装${RESET}`);
  if (opts.autoInstall && !dockerAvailable()) {
    warn("未检测到 Docker Compose，尝试自动安装（用于 PostgreSQL/Redis 基础设施）…");
    installDocker();
  }
  if (!opts.skipDocker) {
    startInfra();
  } else {
    ok("--skip-docker：使用环境变量/现有 .env 的数据库与 Redis");
  }
  generateEnv();
  if (!opts.skipDeps) {
    if (!installDeps()) return;
  } else {
    ok("--skip-deps：跳过依赖安装与构建");
  }
  if (!opts.skipMigrate) {
    migrate();
  } else {
    ok("--skip-migrate：跳过数据库迁移");
  }
  summary();
}

/* ---------- 安装方式选择 ---------- */

async function resolveMode() {
  if (opts.mode) return opts.mode;
  console.log("");
  console.log(`${BOLD}请选择安装方式：${RESET}`);
  console.log(`  ${BOLD}1) 源码安装${RESET}（默认） 本机直接跑 Node，Docker 仅用于 PostgreSQL/Redis 基础设施`);
  console.log(`  ${BOLD}2) Docker Compose 全栈安装${RESET}  全部服务容器化（GHCR 镜像），适合生产/服务器`);
  const answer = await prompt("  请选择 [1/2]（回车默认 1）: ", "1");
  return answer === "2" ? "compose" : "source";
}

/* ---------- 入口 ---------- */

function usage() {
  console.log(`AperturePrism 一键安装脚本

用法:
  node scripts/install.mjs [选项]

选项:
  --mode=source|compose  安装方式：源码安装（默认）或 Docker Compose 全栈安装
  --yes, -y              跳过交互确认（默认按源码安装）
  --auto-install         缺失 Node / Docker Compose 时自动安装
  --verify               Compose 模式叠加 docker/compose.verify.yml（NAS 地址池耗尽场景）
  --skip-docker          源码模式：使用已有的 DATABASE_URL/REDIS_URL，不启动容器
  --skip-deps            跳过 npm install 与构建
  --skip-migrate         跳过数据库迁移
  --help                 显示帮助

示例:
  node scripts/install.mjs                        # 交互选择安装方式
  node scripts/install.mjs --mode=compose         # Docker Compose 全栈安装
  node scripts/install.mjs --mode=source --yes    # 源码安装，全默认
  node scripts/install.mjs --mode=compose --auto-install --yes

说明:
  - 已存在 .env / .env.production 时不会覆盖；自动生成 CREDENTIAL_MASTER_KEY 与 WEBUI_API_TOKEN。
  - GITHUB_* / EMBEDDING_* / GITHUB_OAUTH_* 等密钥需手动填写。`);
}

let opts;

async function main() {
  opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return;
  }
  console.log(`${BOLD}${CYAN}AperturePrism 一键安装${RESET}`);
  console.log("");

  if (!(await ensureNode())) return;
  if (!checkNpm()) return;

  const mode = await resolveMode();
  if (mode === "compose") {
    await installCompose();
  } else {
    await installSource();
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
