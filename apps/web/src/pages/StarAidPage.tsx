import { useCallback, useEffect, useState } from "react";
import {
  addStarAidTarget,
  createStarAidAccount,
  deleteStarAidAccount,
  deleteStarAidTarget,
  fetchMe,
  fetchStarAid,
  runStarAidSweep,
  type StarAidAccount,
  type StarAidTarget,
} from "../lib/api";
import { PlayIcon, RefreshIcon, ShieldIcon } from "../components/icons";
import { LoadingRows, fmtTime } from "../components/ui";

export function StarAidPage() {
  const [accounts, setAccounts] = useState<StarAidAccount[]>([]);
  const [targets, setTargets] = useState<StarAidTarget[]>([]);
  const [summary, setSummary] = useState({
    accounts: 0,
    targets: 0,
    starred: 0,
  });
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);

  const [regLogin, setRegLogin] = useState("");
  const [regToken, setRegToken] = useState("");
  const [targetInputs, setTargetInputs] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchMe().catch(() => null), fetchStarAid()])
      .then(([me, data]) => {
        setIsAdmin(me ? me.isAdmin || me.authMethod === "bearer" : false);
        setAccounts(data.accounts);
        setTargets(data.targets);
        setSummary(data.summary);
      })
      .catch((err: unknown) => {
        const text =
          err instanceof Error ? err.message : "failed to load star-aid";
        setError(
          text.includes("403")
            ? "需要管理员权限（403）。当前账号未授予管理员角色。"
            : text,
        );
        setAccounts([]);
        setTargets([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const register = async () => {
    setBusy("register");
    setMessage(null);
    try {
      const account = await createStarAidAccount(regLogin, regToken);
      setMessage({ text: `已注册 GitHub 账号 @${account.login}。`, ok: true });
      setRegLogin("");
      setRegToken("");
      load();
    } catch (err) {
      setMessage({
        text: `注册失败：${err instanceof Error ? err.message : err}`,
        ok: false,
      });
    } finally {
      setBusy(null);
    }
  };

  const removeAccount = async (account: StarAidAccount) => {
    setBusy(`account:${account.id}`);
    setMessage(null);
    try {
      await deleteStarAidAccount(account.id);
      setMessage({ text: `已删除账号 @${account.login}。`, ok: true });
      load();
    } catch (err) {
      setMessage({
        text: `删除失败：${err instanceof Error ? err.message : err}`,
        ok: false,
      });
    } finally {
      setBusy(null);
    }
  };

  const addTarget = async (account: StarAidAccount) => {
    const fullName = (targetInputs[account.id] ?? "").trim();
    if (!fullName) return;
    setBusy(`target:${account.id}`);
    setMessage(null);
    try {
      await addStarAidTarget(account.id, fullName);
      setMessage({ text: `已添加目标仓库 ${fullName}。`, ok: true });
      setTargetInputs((prev) => ({ ...prev, [account.id]: "" }));
      load();
    } catch (err) {
      setMessage({
        text: `添加失败：${err instanceof Error ? err.message : err}`,
        ok: false,
      });
    } finally {
      setBusy(null);
    }
  };

  const removeTarget = async (target: StarAidTarget) => {
    setBusy(`target-id:${target.id}`);
    setMessage(null);
    try {
      await deleteStarAidTarget(target.id);
      setMessage({ text: `已删除目标 ${target.fullName}。`, ok: true });
      load();
    } catch (err) {
      setMessage({
        text: `删除失败：${err instanceof Error ? err.message : err}`,
        ok: false,
      });
    } finally {
      setBusy(null);
    }
  };

  const runSweep = async () => {
    setBusy("sweep");
    setMessage(null);
    try {
      const result = await runStarAidSweep();
      setMessage({
        text: `点星完成：处理 ${result.processed} 个目标，成功 ${result.starred}，失败 ${result.failed}。`,
        ok: true,
      });
      load();
    } catch (err) {
      setMessage({
        text: `点星失败：${err instanceof Error ? err.message : err}`,
        ok: false,
      });
    } finally {
      setBusy(null);
    }
  };

  const targetsOf = (accountId: string) =>
    targets.filter((target) => target.accountId === accountId);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">仓库互助 · 点星</h1>
          <p className="page-desc">
            注册 GitHub 账户（PAT）并定期为「目标展示仓库」点星，互相引流
          </p>
        </div>
        <div className="actions">
          {isAdmin ? (
            <button
              className="btn btn-primary"
              onClick={runSweep}
              disabled={busy === "sweep" || loading}
            >
              <PlayIcon size={16} />
              {busy === "sweep" ? "点星中…" : "立即点星"}
            </button>
          ) : null}
          <button className="btn" onClick={load} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {message ? (
        <p
          className={`state ${message.ok ? "state-ok" : "state-error"}`}
          style={{ margin: 0 }}
        >
          {message.text}
        </p>
      ) : null}

      {error ? (
        <div className="panel">
          <p className="state state-error">{error}</p>
        </div>
      ) : loading ? (
        <div className="panel">
          <LoadingRows />
        </div>
      ) : !isAdmin ? (
        <div className="panel">
          <p className="state state-error">
            需要管理员权限（403）。当前账号未授予管理员角色。
          </p>
        </div>
      ) : (
        <div className="stack">
          <div className="kpi-grid">
            <Kpi value={summary.accounts} label="账户" tone="info" />
            <Kpi value={summary.targets} label="目标仓库" tone="acc" />
            <Kpi value={summary.starred} label="已点星" tone="ok" />
          </div>

          <section className="panel">
            <div className="panel-title">
              <h2>
                <ShieldIcon size={14} /> 注册账户
              </h2>
            </div>
            <div
              className="grid2"
              style={{ gridTemplateColumns: "1fr 1.6fr auto", maxWidth: 760 }}
            >
              <div className="field">
                <label>GitHub 登录名（可选，以校验结果为准）</label>
                <input
                  className="input"
                  value={regLogin}
                  onChange={(event) => setRegLogin(event.target.value)}
                  placeholder="octocat"
                />
              </div>
              <div className="field">
                <label>Personal Access Token</label>
                <input
                  className="input"
                  type="password"
                  value={regToken}
                  onChange={(event) => setRegToken(event.target.value)}
                  placeholder="ghp_…"
                />
              </div>
              <button
                className="btn btn-primary"
                style={{ alignSelf: "end" }}
                onClick={register}
                disabled={busy === "register" || regToken.trim().length === 0}
              >
                {busy === "register" ? "校验中…" : "注册"}
              </button>
            </div>
            <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
              提交即用该 token 调用 GitHub 校验；通过后 token 以 AES-GCM 加密存储，
              平台定时为下方目标仓库点星（需要已配置 CREDENTIAL_MASTER_KEY）。
            </p>
          </section>

          {accounts.length === 0 ? (
            <section className="panel">
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                暂无账户。先在上方注册一个 GitHub 账户，再添加目标仓库。
              </p>
            </section>
          ) : (
            accounts.map((account) => (
              <section className="result-card" key={account.id}>
                <div className="result-top">
                  <span className="mono" style={{ fontWeight: 600 }}>
                    @{account.login}
                  </span>
                  <span
                    className={`pill ${account.enabled ? "pill-ok" : "pill-dim"}`}
                  >
                    {account.enabled ? "已启用" : "已停用"}
                  </span>
                  <span className="chip">{account.targetCount} 目标</span>
                  <span className="chip">{account.starredCount} 已点星</span>
                  <button
                    className="btn btn-danger"
                    style={{ marginLeft: "auto" }}
                    disabled={busy === `account:${account.id}`}
                    onClick={() => removeAccount(account)}
                  >
                    {busy === `account:${account.id}` ? "删除中…" : "删除账户"}
                  </button>
                </div>

                <div className="result-body">
                  {targetsOf(account.id).length === 0 ? (
                    <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                      暂无目标仓库。
                    </p>
                  ) : (
                    <div className="tablewrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>仓库</th>
                            <th>描述</th>
                            <th>状态</th>
                            <th>最近检查</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {targetsOf(account.id).map((target) => (
                            <tr key={target.id}>
                              <td className="mono" style={{ fontWeight: 600 }}>
                                {target.fullName}
                              </td>
                              <td
                                className="faint"
                                style={{ fontSize: 12, maxWidth: 280 }}
                              >
                                {target.description.length > 80
                                  ? `${target.description.slice(0, 80)}…`
                                  : target.description || "—"}
                              </td>
                              <td>
                                {target.starred ? (
                                  <span className="pill pill-ok">已点星</span>
                                ) : target.lastError ? (
                                  <span
                                    className="pill pill-err"
                                    title={target.lastError}
                                  >
                                    失败
                                  </span>
                                ) : (
                                  <span className="pill pill-info">待点星</span>
                                )}
                              </td>
                              <td className="mono" style={{ fontSize: 12 }}>
                                {target.lastCheckedAt
                                  ? fmtTime(target.lastCheckedAt)
                                  : "—"}
                              </td>
                              <td>
                                <button
                                  className="btn"
                                  style={{ padding: "4px 10px", fontSize: 12 }}
                                  disabled={busy === `target-id:${target.id}`}
                                  onClick={() => removeTarget(target)}
                                >
                                  {busy === `target-id:${target.id}`
                                    ? "删除中…"
                                    : "删除"}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {targetsOf(account.id).some((target) => target.lastError) ? (
                    <div className="faint" style={{ marginTop: 8, fontSize: 12 }}>
                      {targetsOf(account.id)
                        .filter((target) => target.lastError)
                        .map((target) => (
                          <div key={target.id}>
                            • {target.fullName}: {target.lastError}
                          </div>
                        ))}
                    </div>
                  ) : null}
                  <div
                    className="dist-row"
                    style={{
                      gridTemplateColumns: "1fr auto",
                      maxWidth: 560,
                      marginTop: 10,
                    }}
                  >
                    <input
                      className="input"
                      value={targetInputs[account.id] ?? ""}
                      onChange={(event) =>
                        setTargetInputs((prev) => ({
                          ...prev,
                          [account.id]: event.target.value,
                        }))
                      }
                      placeholder="owner/repo"
                    />
                    <button
                      className="btn"
                      disabled={
                        busy === `target:${account.id}` ||
                        (targetInputs[account.id] ?? "").trim().length === 0
                      }
                      onClick={() => addTarget(account)}
                    >
                      {busy === `target:${account.id}` ? "添加中…" : "添加目标"}
                    </button>
                  </div>
                </div>
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Kpi(props: { value: number; label: string; tone: string }) {
  return (
    <div className={`kpi ${props.tone}`}>
      <div className="kpi-value">{props.value}</div>
      <div className="kpi-label">{props.label}</div>
    </div>
  );
}
