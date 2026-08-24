import { useCallback, useEffect, useRef, useState } from "react";
import {
  bumpCache,
  fetchBackup,
  fetchConfig,
  fetchSettings,
  importBackup,
  saveSetting,
  type RuntimeConfig,
  type SettingItem,
} from "../lib/api";
import { DownloadIcon, GearIcon, RefreshIcon, UploadIcon } from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";
import { explainUnknown } from "../lib/errors";
import { UpdatePanel } from "../components/UpdatePanel";
import { useToast } from "../components/Toast";

function BoolBadge({ ok, yes = "已启用", no = "未配置" }: { ok: boolean; yes?: string; no?: string }) {
  return <span className={ok ? "pill pill-ok" : "pill pill-dim"}>{ok ? yes : no}</span>;
}

type FieldMeta = {
  label: string;
  hint: string;
  secret: boolean;
  /** 布尔项渲染为开关，避免让用户手写 true/false（issue #7）。 */
  kind?: "boolean";
  /** 未覆盖时的应用默认值，决定开关初始状态。 */
  defaultOn?: boolean;
};

const FIELD_META: Record<string, FieldMeta> = {
  github_webhook_enabled: {
    label: "Webhook 开关",
    hint: "启用 / 停用 GitHub 事件入口；未覆盖时跟随环境变量",
    secret: false,
    kind: "boolean",
    defaultOn: false,
  },
  github_webhook_secret: {
    label: "Webhook 签名密钥",
    hint: "留空则回退到环境变量；保存后无需重启即生效",
    secret: true,
  },
  webui_api_token: {
    label: "WebUI 访问令牌",
    hint: "留空则用环境变量；注意：改为此处的新值后，本次会话会被登出，下次用新 token 进入",
    secret: true,
  },
  log_level: {
    label: "日志级别",
    hint: "debug / info / warn / error，保存后约 8 秒内生效",
    secret: false,
  },
  spam_handling: {
    label: "广告 Issue 处理",
    hint: "none 不处理 / close 关闭 / delete 删除；分析前自识别广告类 Issue",
    secret: false,
  },
  issue_auto_assign: {
    label: "Issue 自动指派",
    hint: "分析完成后自动指派 Issue；留空 issue_assignee 时默认指派仓库所有者与协作者，并跳过作者本人",
    secret: false,
    kind: "boolean",
    defaultOn: false,
  },
  issue_assignee: {
    label: "Issue 指派对象",
    hint: "GitHub 用户名；留空则默认指派给仓库所有者与协作者",
    secret: false,
  },
  issue_rewrite_title: {
    label: "Issue 标题改写",
    hint: "把含糊的标题改写为 [标签][重要度]清晰标题，方便在列表页直接判断内容；默认开启",
    secret: false,
    kind: "boolean",
    defaultOn: true,
  },
  issue_deep_analysis: {
    label: "Issue 深度分析（读取源码）",
    hint: "开启后分析会读取仓库源码来定位问题，给出到文件的修复建议；会明显增加用时与 token 消耗。注意：需要模型网关支持 tools/function calling，当前 newapi 网关实测返回 server_error，开启后任务会失败重试。关闭时不会给出带行号的建议，避免凭空猜测",
    secret: false,
    kind: "boolean",
    defaultOn: false,
  },
  pr_check_run: {
    label: "PR Check Run 可视化",
    hint: "在 PR 页面显示 AI 审查的 Check（进行中→完成，需 GitHub App 授予 checks: write 权限；无权限时自动跳过不影响审查）",
    secret: false,
    kind: "boolean",
    defaultOn: true,
  },
  pr_auto_review: {
    label: "PR 自动提交 Review",
    hint: "开启则审查完成后提交正式 Review（含行内评论）；关闭则只发一条摘要评论，不占 Review 名额",
    secret: false,
    kind: "boolean",
    defaultOn: true,
  },
  oauth_client_id: {
    label: "GitHub OAuth Client ID",
    hint: "GitHub OAuth App 的 Client ID；留空则用环境变量",
    secret: false,
  },
  oauth_client_secret: {
    label: "GitHub OAuth Client Secret",
    hint: "留空则用环境变量；可在安装向导的 GitHub 接入步骤自动生成",
    secret: true,
  },
  embedding_base_url: {
    label: "Embedding Base URL",
    hint: "留空则用 EMBEDDING_BASE_URL；保存后索引任务自动生效",
    secret: false,
  },
  embedding_api_key: {
    label: "Embedding API Key",
    hint: "留空则用 EMBEDDING_API_KEY；保存后索引任务自动生效",
    secret: true,
  },
  embedding_model: {
    label: "Embedding 模型",
    hint: "留空则用 EMBEDDING_MODEL（默认 nvidia/nv-embed-v1）",
    secret: false,
  },
  // QQ 机器人配置改在「数据与运维 → 机器人」页维护：那里有分协议的表单与
  // 接入状态，比在这里手写 JSON 更清楚。后端设置键保持不变。
};

