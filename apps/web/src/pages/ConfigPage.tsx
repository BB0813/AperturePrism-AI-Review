import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchBackup,
  fetchConfig,
  fetchSettings,
  importBackup,
  saveSetting,
  type RuntimeConfig,
  type SettingItem,
} from "../lib/api";
import { DownloadIcon, GearIcon, RefreshIcon, UploadIcon } from "../components/icons";
import { LoadingRows } from "../components/ui";

function BoolBadge({ ok, yes = "已启用", no = "未配置" }: { ok: boolean; yes?: string; no?: string }) {
  return <span className={ok ? "pill pill-ok" : "pill pill-dim"}>{ok ? yes : no}</span>;
}

const FIELD_META: Record<string, { label: string; hint: string; secret: boolean }> = {
  github_webhook_enabled: {
    label: "Webhook 开关",
    hint: "true 启用 / false 停用 GitHub 事件入口",
    secret: false,
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
};

function Row({ it, drafts, setDrafts, save, busyKey }: {
  it: SettingItem;
  drafts: Record<string, string>;
  setDrafts: (fn: (p: Record<string, string>) => Record<string, string>) => void;
  save: (key: string) => void;
  busyKey: string | null;
}) {
  const meta = FIELD_META[it.key];
  if (!meta) return null;
  return (
    <div className="result-card">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{meta.label}</span>
        {it.hasValue ? <span className="pill pill-info">已覆盖</span> : <span className="pill pill-dim">使用环境变量</span>}
      </div>
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
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [items, setItems] = useState<SettingItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
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
        setError(err instanceof Error ? err.message : "failed to load config");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const save = async (key: string) => {
    setBusyKey(key);
    setMessage(null);
    try {
      await saveSetting(key, (drafts[key] ?? "").trim());
      setMessage({ text: `已保存并热生效：${FIELD_META[key]?.label ?? key}`, ok: true });
      const fresh = await fetchSettings();
      setItems(fresh.items);
      setDrafts((prev) => ({ ...prev, [key]: "" }));
    } catch (err) {
      setMessage({ text: `保存失败：${err instanceof Error ? err.message : err}`, ok: false });
    } finally {
      setBusyKey(null);
    }
  };

  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMsg, setBackupMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const doExport = async () => {
    setBackupBusy(true);
    setBackupMsg(null);
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
      setBackupMsg({
        text: `已导出：设置 ${snapshot.settings.length} 项（密钥值已脱敏）、策略 ${snapshot.policies.length} 条、Provider ${snapshot.providers.length} 个。`,
        ok: true,
      });
    } catch (err) {
      setBackupMsg({ text: `导出失败：${err instanceof Error ? err.message : err}`, ok: false });
    } finally {
      setBackupBusy(false);
    }
  };

  const onFilePicked = async (file: File | undefined) => {
    if (!file) return;
    setBackupBusy(true);
    setBackupMsg(null);
    try {
      const text = await file.text();
      const snapshot = JSON.parse(text);
      const result = await importBackup(snapshot);
      setBackupMsg({
        text: `导入完成：设置 ${result.settings} 项、策略 ${result.policies} 条；跳过密钥 ${result.skippedSecrets.join("/") || "无"}，Provider 账户需手工确认 ${result.skippedProviders.join("/") || "无"}。`,
        ok: true,
      });
    } catch (err) {
      setBackupMsg({ text: `导入失败：${err instanceof Error ? err.message : err}`, ok: false });
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
          <button className="btn" onClick={load} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <div className="panel"><p className="state state-error">加载失败：{error}</p></div>
      ) : loading ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          <section className="panel">
            <div className="panel-title"><h2><GearIcon size={14} /> 热更新设置</h2></div>
            {message ? (
              <p className={`state ${message.ok ? "state-ok" : "state-error"}`} style={{ margin: "0 0 12px" }}>
                {message.text}
              </p>
            ) : null}
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
                  <span className="faint" style={{ fontSize: 12 }}>QQ_OFFICIAL_APP_ID / SECRET</span>
                </StatusItem>
                <StatusItem label="NTQQ 第三方协议">
                  {cfg.qqBotProtocols.length > 0 ? (
                    <span className="tag-row">
                      {cfg.qqBotProtocols.map((p) => <span key={p} className="tag">{p}</span>)}
                    </span>
                  ) : (
                    <span className="faint" style={{ fontSize: 12 }}>未配置（QQ_BOT_PROTOCOLS）</span>
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
              QQ 与 OAuth 凭据通过环境变量注入（避免进入数据库），改动后需重启生效。
            </p>
          </section>

          <section className="panel">
            <div className="panel-title"><h2><DownloadIcon size={14} /> 配置备份</h2><span className="count">导出 / 导入设置与策略</span></div>
            {backupMsg ? (
              <p className={`state ${backupMsg.ok ? "state-ok" : "state-error"}`} style={{ margin: "0 0 12px" }}>
                {backupMsg.text}
              </p>
            ) : null}
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
        </div>
      )}
    </div>
  );
}