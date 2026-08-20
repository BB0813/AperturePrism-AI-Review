import { useCallback, useEffect, useState } from "react";
import { bumpCache, fetchProviders, type ProviderOverview } from "../lib/api";
import { RefreshIcon } from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";

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
        setError(err instanceof Error ? err.message : "failed to load providers");
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
          <p className="state state-empty">尚未配置模型策略</p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr><th>角色</th><th>版本</th><th>候选模型</th></tr>
              </thead>
              <tbody>
                {data.policies.map((policy) => (
                  <tr key={policy.role}>
                    <td><span className="chip">{policy.role}</span></td>
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
    </div>
  );
}