function Row({ it, drafts, setDrafts, save, busyKey }: {
  it: SettingItem;
  drafts: Record<string, string>;
  setDrafts: (fn: (p: Record<string, string>) => Record<string, string>) => void;
  save: (key: string, value?: string) => void;
  busyKey: string | null;
}) {
  const meta = FIELD_META[it.key];
  if (!meta) return null;
  // 布尔项：已覆盖时读取实际值，未覆盖时用应用默认值。
  const on = it.hasValue ? it.value === "true" : (meta.defaultOn ?? false);
  return (
    <div className="result-card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{meta.label}</span>
        {it.hasValue ? <span className="pill pill-info">已覆盖</span> : <span className="pill pill-dim">使用环境变量</span>}
      </div>
      {meta.kind === "boolean" ? (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={meta.label}
            className="switch"
            data-on={on ? "true" : "false"}
            disabled={busyKey === it.key}
            onClick={() => save(it.key, on ? "false" : "true")}
          >
            <span className="switch-knob" />
          </button>
          <span className="faint" style={{ marginLeft: 10, fontSize: 12 }}>
            {busyKey === it.key ? "保存中…" : on ? "已开启" : "已关闭"}
          </span>
        </div>
      ) : (
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 260px" }}
            type={meta.secret ? "password" : "text"}
            placeholder={meta.secret ? "••••••••" : "输入新值"}
            value={drafts[it.key] ?? ""}
            onChange={(event) => setDrafts((p) => ({ ...p, [it.key]: event.target.value }))}
            data-lpignore="true"
          />
          <button className="btn btn-primary" onClick={() => save(it.key)} disabled={busyKey === it.key}>
            {busyKey === it.key ? "保存中…" : "保存"}
          </button>
        </div>
      )}
      <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>{meta.hint}</p>
    </div>
  );
}

function StatusItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="dist-row">
      <span className="dist-label">{label}</span>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{children}</span>
    </div>
  );
}

