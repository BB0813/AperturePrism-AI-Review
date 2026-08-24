import { useCallback, useEffect, useRef, useState } from "react";
import {
  bumpCache,
  clearSetting,
  fetchBackup,
  fetchConfig,
  fetchSettings,
  fetchSettingsBootstrap,
  importBackup,
  saveGithubApp,
  saveSetting,
  type BootstrapStatus,
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

/**
 * 分组的中文标题与说明。字段级文案（label / hint / 可选值）由后端注册表提供，
 * 前端不再维护第二份 —— 此前 ConfigPage 的 FIELD_META 与 ReposPage 的
 * REPO_SETTING_META 各写一遍，改一处忘一处就会对不上。
 */
const GROUP_META: Record<string, { title: string; desc: string }> = {
  github: {
    title: "GitHub 接入",
    desc: "仓库访问与事件入口。App 用于读写仓库，与登录用的 OAuth 无关",
  },
  auth: {
    title: "WebUI 访问",
    desc: "访问令牌与 GitHub 登录；OAuth 仅用于登录本界面",
  },
  issue: { title: "Issue 分析", desc: "分析行为与自动化；多数项可按仓库单独覆盖" },
  pr: { title: "PR 审查", desc: "审查结果如何回写到 Pull Request" },
  embedding: { title: "Embedding", desc: "重复检测与向量索引所用的嵌入服务" },
  qq: {
    title: "QQ 机器人",
    desc: "建议在「机器人」页维护；这些项仅在进程启动时读取，改完需重启 qq-bot 容器",
  },
  ops: { title: "运维", desc: "日志、扫描与 Agent 能力总开关" },
};

/** 分组展示顺序：先接入、再行为、最后运维与机器人。 */
const GROUP_ORDER = ["github", "auth", "issue", "pr", "embedding", "ops", "qq"];

/**
 * 生效来源徽章 —— 本次改造的核心。
 *
 * 此前界面只有「已覆盖 / 使用环境变量」两态，后者其实混了「env 里确实有值」与
 * 「两边都没配、在用应用默认」两种完全不同的状态，用户因此看不出自己改的到底
 * 生效没有。
 */
function SourceBadge({ item }: { item: SettingItem }) {
  if (item.source === "database")
    return <span className="pill pill-info">已覆盖 · 数据库</span>;
  if (item.source === "env")
    return (
      <span className="pill pill-ok" title={item.envVar ?? undefined}>
        来自环境变量{item.envVar ? ` · ${item.envVar}` : ""}
      </span>
    );
  return (
    <span className="pill pill-dim" title={`应用默认：${item.defaultValue || "空"}`}>
      应用默认{item.defaultValue ? ` · ${item.defaultValue}` : ""}
    </span>
  );
}

function SettingRow({
  item,
  draft,
  setDraft,
  save,
  clear,
  busyKey,
}: {
  item: SettingItem;
  draft: string;
  setDraft: (value: string) => void;
  save: (key: string, value: string) => void;
  clear: (key: string) => void;
  busyKey: string | null;
}) {
  const busy = busyKey === item.key;
  // 只有数据库覆盖才谈得上「回落」；env / 默认状态下没有可删除的东西。
  const canRevert = item.source === "database";
  const on = item.value === "true";

  return (
    <div className="result-card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{item.label}</span>
        <SourceBadge item={item} />
        {item.repoScoped ? (
          <span className="pill pill-dim" title="可在「已安装仓库」页为单个仓库覆盖">
            可按仓库覆盖
          </span>
        ) : null}
        {item.hotReload === "restart" ? (
          <span className="pill pill-warn">需重启容器</span>
        ) : null}
      </div>

      {item.kind === "boolean" ? (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={item.label}
            className="switch"
            data-on={on ? "true" : "false"}
            disabled={busy}
            onClick={() => save(item.key, on ? "false" : "true")}
          >
            <span className="switch-knob" />
          </button>
          <span className="faint" style={{ fontSize: 12 }}>
            {busy ? "保存中…" : on ? "已开启" : "已关闭"}
          </span>
          {canRevert ? (
            <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => clear(item.key)}>
              {item.envConfigured ? "回落环境变量" : "回落默认"}
            </button>
          ) : null}
        </div>
      ) : item.kind === "enum" ? (
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <select
            className="input"
            style={{ flex: "0 1 200px" }}
            value={item.value}
            disabled={busy}
            onChange={(event) => save(item.key, event.target.value)}
          >
            {(item.options ?? []).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          {busy ? <span className="faint" style={{ fontSize: 12 }}>保存中…</span> : null}
          {canRevert ? (
            <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => clear(item.key)}>
              {item.envConfigured ? "回落环境变量" : "回落默认"}
            </button>
          ) : null}
        </div>
      ) : (
        <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 260px" }}
            type={item.secret ? "password" : "text"}
            placeholder={
              item.secret
                ? item.hasValue
                  ? "已配置（不回显），输入新值可替换"
                  : "输入新值"
                : item.value
                  ? `当前：${item.value}`
                  : "输入新值"
            }
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            data-lpignore="true"
          />
          <button
            className="btn btn-primary"
            onClick={() => save(item.key, draft.trim())}
            disabled={busy || draft.trim().length === 0}
          >
            {busy ? "保存中…" : "保存"}
          </button>
          {canRevert ? (
            <button className="btn" style={{ fontSize: 12 }} disabled={busy} onClick={() => clear(item.key)}>
              {item.envConfigured ? "回落环境变量" : "回落默认"}
            </button>
          ) : null}
        </div>
      )}

      <p className="faint" style={{ margin: "8px 0 0", fontSize: 12 }}>{item.hint}</p>
    </div>
  );
}

