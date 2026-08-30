import { useCallback, useEffect, useState } from "react";
import {
  bumpCache,
  fetchModels,
  fetchProviders,
  saveProvider,
  type ProviderOverview,
} from "../lib/api";
import { GearIcon, RefreshIcon } from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";
import { explainUnknown } from "../lib/errors";
import { modelRoleLabel } from "../lib/labels";
import { SettingsSection } from "../components/SettingsSection";
import { useToast } from "../components/Toast";

/**
 * 新增模型的表单。此前模型配置只能在安装向导里做一次，装完之后本页是纯只读，
 * 用户「点进模型路由却找不到配置的地方」（issue #2）。后端 /setup/provider
 * 只要求管理员、不要求未初始化，因此这里直接复用它。
 */
function AddProviderForm({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [accountName, setAccountName] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setProvider("");
    setBaseUrl("");
    setApiKey("");
    setModel("");
    setAccountName("");
    setModels([]);
  };

  // 拉取模型列表既是便利，也是对 baseUrl/apiKey 的一次连通性验证。
  const probeModels = async () => {
    if (!baseUrl.trim() || !apiKey.trim()) {
      toast.error("请先填写 Base URL 与 API Key");
      return;
    }
    setProbing(true);
    try {
      const list = await fetchModels(baseUrl.trim(), apiKey.trim());
      setModels(list);
      if (list.length === 0) toast.info("连接成功，但该地址未返回可用模型");
      else {
        toast.success(`已获取 ${list.length} 个模型`);
        if (!model) setModel(list[0] ?? "");
      }
    } catch (err) {
      toast.error(`获取模型列表失败：${explainUnknown(err)}`);
    } finally {
      setProbing(false);
    }
  };

  const submit = async () => {
    const payload = {
      provider: provider.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
      ...(accountName.trim() ? { accountName: accountName.trim() } : {}),
    };
    if (!payload.provider || !payload.baseUrl || !payload.apiKey || !payload.model) {
      toast.error("Provider、Base URL、API Key 与模型均为必填");
      return;
    }
    setSaving(true);
    try {
      const result = await saveProvider(payload);
      toast.success(
        `已保存 ${result.provider}/${result.model}，已接入 ${result.policiesUpdated} 个角色策略`,
      );
      reset();
      setOpen(false);
      bumpCache();
      onSaved();
    } catch (err) {
      toast.error(`保存失败：${explainUnknown(err)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button className="btn btn-primary" onClick={() => setOpen(true)}>
        <GearIcon size={16} />
        添加模型
      </button>
    );
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>添加模型</h2>
        <span className="count">保存后自动接入全部分析角色</span>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        <div className="filters">
          <input
            className="input"
            placeholder="Provider 标识，如 newapi"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: "1 1 260px" }}
            placeholder="Base URL，如 https://api.example.com/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="filters">
          <input
            className="input"
            style={{ flex: "1 1 260px" }}
            type="password"
            placeholder="API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            data-lpignore="true"
          />
          <button className="btn" onClick={probeModels} disabled={probing}>
            {probing ? "获取中…" : "获取模型列表"}
          </button>
        </div>
        <div className="filters">
          {models.length > 0 ? (
            <select
              className="input"
              style={{ flex: "1 1 260px" }}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              style={{ flex: "1 1 260px" }}
              placeholder="模型名，如 gpt-4o-mini（也可先获取列表）"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          )}
          <input
            className="input"
            placeholder="账户名（可留空，默认 <provider>-main）"
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
          />
        </div>
        <div className="filters">
          <button className="btn btn-primary" onClick={submit} disabled={saving}>
            {saving ? "保存中…" : "保存并接入"}
          </button>
          <button
            className="btn"
            onClick={() => {
              reset();
              setOpen(false);
            }}
            disabled={saving}
          >
            取消
          </button>
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          API Key 以 AES-GCM 加密存储，仅 Worker 在进程内解密。同一 Provider
          与账户名重复保存会覆盖旧密钥。新模型会被放在各角色候选的首位，原有
          候选保留为故障转移备选。
        </p>
      </div>
    </section>
  );
}

export function ProviderPage() {
  const [data, setData] = useState<ProviderOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchProviders()
      .then(setData)
      .catch((err: unknown) => {
        setError(explainUnknown(err));
        setData(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">模型路由</h1>
          <p className="page-desc">各分析角色的模型候选策略与已配置账户</p>
        </div>
        <div className="actions">
          <AddProviderForm onSaved={load} />
          <button className="btn" onClick={() => { bumpCache(); load(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>模型策略</h2>
          <span className="count">{data?.policies.length ?? "–"} roles</span>
        </div>

        {error ? (
          <ErrorPanel error={error} onRetry={load} />
        ) : loading ? (
          <LoadingRows />
        ) : !data ? (
          <p className="state state-empty">暂无数据</p>
        ) : data.policies.length === 0 ? (
          <p className="state state-empty">
            尚未配置模型策略。点击右上角「添加模型」填写 Provider 与 API Key 即可接入。
          </p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr><th>角色</th><th>版本</th><th>候选模型</th></tr>
              </thead>
              <tbody>
                {data.policies.map((policy) => (
                  <tr key={policy.role}>
                    <td><span className="chip">{modelRoleLabel(policy.role)}</span></td>
                    <td><span className="chip mono">{policy.version}</span></td>
                    <td>
                      <span className="tag-row">
                        {policy.candidates.map((c, i) => (
                          <span key={i} className="tag">
                            {c.provider}/{c.model} @ {c.accountName}
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h2>Provider 账户</h2>
          <span className="count">{data?.accounts.length ?? "–"}</span>
        </div>
        {data && data.accounts.length > 0 ? (
          <div className="tag-row">
            {data.accounts.map((name) => (
              <span key={name} className="tag">
                {name}
              </span>
            ))}
          </div>
        ) : (
          <p className="state state-empty">无账户</p>
        )}
        <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
          凭据以 AES-GCM 加密存储，仅 Worker 在进程内解密，绝不出现在此界面。
        </p>
      </section>

      <SettingsSection
        keys={["embedding_base_url", "embedding_api_key", "embedding_model"]}
        title="Embedding（向量索引）"
        desc="重复检测与相似 issue 召回所用的嵌入服务；留空则用环境变量"
      />
    </div>
  );
}
