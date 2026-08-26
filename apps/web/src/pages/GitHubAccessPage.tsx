import { useCallback, useEffect, useState } from "react";
import {
  bumpCache,
  fetchConfig,
  saveGithubApp,
  type RuntimeConfig,
} from "../lib/api";
import { GearIcon, RefreshIcon } from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";
import { explainUnknown } from "../lib/errors";
import { SettingsSection } from "../components/SettingsSection";
import { useToast } from "../components/Toast";

function BoolBadge({ ok, yes = "已配置", no = "未配置" }: { ok: boolean; yes?: string; no?: string }) {
  return <span className={ok ? "pill pill-ok" : "pill pill-dim"}>{ok ? yes : no}</span>;
}

function StatusItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="dist-row">
      <span className="dist-label">{label}</span>
      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>{children}</span>
    </div>
  );
}

/**
 * GitHub App 配置表单（唯一入口）。保存前先用候选凭据实调 GitHub /app 验证，
 * 凭据不对当场报错；私钥 AES-GCM 加密入库、界面不回显；保存后热重载无需重启。
 */
function GithubAppForm({ configured, onSaved }: { configured: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [appId, setAppId] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!appId.trim() || !privateKeyPem.trim()) {
      toast.error("App ID 与私钥均为必填");
      return;
    }
    setSaving(true);
    try {
      const result = await saveGithubApp({
        appId: appId.trim(),
        privateKeyPem: privateKeyPem.trim(),
      });
      toast.success(`已保存并验证通过：${result.appSlug || result.appId}，无需重启即可生效`);
      setAppId("");
      setPrivateKeyPem("");
      setOpen(false);
      bumpCache();
      onSaved();
    } catch (err) {
      toast.error(explainUnknown(err));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        <GearIcon size={16} />
        {configured ? "更换 GitHub App" : "配置 GitHub App"}
      </button>
    );
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>配置 GitHub App</h2>
        <span className="count">保存前会实际调用 GitHub 验证</span>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        <input
          className="input"
          placeholder="App ID（一串数字，在 App 设置页顶部；不是 Client ID）"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
        />
        <textarea
          className="input"
          style={{ minHeight: 120, fontFamily: "monospace", fontSize: 12 }}
          placeholder={"粘贴 GitHub 下载的 .pem 私钥全文，包含：\n-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"}
          value={privateKeyPem}
          onChange={(e) => setPrivateKeyPem(e.target.value)}
          data-lpignore="true"
        />
        <div className="filters">
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? "验证并保存中…" : "验证并保存"}
          </button>
          <button
            className="btn"
            onClick={() => {
              setAppId("");
              setPrivateKeyPem("");
              setOpen(false);
            }}
            disabled={saving}
          >
            取消
          </button>
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          GitHub App 用于访问仓库、同步与分析，与「GitHub OAuth」不同 —— 后者只用于登录
          WebUI，配置它无法修复同步仓库失败。私钥以 AES-GCM 加密存储，仅在进程内解密。
        </p>
      </div>
    </section>
  );
}

/** GitHub 接入：GitHub App / OAuth / Webhook 的单一配置归属。 */
export function GitHubAccessPage() {
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchConfig()
      .then(setCfg)
      .catch((err: unknown) => setError(explainUnknown(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">GitHub 接入</h1>
          <p className="page-desc">
            GitHub App 用于访问仓库 / 同步 / 分析；OAuth 仅用于 WebUI 登录 —— 两者是不同的事
          </p>
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
          <section className="panel">
            <div className="panel-title"><h2>接入状态</h2></div>
            <div className="dist" style={{ marginTop: 6 }}>
              <StatusItem label="GitHub App">
                <BoolBadge ok={Boolean(cfg?.githubAppConfigured)} yes="已配置" no="未配置" />
                <span className="faint" style={{ fontSize: 12 }}>仓库访问 / 同步 / 分析</span>
              </StatusItem>
              <StatusItem label="GitHub OAuth">
                <BoolBadge ok={Boolean(cfg?.oauthConfigured)} yes="已配置" no="未配置" />
                <span className="faint" style={{ fontSize: 12 }}>仅用于 WebUI 登录</span>
              </StatusItem>
              <StatusItem label="Webhook">
                <BoolBadge ok={Boolean(cfg?.githubWebhookConfigured)} yes="已配置" no="未配置" />
                <span className="faint" style={{ fontSize: 12 }}>
                  {window.location.origin}/github/webhook
                </span>
              </StatusItem>
            </div>
          </section>

          <GithubAppForm
            configured={Boolean(cfg?.githubAppConfigured)}
            onSaved={load}
          />

          {cfg?.githubAppConfigured && cfg.githubAppSlug ? (
            <section className="panel">
              <div className="panel-title">
                <h2>安装 / 授权仓库</h2>
                <span className="count">{cfg.githubAppSlug}</span>
              </div>
              <p className="faint" style={{ margin: "0 0 10px", fontSize: 12 }}>
                已配置 GitHub App <code className="mono">{cfg.githubAppSlug}</code>。系统只能看到
                <strong>该 App 被安装到的账号 + 已勾选的仓库</strong> —— 若「已安装仓库」页为空或缺少仓库，
                请到 GitHub 完成安装并勾选仓库：
              </p>
              <div className="dist" style={{ marginTop: 4 }}>
                <div className="dist-row">
                  <span className="dist-label">首次安装</span>
                  <span>
                    <a
                      className="btn"
                      href={`https://github.com/apps/${cfg.githubAppSlug}/installations/new`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      安装到账号并选择仓库 ↗
                    </a>
                  </span>
                </div>
                <div className="dist-row">
                  <span className="dist-label">添加仓库</span>
                  <span>
                    <a
                      className="btn"
                      href={`https://github.com/apps/${cfg.githubAppSlug}/installations`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      管理已安装的仓库授权 ↗
                    </a>
                    <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                      在安装详情里勾选更多仓库即可
                    </span>
                  </span>
                </div>
              </div>
              <p className="faint" style={{ margin: "12px 0 0", fontSize: 12 }}>
                授权后点击「已安装仓库」页的「同步仓库」即可拉取；系统每小时也会自动同步一次。
              </p>
            </section>
          ) : null}

          <SettingsSection
            keys={["oauth_client_id", "oauth_client_secret"]}
            title="GitHub OAuth（WebUI 登录）"
            desc="仅用于本界面登录；与仓库访问用的 GitHub App 无关"
            onSaved={load}
          />

          <SettingsSection
            keys={["github_webhook_enabled", "github_webhook_secret"]}
            title="Webhook 事件入口"
            desc="在 GitHub 仓库 Settings → Webhooks 指向下方地址；Secret 粘贴到仓库的 Secret 字段"
            onSaved={load}
          />
        </div>
      )}
    </div>
  );
}