/**
 * 引导层健康度：只能来自环境变量的那几项。主密钥缺失时 Provider 凭据与
 * GitHub App 私钥都保存不了，而这件事此前只在保存失败时才暴露出来。
 */
function BootstrapPanel({ status }: { status: BootstrapStatus | null }) {
  if (!status) return null;
  return (
    <section className="panel">
      <div className="panel-title">
        <h2>引导配置</h2>
        <span className="count">只能由环境变量提供，无法保存到数据库</span>
      </div>
      <div className="stack" style={{ gap: 0 }}>
        {status.items.map((item) => (
          <div key={item.key} style={{ padding: "10px 0", borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 12 }}>{item.key}</span>
              <BoolBadge ok={item.configured} yes="已配置" no="未配置" />
              <span style={{ fontSize: 12, fontWeight: 600 }}>{item.label}</span>
            </div>
            <p className="faint" style={{ margin: "4px 0 0", fontSize: 11 }}>{item.hint}</p>
          </div>
        ))}
      </div>
      <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
        这几项要么在读取数据库之前就必须知道（连接串、监听地址），要么是解开库内所有
        密文的钥匙（凭据主密钥）—— 把主密钥放进数据库等于明文存钥匙，加密就失去意义。
        其余配置项均以数据库为准，可在上方直接修改。
      </p>
    </section>
  );
}

