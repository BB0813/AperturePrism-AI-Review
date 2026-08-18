import { useCallback, useEffect, useState } from "react";
import { fetchProviders, type ProviderOverview } from "../lib/api";

/** Provider tab: model role policies + configured accounts (never keys). */
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

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="card">
      <div className="card-head">
        <h2>模型策略</h2>
        <button onClick={load} disabled={loading}>
          刷新
        </button>
      </div>

      {error ? (
        <p className="state-error">加载失败：{error}</p>
      ) : loading || !data ? (
        <p className="state-loading">正在加载…</p>
      ) : data.policies.length === 0 ? (
        <p className="state-empty">尚未配置模型策略</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>角色</th>
              <th>版本</th>
              <th>Candidates</th>
            </tr>
          </thead>
          <tbody>
            {data.policies.map((policy) => (
              <tr key={policy.role}>
                <td>{policy.role}</td>
                <td className="mono muted">{policy.version}</td>
                <td className="mono">
                  {policy.candidates
                    .map(
                      (candidate) =>
                        `${candidate.provider}/${candidate.model} @ ${candidate.accountName}`,
                    )
                    .join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>Provider 账户</h3>
      {data && data.accounts.length > 0 ? (
        <ul className="deps">
          {data.accounts.map((name) => (
            <li key={name} className="mono">
              {name}
            </li>
          ))}
        </ul>
      ) : (
        <p className="state-empty">无账户</p>
      )}
    </section>
  );
}