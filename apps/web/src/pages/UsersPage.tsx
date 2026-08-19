import { useCallback, useEffect, useState } from "react";
import { fetchMe, fetchUsers, setUserAdmin, type UserRow } from "../lib/api";
import { RefreshIcon, ShieldIcon } from "../components/icons";
import { LoadingRows } from "../components/ui";

export function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchMe(), fetchUsers()])
      .then(([me, rows]) => {
        setIsAdmin(me.isAdmin || me.authMethod === "bearer");
        setUsers(rows);
      })
      .catch((err: unknown) => {
        const messageText = err instanceof Error ? err.message : "failed to load users";
        setError(
          messageText.includes("403")
            ? "需要管理员权限（403）。当前账号未授予管理员角色。"
            : messageText,
        );
        setUsers([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const toggle = async (login: string, next: boolean) => {
    setBusy(login);
    setMessage(null);
    try {
      await setUserAdmin(login, next);
      setMessage({ text: `已${next ? "授予" : "移除"} ${login} 的管理员权限。`, ok: true });
      load();
    } catch (err) {
      setMessage({ text: `操作失败：${err instanceof Error ? err.message : err}`, ok: false });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">用户管理</h1>
          <p className="page-desc">GitHub OAuth 登录用户与管理员角色</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={load} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <div className="panel"><p className="state state-error">{error}</p></div>
      ) : loading ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          {message ? (
            <p className={`state ${message.ok ? "state-ok" : "state-error"}`} style={{ margin: 0 }}>
              {message.text}
            </p>
          ) : null}

          <section className="panel">
            <div className="panel-title"><h2><ShieldIcon size={14} /> 用户列表</h2><span className="count">{users.length}</span></div>
            {users.length === 0 ? (
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                暂无用户。首次通过 GitHub OAuth 登录的用户会自动成为管理员。
              </p>
            ) : (
              <div className="dist" style={{ marginTop: 6 }}>
                {users.map((user) => (
                  <div key={user.login} className="dist-row" style={{ flexWrap: "wrap", gap: 10 }}>
                    <span className="mono" style={{ fontWeight: 600 }}>{user.login}</span>
                    {user.displayName ? (
                      <span className="faint" style={{ fontSize: 12 }}>{user.displayName}</span>
                    ) : null}
                    <span className={`pill ${user.isAdmin ? "pill-ok" : "pill-dim"}`}>
                      {user.isAdmin ? "管理员" : "普通用户"}
                    </span>
                    <button
                      className="btn"
                      style={{ marginLeft: "auto" }}
                      disabled={busy === user.login}
                      onClick={() => toggle(user.login, !user.isAdmin)}
                    >
                      {busy === user.login
                        ? "保存中…"
                        : user.isAdmin
                          ? "移除管理员"
                          : "设为管理员"}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
              {isAdmin
                ? "管理员可管理用户、导入配置备份并执行初始化；其他敏感操作（设置、标签规则、索引重建）对所有已认证用户开放。"
                : "当前账号无管理员权限，只能查看。首个 OAuth 登录用户自动成为管理员。"}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
