import { useEffect, useState } from "react";
import { fetchMe, fetchOAuthStatus, fetchSetupStatus } from "../lib/api";
import { useTheme } from "../hooks/useTheme";
import { MoonIcon, SunIcon } from "../components/icons";

/** Full-screen gate shown when no access token is stored. */
export function Login(props: { onAuthenticated: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oauthOn, setOauthOn] = useState(false);
  // The install wizard is only offered on a fresh (uninitialized) install.
  const [setupOn, setSetupOn] = useState(false);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    fetchOAuthStatus()
      .then((s) => setOauthOn(s.oauthConfigured))
      .catch(() => undefined);
    fetchSetupStatus()
      .then((s) => setSetupOn(!s.initialized))
      .catch(() => setSetupOn(false));
  }, []);

  // 真正的密码验证：先拿令牌调一次受保护接口，通过了才进入控制台。
  const submit = async () => {
    const token = value.trim();
    if (!token) {
      setError("请输入访问令牌");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await fetchMe();
      props.onAuthenticated(token);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : "";
      setError(
        messageText.includes("unauthorized")
          ? "访问令牌无效，请检查后重试。"
          : "无法连接服务器，请稍后重试。",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <button
        className="theme-toggle login-theme-btn"
        onClick={toggle}
        aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
        title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
      >
        {theme === "dark" ? <SunIcon size={14} /> : <MoonIcon size={14} />}
        {theme === "dark" ? "浅色" : "深色"}
      </button>

      <div className="login-card">
        <div className="login-brand">
          <img src="/aprism-logo.png" alt="AperturePrism" className="logo-img" />
          <span>AperturePrism</span>
        </div>

        {oauthOn ? (
          <a className="btn btn-primary btn-block" href="/auth/login">
            使用 GitHub 登录
          </a>
        ) : null}

        <form
          className="login"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>访问控制台</div>
            <p className="login-desc">
              请输入 API 访问令牌。令牌仅保存在本机浏览器，用于保护任务、结果与事件接口。
            </p>
          </div>

          <div className="field">
            <label htmlFor="token">API 访问令牌</label>
            <input
              id="token"
              className="input"
              type="password"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="输入 WEBUI_API_TOKEN"
              autoFocus
              autoComplete="current-password"
            />
          </div>

          {error ? <p className="state state-error">{error}</p> : null}

          <button className="btn btn-block" type="submit" disabled={busy}>
            进入控制台
          </button>
        </form>

        {setupOn ? (
          <a
            className="btn btn-ghost btn-block"
            href="#/setup"
            style={{ justifyContent: "center" }}
          >
            首次使用？进入安装向导
          </a>
        ) : null}
      </div>
    </div>
  );
}