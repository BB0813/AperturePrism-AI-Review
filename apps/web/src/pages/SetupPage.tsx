import { useCallback, useEffect, useState } from "react";
import {
  fetchModels,
  fetchSetupStatus,
  genWebhookSecret,
  saveEmbedding,
  saveOAuth,
  saveProvider,
  setupInit,
  type SetupInitResult,
  type SetupStatus,
} from "../lib/api";
import { navigate } from "../hooks/useHash";
import { CheckCircleIcon, GearIcon, RefreshIcon, XCircleIcon } from "../components/icons";

const STEPS = [
  "欢迎",
  "环境检测",
  "LLM 模型接入",
  "Embedding 接入",
  "GitHub 接入",
  "一键初始化",
  "完成",
] as const;

export function SetupPage() {
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initResult, setInitResult] = useState<SetupInitResult | null>(null);
  const [busy, setBusy] = useState(false);
  // Captured from /setup/status while uninitialized; after init the API stops
  // exposing it, so keep the value locally to display on the completion page.
  const [webuiToken, setWebuiToken] = useState<string>("");

  const check = useCallback(() => {
    setError(null);
    fetchSetupStatus()
      .then((s) => {
        setStatus(s);
        if (s.webuiToken) setWebuiToken(s.webuiToken);
      })
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
      setStep(STEPS.length - 1);
      const fresh = await fetchSetupStatus();
      setStatus(fresh);
      if (fresh.webuiToken) setWebuiToken(fresh.webuiToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "初始化失败");
    } finally {
      setBusy(false);
    }
  };

  /* ---------- LLM provider form ---------- */
  const [llmProvider, setLlmProvider] = useState("newapi");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [llmModels, setLlmModels] = useState<string[]>([]);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmMsg, setLlmMsg] = useState<string | null>(null);

  const fetchLlmModels = async () => {
    if (!llmBaseUrl || !llmApiKey) {
      setLlmMsg("请先填写 Base URL 和 API Key 再拉取模型列表");
      return;
    }
    setLlmBusy(true);
    setLlmMsg(null);
    try {
      const models = await fetchModels(llmBaseUrl, llmApiKey);
      setLlmModels(models);
      setLlmMsg(models.length > 0 ? `拉取到 ${models.length} 个模型` : "该端点未返回模型列表");
      if (models.length > 0 && !llmModel) setLlmModel(models[0]!);
    } catch (err) {
      setLlmMsg(err instanceof Error ? err.message : "拉取模型列表失败");
    } finally {
      setLlmBusy(false);
    }
  };

  const saveLlm = async () => {
    if (!llmProvider || !llmBaseUrl || !llmApiKey || !llmModel) {
      setLlmMsg("请完整填写提供商名称、Base URL、API Key 和模型");
      return;
    }
    setLlmSaving(true);
    setLlmMsg(null);
    try {
      const r = await saveProvider({
        provider: llmProvider,
        baseUrl: llmBaseUrl,
        apiKey: llmApiKey,
        model: llmModel,
      });
      setLlmMsg(`已保存 ${r.provider}/${r.accountName}（${r.model}），已写入 ${r.policiesUpdated} 个角色策略`);
      await check();
    } catch (err) {
      setLlmMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setLlmSaving(false);
    }
  };

  /* ---------- Embedding form ---------- */
  const [embBaseUrl, setEmbBaseUrl] = useState("");
  const [embApiKey, setEmbApiKey] = useState("");
  const [embModel, setEmbModel] = useState("");
  const [embModels, setEmbModels] = useState<string[]>([]);
  const [embBusy, setEmbBusy] = useState(false);
  const [embSaving, setEmbSaving] = useState(false);
  const [embMsg, setEmbMsg] = useState<string | null>(null);

  const fetchEmbModels = async () => {
    if (!embBaseUrl || !embApiKey) {
      setEmbMsg("请先填写 Base URL 和 API Key 再拉取模型列表");
      return;
    }
    setEmbBusy(true);
    setEmbMsg(null);
    try {
      const models = await fetchModels(embBaseUrl, embApiKey);
      setEmbModels(models);
      setEmbMsg(models.length > 0 ? `拉取到 ${models.length} 个模型` : "该端点未返回模型列表");
      if (models.length > 0 && !embModel) setEmbModel(models[0]!);
    } catch (err) {
      setEmbMsg(err instanceof Error ? err.message : "拉取模型列表失败");
    } finally {
      setEmbBusy(false);
    }
  };

  const saveEmb = async () => {
    if (!embBaseUrl || !embApiKey || !embModel) {
      setEmbMsg("请完整填写 Base URL、API Key 和模型");
      return;
    }
    setEmbSaving(true);
    setEmbMsg(null);
    try {
      await saveEmbedding({ baseUrl: embBaseUrl, apiKey: embApiKey, model: embModel });
      setEmbMsg(`已保存 Embedding 配置（${embModel}），索引任务将自动使用`);
      await check();
    } catch (err) {
      setEmbMsg(err instanceof Error ? err.message : "保存失败");
    } finally {
      setEmbSaving(false);
    }
  };

  /* ---------- GitHub auto-generate ---------- */
  const [whSecret, setWhSecret] = useState("");
  const [whBusy, setWhBusy] = useState(false);
  const [whMsg, setWhMsg] = useState<string | null>(null);
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthSecret, setOauthSecret] = useState("");
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthMsg, setOauthMsg] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");

  const genWh = async () => {
    setWhBusy(true);
    setWhMsg(null);
    try {
      const secret = await genWebhookSecret();
      setWhSecret(secret);
      setWhMsg("已生成 Webhook 密钥，请粘贴到 GitHub 仓库的 Webhook 配置中");
      await check();
    } catch (err) {
      setWhMsg(err instanceof Error ? err.message : "生成失败");
    } finally {
      setWhBusy(false);
    }
  };

  const genOAuth = async () => {
    setOauthBusy(true);
    setOauthMsg(null);
    try {
      const r = await saveOAuth({ clientId: oauthClientId || undefined });
      setOauthClientId(r.clientId);
      setOauthSecret(r.clientSecret);
      setCallbackUrl(`${window.location.origin}${r.callbackPath}`);
      setOauthMsg("已生成 Client Secret，请填入 GitHub OAuth App 并保存");
      await check();
    } catch (err) {
      setOauthMsg(err instanceof Error ? err.message : "生成失败");
    } finally {
      setOauthBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  };

  const ok = status?.initialized ?? false;

  return (
    <div className="stack" style={{ maxWidth: 820, margin: "0 auto" }}>
      <div className="page-head">
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <img src="/aprism-logo.png" alt="AperturePrism" className="logo-img-lg" />
          <div>
            <h1 className="page-title">安装向导</h1>
            <p className="page-desc">环境检测、模型接入与 GitHub 接入，一步步完成部署</p>
          </div>
        </div>
      </div>

      <div className="seg" style={{ alignSelf: "flex-start", flexWrap: "wrap" }}>
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
            向导将依次完成：环境检测（数据库 / 核心表 / 模型账户与策略）→ 配置 LLM 模型接入
            （API Key 加密入库，自动写入角色策略）→ 配置 Embedding 模型 → 自动生成 GitHub
            Webhook / OAuth 密钥 → 一键初始化 → 保存访问密钥。
          </p>
          {status ? (
            <p className="state" style={{ color: ok ? "var(--ok)" : "var(--warn)" }}>
              {ok ? "系统已初始化，各步骤可直接查看或按需调整。" : "检测到系统尚未完全初始化，建议按步骤完成配置。"}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            <button className="btn" onClick={check}><RefreshIcon size={16} /> 重新检测</button>
            <button className="btn btn-primary" onClick={() => setStep(1)}>开始 →</button>
          </div>
        </section>
      )}

      {step === 1 && (
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
              <CheckRow ok={status.provider.count > 0} label="模型账户" hint={status.provider.count > 0 ? `${status.provider.count} 个账户（${status.provider.providerKey}）` : "请配置模型接入"} />
              <CheckRow ok={status.policies.count >= status.policies.required} label="模型策略" hint={`${status.policies.count}/${status.policies.required} 个角色策略`} />
              <CheckRow ok={status.githubWebhookConfigured} label="GitHub Webhook" hint="自动生成密钥或 GITHUB_WEBHOOK_SECRET" />
              <CheckRow ok={status.githubAppConfigured} label="GitHub App" hint="GITHUB_APP_ID + 私钥" />
              <CheckRow ok={status.embeddingConfigured} label="Embedding" hint="EMBEDDING_BASE_URL / KEY" />
              <CheckRow ok={status.oauthConfigured} label="GitHub OAuth" hint="GITHUB_OAUTH_CLIENT_ID / SECRET" />
            </div>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setStep(0)}>← 上一步</button>
            <button className="btn btn-primary" onClick={() => setStep(2)}>下一步：模型接入 →</button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="panel">
          <div className="panel-title"><h2><GearIcon size={14} /> LLM 模型接入</h2></div>
          <p className="result-summary" style={{ lineHeight: 1.6 }}>
            填写 OpenAI 兼容网关的地址与密钥，点击「拉取模型列表」选择模型；保存后 API Key 会用
            CREDENTIAL_MASTER_KEY 加密入库，并自动写入全部角色策略（原有提供商保留为备选）。
          </p>
          <div className="field">
            <label htmlFor="llm-provider">提供商名称</label>
            <input id="llm-provider" className="input" value={llmProvider} onChange={(e) => setLlmProvider(e.target.value)} placeholder="如 newapi" />
          </div>
          <div className="field">
            <label htmlFor="llm-base">Base URL</label>
            <input id="llm-base" className="input" value={llmBaseUrl} onChange={(e) => setLlmBaseUrl(e.target.value)} placeholder="https://newapi.binbim.top/v1" />
          </div>
          <div className="field">
            <label htmlFor="llm-key">API Key</label>
            <input id="llm-key" className="input" type="password" value={llmApiKey} onChange={(e) => setLlmApiKey(e.target.value)} placeholder="sk-..." />
          </div>
          <div className="field">
            <label>模型</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {llmModels.length > 0 ? (
                <select className="input" style={{ flex: 1 }} value={llmModel} onChange={(e) => setLlmModel(e.target.value)}>
                  {llmModels.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : (
                <input className="input" style={{ flex: 1 }} value={llmModel} onChange={(e) => setLlmModel(e.target.value)} placeholder="deepseek-v4-flash" />
              )}
              <button className="btn" onClick={fetchLlmModels} disabled={llmBusy}>
                {llmBusy ? "拉取中…" : "拉取模型列表"}
              </button>
            </div>
          </div>
          {llmMsg ? <p className="state" style={{ color: llmMsg.startsWith("已保存") ? "var(--ok)" : "var(--warn)" }}>{llmMsg}</p> : null}
          <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setStep(1)}>← 上一步</button>
            <button className="btn" onClick={saveLlm} disabled={llmSaving}>
              {llmSaving ? "保存中…" : "保存模型接入"}
            </button>
            <button className="btn btn-primary" onClick={() => setStep(3)}>下一步：Embedding →</button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section className="panel">
          <div className="panel-title"><h2><GearIcon size={14} /> Embedding 接入</h2></div>
          <p className="result-summary" style={{ lineHeight: 1.6 }}>
            配置用于重复检测 / RAG 的 Embedding 模型。保存后索引任务会热加载该配置，无需重启。
          </p>
          <div className="field">
            <label htmlFor="emb-base">Embedding Base URL</label>
            <input id="emb-base" className="input" value={embBaseUrl} onChange={(e) => setEmbBaseUrl(e.target.value)} placeholder="https://newapi.binbim.top/v1" />
          </div>
          <div className="field">
            <label htmlFor="emb-key">API Key</label>
            <input id="emb-key" className="input" type="password" value={embApiKey} onChange={(e) => setEmbApiKey(e.target.value)} placeholder="sk-..." />
          </div>
          <div className="field">
            <label>模型</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {embModels.length > 0 ? (
                <select className="input" style={{ flex: 1 }} value={embModel} onChange={(e) => setEmbModel(e.target.value)}>
                  {embModels.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              ) : (
                <input className="input" style={{ flex: 1 }} value={embModel} onChange={(e) => setEmbModel(e.target.value)} placeholder="nvidia/nv-embed-v1" />
              )}
              <button className="btn" onClick={fetchEmbModels} disabled={embBusy}>
                {embBusy ? "拉取中…" : "拉取模型列表"}
              </button>
            </div>
          </div>
          {embMsg ? <p className="state" style={{ color: embMsg.startsWith("已保存") ? "var(--ok)" : "var(--warn)" }}>{embMsg}</p> : null}
          <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setStep(2)}>← 上一步</button>
            <button className="btn" onClick={saveEmb} disabled={embSaving}>
              {embSaving ? "保存中…" : "保存 Embedding"}
            </button>
            <button className="btn btn-primary" onClick={() => setStep(4)}>下一步：GitHub 接入 →</button>
          </div>
        </section>
      )}

      {step === 4 && (
        <section className="panel">
          <div className="panel-title"><h2><GearIcon size={14} /> GitHub 接入</h2></div>

          <div className="panel" style={{ borderStyle: "dashed", marginBottom: 10 }}>
            <div className="panel-title"><h3>Webhook 密钥（自动生成）</h3></div>
            <p className="state" style={{ marginBottom: 8 }}>
              生成后请到 GitHub 仓库 Settings → Webhooks 新建 Webhook，Payload URL 填
              <code className="mono">{window.location.origin}/github/webhook</code>，Secret 粘贴下面密钥，Content type 选 application/json。
            </p>
            {whSecret ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <code className="jsonbox" style={{ flex: "1 1 260px", margin: 0, wordBreak: "break-all" }}>{whSecret}</code>
                <button className="btn" onClick={() => { void copy(whSecret); setWhMsg("已复制 Webhook 密钥"); }}>复制</button>
              </div>
            ) : null}
            {whMsg ? <p className="state" style={{ color: "var(--warn)" }}>{whMsg}</p> : null}
            <div style={{ marginTop: 8 }}>
              <button className="btn" onClick={genWh} disabled={whBusy}>{whBusy ? "生成中…" : "生成 Webhook 密钥"}</button>
            </div>
          </div>

          <div className="panel" style={{ borderStyle: "dashed", marginBottom: 10 }}>
            <div className="panel-title"><h3>GitHub OAuth（自动生成 Client Secret）</h3></div>
            <p className="state" style={{ marginBottom: 8 }}>
              在 GitHub Settings → Developer settings → OAuth Apps 新建应用，回调地址填
              <code className="mono">{window.location.origin}/auth/callback</code>；把应用的 Client ID 填到下面，点「生成并保存 Client Secret」。
            </p>
            <div className="field">
              <label htmlFor="oauth-cid">Client ID</label>
              <input id="oauth-cid" className="input" value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} placeholder="Iv1.xxxx" />
            </div>
            {oauthSecret ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
                <code className="jsonbox" style={{ flex: "1 1 260px", margin: 0, wordBreak: "break-all" }}>{oauthSecret}</code>
                <button className="btn" onClick={() => { void copy(oauthSecret); setOauthMsg("已复制 Client Secret"); }}>复制</button>
              </div>
            ) : null}
            {callbackUrl ? <p className="state" style={{ color: "var(--muted)", marginBottom: 4 }}>回调地址：<code className="mono">{callbackUrl}</code></p> : null}
            {oauthMsg ? <p className="state" style={{ color: "var(--warn)" }}>{oauthMsg}</p> : null}
            <div style={{ marginTop: 8 }}>
              <button className="btn" onClick={genOAuth} disabled={oauthBusy}>{oauthBusy ? "生成中…" : "生成并保存 Client Secret"}</button>
            </div>
          </div>

          <div className="panel" style={{ borderStyle: "dashed" }}>
            <div className="panel-title"><h3>GitHub App</h3></div>
            <p className="state" style={{ marginBottom: 4 }}>
              GitHub App 需要在 GitHub 开发者设置里手动创建（获取 App ID 并下载私钥 PEM），无法通过 API 自动创建。
              创建后在部署环境设置 <code className="mono">GITHUB_APP_ID</code> 与 <code className="mono">GITHUB_APP_PRIVATE_KEY_PATH</code>。
              {status?.githubAppConfigured
                ? <span style={{ color: "var(--ok)" }}> 当前：已配置 ✓</span>
                : <span style={{ color: "var(--warn)" }}> 当前：未配置</span>}
            </p>
            <div style={{ marginTop: 8 }}>
              <button className="btn" onClick={check}><RefreshIcon size={14} /> 重新检测</button>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setStep(3)}>← 上一步</button>
            <button className="btn btn-primary" onClick={() => setStep(5)}>下一步：初始化 →</button>
          </div>
        </section>
      )}

      {step === 5 && (
        <section className="panel">
          <div className="panel-title"><h2><GearIcon size={14} /> 一键初始化</h2></div>
          {ok ? (
            <p className="state state-ok">系统已就绪，可跳过初始化直接进入完成页。</p>
          ) : (
            <p className="state">
              将根据已保存的模型接入，为 4 个默认角色写入模型策略（issue_analysis / pr_review /
              duplicate_judgment / memory_consolidation）。请先在上一步完成模型接入。
            </p>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setStep(4)}>← 上一步</button>
            {ok ? (
              <button className="btn btn-primary" onClick={() => setStep(6)}>下一步 →</button>
            ) : (
              <button className="btn btn-primary" onClick={runInit} disabled={busy || !status?.database.ok}>
                {busy ? "正在初始化…" : "一键初始化 →"}
              </button>
            )}
          </div>
        </section>
      )}

      {step === 6 && (
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

          {webuiToken ? (
            <div className="panel" style={{ borderStyle: "dashed", marginTop: 12 }}>
              <div className="panel-title">
                <h3>请保存你的访问密钥</h3>
                <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>WEBUI_API_TOKEN</span>
              </div>
              <p className="state state-warn" style={{ marginBottom: 8 }}>
                密钥只在本次安装期间显示一次，之后登录控制台都需要它。请立即复制并妥善保存。
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <code className="jsonbox" style={{ flex: "1 1 260px", margin: 0, wordBreak: "break-all" }}>
                  {webuiToken}
                </code>
                <button className="btn" onClick={() => { void copy(webuiToken); }}>
                  复制密钥
                </button>
              </div>
            </div>
          ) : (
            <p className="state state-warn">
              未检测到 WEBUI_API_TOKEN（未配置访问令牌）。请确认部署环境已设置该变量，否则控制台无法鉴权。
            </p>
          )}

          <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setStep(5)}>← 返回初始化</button>
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