export function ConfigPage() {
  const toast = useToast();
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [items, setItems] = useState<SettingItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchConfig(), fetchSettings()])
      .then(([c, s]) => {
        setCfg(c);
        setItems(s.items);
        setDrafts({});
      })
      .catch((err: unknown) => {
        setError(explainUnknown(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const save = async (key: string, value?: string) => {
    setBusyKey(key);
    try {
      // 布尔开关直接传值；文本项仍走草稿。
      await saveSetting(key, value ?? (drafts[key] ?? "").trim());
      toast.success(`已保存并热生效：${FIELD_META[key]?.label ?? key}`);
      const fresh = await fetchSettings();
      setItems(fresh.items);
      setDrafts((prev) => ({ ...prev, [key]: "" }));
    } catch (err) {
      toast.error(`保存失败：${explainUnknown(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const [backupBusy, setBackupBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const doExport = async () => {
    setBackupBusy(true);
    try {
      const snapshot = await fetchBackup();
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `apertureprism-backup-${snapshot.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success(
        `已导出：设置 ${snapshot.settings.length} 项（密钥值已脱敏）、策略 ${snapshot.policies.length} 条、Provider ${snapshot.providers.length} 个。`,
      );
    } catch (err) {
      toast.error(`导出失败：${explainUnknown(err)}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const onFilePicked = async (file: File | undefined) => {
    if (!file) return;
    setBackupBusy(true);
    try {
      const text = await file.text();
      const snapshot = JSON.parse(text);
      const result = await importBackup(snapshot);
      toast.success(
        `导入完成：设置 ${result.settings} 项、策略 ${result.policies} 条；跳过密钥 ${result.skippedSecrets.join("/") || "无"}，Provider 账户需手工确认 ${result.skippedProviders.join("/") || "无"}。`,
      );
      // 导入改的是当前页正在展示的数据，不刷新会让用户基于旧值继续编辑。
      bumpCache();
      load();
    } catch (err) {
      toast.error(`导入失败：${explainUnknown(err)}`);
    } finally {
      setBackupBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">系统设置</h1>
          <p className="page-desc">运行时配置（含可热更新项）与接入状态总览</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => { bumpCache(); load(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <ErrorPanel error={error} onRetry={load} />
      ) : loading ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          <UpdatePanel />

          <section className="panel">
            <div className="panel-title"><h2><GearIcon size={14} /> 热更新设置</h2></div>
            <div className="stack">
              {items.map((it) => (
                <Row key={it.key} it={it} drafts={drafts} setDrafts={setDrafts} save={save} busyKey={busyKey} />
              ))}
            </div>
          </section>

          <div className="grid2">
            <section className="panel">
              <div className="panel-title"><h2>服务</h2></div>
              {cfg && (
                <dl className="kv">
                  <dt>监听地址</dt><dd className="mono">{cfg.host}:{cfg.port}</dd>
                  <dt>日志级别</dt><dd><span className="chip">{cfg.logLevel}</span></dd>
                  <dt>WebUI 认证</dt><dd><BoolBadge ok={cfg.webuiAuthEnabled} /></dd>
                  <dt>模型 Provider</dt>
                  <dd>
                    {cfg.modelProviders.length > 0 ? (
                      <span className="tag-row">{cfg.modelProviders.map((p) => <span key={p} className="tag">{p}</span>)}</span>
                    ) : <span className="faint">未配置</span>}
                  </dd>
                </dl>
              )}
            </section>

            <section className="panel">
              <div className="panel-title"><h2>接入与依赖</h2></div>
              {cfg && (
                <dl className="kv">
                  <dt>GitHub Webhook</dt><dd><BoolBadge ok={cfg.githubWebhookConfigured} /></dd>
                  <dt>GitHub App</dt><dd><BoolBadge ok={cfg.githubAppConfigured} /></dd>
                  <dt>GitHub OAuth</dt><dd><BoolBadge ok={cfg.oauthConfigured} /></dd>
                  <dt>Embedding</dt><dd><BoolBadge ok={cfg.embeddingConfigured} /></dd>
                  <dt>Embedding 模型</dt><dd className="mono">{cfg.embeddingModel}</dd>
                </dl>
              )}
            </section>
          </div>

          <section className="panel">
            <div className="panel-title"><h2>Bot 设置</h2><span className="count">配置见环境变量</span></div>
            {cfg && (
              <div className="dist" style={{ marginTop: 6 }}>
                <StatusItem label="官方 QQ 机器人">
                  <BoolBadge ok={cfg.qqOfficialConfigured} yes="已配置" no="未配置" />
                  <span className="faint" style={{ fontSize: 12 }}>在「机器人」页配置</span>
                </StatusItem>
                <StatusItem label="NTQQ 第三方协议">
                  {cfg.qqBotProtocols.length > 0 ? (
                    <span className="tag-row">
                      {cfg.qqBotProtocols.map((p) => <span key={p} className="tag">{p}</span>)}
                    </span>
                  ) : (
                    <span className="faint" style={{ fontSize: 12 }}>未配置（在「机器人」页配置）</span>
                  )}
                </StatusItem>
                <StatusItem label="GitHub OAuth 登录">
                  <BoolBadge ok={cfg.oauthConfigured} yes="可用" no="未配置" />
                  <span className="faint" style={{ fontSize: 12 }}>
                    {cfg.oauthConfigured
                      ? cfg.oauthEnabled ? "登录页显示 GitHub 按钮" : "登录页显示 GitHub + 令牌双入口"
                      : "需 GITHUB_OAUTH_CLIENT_ID / SECRET"}
                  </span>
                </StatusItem>
              </div>
            )}
            <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
              OAuth 凭据在「热更新设置」保存后无需重启即生效。QQ 机器人的
              AppID / AppSecret 与第三方协议请在「数据与运维 → 机器人」页配置；
              保存后需重启 qq-bot 容器才会按新配置连接网关。
            </p>
          </section>

          <section className="panel">
            <div className="panel-title"><h2><DownloadIcon size={14} /> 配置备份</h2><span className="count">导出 / 导入设置与策略</span></div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn btn-primary" onClick={doExport} disabled={backupBusy}>
                <DownloadIcon size={14} />
                {backupBusy ? "处理中…" : "导出配置"}
              </button>
              <button className="btn" onClick={() => fileRef.current?.click()} disabled={backupBusy}>
                <UploadIcon size={14} />
                导入配置
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(event) => onFilePicked(event.target.files?.[0])}
              />
            </div>
            <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
              导出包含热更新设置（密钥值脱敏）、模型角色策略与 Provider 名称；导入仅恢复非密钥设置与
              issue_analysis / pr_review / duplicate_judgment 策略。Provider 凭据始终保存在数据库，不从备份还原。
            </p>
          </section>

          <p className="faint" style={{ fontSize: 12 }}>
            标签规则已移至独立菜单「标签配置」维护。
          </p>
        </div>
      )}
    </div>
  );
}