import { useCallback, useEffect, useState } from "react";
import {
  fetchSetupStatus,
  setupInit,
  type SetupInitResult,
  type SetupStatus,
} from "../lib/api";
import { navigate } from "../hooks/useHash";
import { CheckCircleIcon, GearIcon, RefreshIcon, XCircleIcon } from "../components/icons";

const STEPS = ["欢迎", "环境检测", "一键初始化", "完成"] as const;

export function SetupPage() {
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initResult, setInitResult] = useState<SetupInitResult | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(() => {
    setError(null);
    fetchSetupStatus()
      .then(setStatus)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "检测失败"));
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  const runInit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await setupInit();
      setInitResult(result);
      setStep(3);
      const fresh = await fetchSetupStatus();
      setStatus(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : "初始化失败");
    } finally {
      setBusy(false);
    }
  };

  const ok = status?.initialized ?? false;

  return (
    <div className="stack" style={{ maxWidth: 760, margin: "0 auto" }}>
      <div className="page-head">
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <img src="/aprism-logo.png" alt="AperturePrism" className="logo-img-lg" />
          <div>
            <h1 className="page-title">安装向导</h1>
            <p className="page-desc">环境检测与一键初始化，让 AperturePrism 快速就绪</p>
          </div>
        </div>
      </div>

      <div className="seg" style={{ alignSelf: "flex-start" }}>
        {STEPS.map((s, i) => (
          <button key={s} className={step === i ? "on" : ""} disabled>
            {i + 1}. {s}
          </button>
        ))}
      </div>

      {error ? <div className="panel"><p className="state state-error">错误：{error}</p></div> : null}

      {step === 0 && (
        <section className="panel">
          <div className="panel-title"><h2>欢迎使用 AperturePrism</h2></div>
          <p className="result-summary" style={{ lineHeight: 1.7 }}>
            本向导将依次：检测数据库 / 核心表 / 模型账户与策略是否就绪，然后一键写入默认模型策略，
            完成后即可登录使用。你可以在任意时候重新运行检测。
          </p>
          {status ? (
            <p className="state" style={{ color: ok ? "var(--ok)" : "var(--warn)" }}>
              {ok ? "系统已初始化，可以直接开始使用。" : "检测到系统尚未完全初始化。"}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button className="btn" onClick={check}><RefreshIcon size={16} /> 重新检测</button>
            <button className="btn btn-primary" onClick={() => setStep(1)}>开始检测 →</button>
          </div>
        </section>
      )}

      {step >= 1 && (
        <section className="panel">
          <div className="panel-title">
            <h2><GearIcon size={14} /> 环境检测</h2>
            <button className="btn btn-ghost" onClick={check}><RefreshIcon size={14} /> 重新检测</button>
          </div>
          {!status ? (
            <p className="state state-loading">正在检测…</p>
          ) : (
            <div className="dist" style={{ marginTop: 6 }}>
              <CheckRow ok={status.database.ok} label="数据库连接" hint={status.database.ok ? "已连通" : "无法连接 DATABASE_URL"} />
              <CheckRow ok={status.database.tablesReady === status.database.tablesTotal} label="核心表就绪" hint={`${status.database.tablesReady}/${status.database.tablesTotal} 张核心表`} />
              <CheckRow ok={status.provider.count > 0} label="模型账户" hint={status.provider.count > 0 ? `${status.provider.count} 个账户（${status.provider.providerKey}）` : "请先配置 provider_accounts"} />
              <CheckRow ok={status.policies.count >= status.policies.required} label="模型策略" hint={`${status.policies.count}/${status.policies.required} 个角色策略`} />
              <CheckRow ok={status.githubWebhookConfigured} label="GitHub Webhook" hint="GITHUB_WEBHOOK_SECRET" />
              <CheckRow ok={status.githubAppConfigured} label="GitHub App" hint="GITHUB_APP_ID + 私钥" />
              <CheckRow ok={status.embeddingConfigured} label="Embedding" hint="EMBEDDING_BASE_URL / KEY" />
              <CheckRow ok={status.oauthConfigured} label="GitHub OAuth" hint="GITHUB_OAUTH_CLIENT_ID / SECRET" />
            </div>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setStep(0)}>← 上一步</button>
            {ok ? (
              <button className="btn btn-primary" onClick={() => setStep(3)}>系统已就绪，下一步 →</button>
            ) : (
              <button className="btn btn-primary" onClick={runInit} disabled={busy || !status?.database.ok}>
                {busy ? "正在初始化…" : "一键初始化 →"}
              </button>
            )}
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="panel">
          <div className="panel-title"><h2><CheckCircleIcon size={14} /> 完成</h2></div>
          {initResult ? (
            <>
              <p className="state state-ok">
                初始化成功：{initResult.created > 0 ? `已创建 ${initResult.created} 条模型策略（${initResult.roles?.join(", ") ?? ""}）` : "无需变更"}
              </p>
              {initResult.skipped ? <p className="state state-warn">{initResult.skipped}</p> : null}
            </>
          ) : (
            <p className="state state-ok">系统已就绪。</p>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setStep(1)}>← 返回检测</button>
            <button className="btn btn-primary" onClick={() => navigate("/")}>进入系统 →</button>
          </div>
        </section>
      )}

      <section className="panel" style={{ borderStyle: "dashed" }}>
        <div className="panel-title"><h2>手动部署（可选）</h2></div>
        <pre className="jsonbox" style={{ margin: 0 }}>
{`npm install
npm run build
npm run db:migrate        # 应用数据库迁移
node apps/api/dist/apps/api/src/main.js
node apps/analysis-worker/dist/apps/analysis-worker/src/main.js
cd apps/web && npm run dev # WebUI`}
        </pre>
      </section>
    </div>
  );
}

function CheckRow({ ok, label, hint }: { ok: boolean; label: string; hint: string }) {
  return (
    <div className="dist-row">
      <span className="dist-label">{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", fontSize: 12 }}>
        {ok ? <CheckCircleIcon size={15} style={{ color: "var(--ok)" }} /> : <XCircleIcon size={15} style={{ color: "var(--err)" }} />}
        <span className="mono">{hint}</span>
      </span>
      <span className="dist-val">{ok ? "✓" : "✗"}</span>
    </div>
  );
}