/**
 * GitHub App 配置表单。此前 App ID 与私钥只能通过环境变量 + 私钥文件提供，
 * WebUI 上没有任何输入项：用户看到 github_not_configured 却无处可填，还容易
 * 误以为改「GitHub OAuth」就能修好（那两项只用于 WebUI 登录）。
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
      toast.success(
        `已保存并验证通过：${result.appSlug || result.appId}，无需重启即可生效`,
      );
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
          GitHub App 用于访问仓库、同步与分析，与「GitHub OAuth」不同 ——
          后者只用于登录 WebUI，配置它无法修复同步仓库失败。私钥以 AES-GCM
          加密存储，仅在进程内解密，界面不会回显。
        </p>
      </div>
    </section>
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
  const [bootstrap, setBootstrap] = useState<BootstrapStatus | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchConfig(), fetchSettings(), fetchSettingsBootstrap()])
      .then(([c, s, b]) => {
        setCfg(c);
        setItems(s.items);
        setBootstrap(b);
        setDrafts({});
      })
      .catch((err: unknown) => {
        setError(explainUnknown(err));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  /** 保存后重新拉取：source 与生效值都可能变，界面必须如实反映。 */
  const refreshItems = async (key: string) => {
    const fresh = await fetchSettings();
    setItems(fresh.items);
    setDrafts((prev) => ({ ...prev, [key]: "" }));
  };

  const labelOf = (key: string) =>
    items.find((item) => item.key === key)?.label ?? key;

  const save = async (key: string, value: string) => {
    setBusyKey(key);
    try {
      await saveSetting(key, value);
      toast.success(`已保存：${labelOf(key)}`);
      await refreshItems(key);
    } catch (err) {
      toast.error(`保存失败：${explainUnknown(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  const clear = async (key: string) => {
    setBusyKey(key);
    try {
      const envConfigured = items.find((item) => item.key === key)?.envConfigured;
      await clearSetting(key);
      toast.success(
        `已清除覆盖：${labelOf(key)}，${envConfigured ? "回落到环境变量" : "回落到应用默认"}`,
      );
      await refreshItems(key);
    } catch (err) {
      toast.error(`清除失败：${explainUnknown(err)}`);
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

  // 按注册表分组归拢；未知分组落到「运维」，不会因为后端新增分组而丢项。
  const grouped = new Map<string, SettingItem[]>();
  for (const item of items) {
    const group = GROUP_META[item.group] ? item.group : "ops";
    const list = grouped.get(group);
    if (list) list.push(item);
    else grouped.set(group, [item]);
  }
  const groups = [
    ...GROUP_ORDER.filter((group) => grouped.has(group)),
    ...[...grouped.keys()].filter((group) => !GROUP_ORDER.includes(group)),
  ];
  const overriddenCount = items.filter((item) => item.source === "database").length;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">系统设置</h1>
          <p className="page-desc">
            以数据库为准的运行时配置；每项都标注当前值来自数据库、环境变量还是应用默认
          </p>
        </div>
        <div className="actions">
          <GithubAppForm
            configured={cfg?.githubAppConfigured ?? false}
            onSaved={load}
          />
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

          {bootstrap && !bootstrap.healthy ? (
            <section className="panel err-panel">
              <div className="panel-title"><h2>引导配置不完整</h2></div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
                凭据主密钥（<span className="mono">CREDENTIAL_MASTER_KEY</span>）未配置：
                模型 Provider 凭据与 GitHub App 私钥都无法保存。请在部署的环境变量里提供
                一个 32 字节的 base64 密钥并重启，再回到本页配置。
              </p>
            </section>
          ) : null}

          {groups.map((group) => {
            const meta = GROUP_META[group] ?? { title: group, desc: "" };
            const list = grouped.get(group) ?? [];
            return (
              <section className="panel" key={group}>
                <div className="panel-title">
                  <h2><GearIcon size={14} /> {meta.title}</h2>
                  <span className="count">{list.length} 项</span>
                </div>
                {meta.desc ? (
                  <p className="faint" style={{ margin: "0 0 12px", fontSize: 12 }}>{meta.desc}</p>
                ) : null}
                <div className="stack">
                  {list.map((item) => (
                    <SettingRow
                      key={item.key}
                      item={item}
                      draft={drafts[item.key] ?? ""}
                      setDraft={(value) =>
                        setDrafts((prev) => ({ ...prev, [item.key]: value }))
                      }
                      save={save}
                      clear={clear}
                      busyKey={busyKey}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          <BootstrapPanel status={bootstrap} />

          <div className="grid2">
            <section className="panel">
              <div className="panel-title"><h2>服务</h2></div>
              {cfg && (
                <dl className="kv">
                  <dt>监听地址</dt><dd className="mono">{cfg.host}:{cfg.port}</dd>
                  <dt>日志级别</dt><dd><span className="chip">{cfg.logLevel}</span></dd>
                  <dt>WebUI 认证</dt><dd><BoolBadge ok={cfg.webuiAuthEnabled} /></dd>
                  <dt>数据库覆盖</dt><dd><span className="chip">{overriddenCount} 项</span></dd>
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
                  <dt>GitHub App<br /><span className="faint" style={{ fontSize: 11 }}>仓库访问 / 分析</span></dt>
                  <dd><BoolBadge ok={cfg.githubAppConfigured} /></dd>
                  <dt>GitHub OAuth<br /><span className="faint" style={{ fontSize: 11 }}>仅用于 WebUI 登录</span></dt>
                  <dd><BoolBadge ok={cfg.oauthConfigured} /></dd>
                  <dt>Embedding</dt><dd><BoolBadge ok={cfg.embeddingConfigured} /></dd>
                  <dt>Embedding 模型</dt><dd className="mono">{cfg.embeddingModel}</dd>
                </dl>
              )}
            </section>
          </div>

          <section className="panel">
            <div className="panel-title"><h2>Bot 接入状态</h2><span className="count">在「机器人」页配置</span></div>
            {cfg && (
              <div className="dist" style={{ marginTop: 6 }}>
                <StatusItem label="官方 QQ 机器人">
                  <BoolBadge ok={cfg.qqOfficialConfigured} yes="已配置" no="未配置" />
                </StatusItem>
                <StatusItem label="NTQQ 第三方协议">
                  {cfg.qqBotProtocols.length > 0 ? (
                    <span className="tag-row">
                      {cfg.qqBotProtocols.map((p) => <span key={p} className="tag">{p}</span>)}
                    </span>
                  ) : (
                    <span className="faint" style={{ fontSize: 12 }}>未配置</span>
                  )}
                </StatusItem>
                <StatusItem label="GitHub OAuth 登录">
                  <BoolBadge ok={cfg.oauthConfigured} yes="可用" no="未配置" />
                  <span className="faint" style={{ fontSize: 12 }}>
                    {cfg.oauthConfigured
                      ? cfg.oauthEnabled ? "登录页显示 GitHub 按钮" : "登录页显示 GitHub + 令牌双入口"
                      : "需配置 OAuth Client ID / Secret"}
                  </span>
                </StatusItem>
              </div>
            )}
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
              导出包含热更新设置、模型角色策略与 Provider 名称；密钥与未登记的键只导出「是否已配置」，不含值（默认拒绝，新增键不会误泄）；导入仅恢复非密钥设置与
              issue_analysis / pr_review / duplicate_judgment 策略。Provider 凭据始终保存在数据库，不从备份还原。
            </p>
          </section>

          <p className="faint" style={{ fontSize: 12 }}>
            标签规则在「标签配置」维护；模型 Provider 在「模型路由」维护；仓库级覆盖在「已安装仓库」页每个仓库的「分析设置」里。
          </p>
        </div>
      )}
    </div>
  );
}
