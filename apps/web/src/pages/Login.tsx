import { useEffect, useState, type FormEvent } from "react";
import {
  fetchMe,
  fetchOAuthStatus,
  fetchSetupStatus,
  loginLocal,
  registerLocal,
} from "../lib/api";
import { setToken } from "../lib/auth";
import { useTheme } from "../hooks/useTheme";
import { MoonIcon, SunIcon } from "../components/icons";

/**
 * 登录门禁。支持三种方式（按环境自动呈现）：
 *  1. 用户名 + 密码 —— 本地账号登录（方向一）；无任何本地 admin 时进入「创建管理员」。
 *  2. GitHub OAuth —— 已配置时显示按钮。
 *  3. API 令牌（折叠降级）—— 兼容旧 WEBUI_TOKEN 直连。
 */
export function Login(props: { onAuthenticated: (token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register" | "token">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setTokenInput] = useState("");
  const [needsBootstrap, setNeedsBootstrap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oauthOn, setOauthOn] = useState(false);
  const [setupOn, setSetupOn] = useState(false);
  const { theme, toggle } = useTheme();

  useEffect(() => {
    fetchOAuthStatus()
      .then((s) => setOauthOn(s.oauthConfigured))
      .catch(() => undefined);
    fetchSetupStatus()
      .then((s) => setSetupOn(!s.initialized))
      .catch(() => setSetupOn(false));
    // 探测未登录状态是否需要引导（无本地 admin）。
    fetchMe()
      .then((me) => setNeedsBootstrap(me.needsBootstrap ?? false))
      .catch(() => undefined);
  }, []);

  // 未登录且需要引导 → 直接进「创建管理员」模式。
  useEffect(() => {
    if (needsBootstrap) setMode("register");
  }, [needsBootstrap]);

  const submitPassword = async () => {
    if (!username.trim() || !password) {
      setError(mode === "register" ? "请输入用户名和密码" : "请输入用户名和密码");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token: t } =
        mode === "register"
          ? await registerLocal({ username: username.trim(), password })
          : await loginLocal({ username: username.trim(), password });
      setToken(t);
      props.onAuthenticated(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  const submitToken = async () => {
    const t = token.trim();
    if (!t) {
      setError("请输入访问令牌");
      return;
    }
    setBusy(true);
    setError(null);
    setToken(t);
    try {
      await fetchMe();
      props.onAuthenticated(t);
    } catch {
      setToken("");
      setError("访问令牌无效，请检查后重试。");
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === "token") submitToken();
    else submitPassword();
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

        {oauthOn && mode !== "register" ? (
          <a className="btn btn-primary btn-block" href="/auth/login">
            使用 GitHub 登录
          </a>
        ) : null}

        <form
          className="login"
          onSubmit={submit}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>
              {mode === "register"
                ? "创建管理员账号"
                : mode === "token"
                  ? "使用访问令牌"
                  : "访问控制台"}
            </div>
            <p className="login-desc">
              {mode === "register"
                ? "当前实例尚未配置本地管理员，请设置首个管理员账号与密码。"
                : mode === "token"
                  ? "输入 API 访问令牌（WEBUI_TOKEN）。令牌仅保存在本机浏览器。"
                  : "使用本地账号密码登录。如需旧版令牌登录，见下方「使用令牌」。"}
            </p>
          </div>

          {mode !== "token" ? (
            <>
              <div className="field">
                <label htmlFor="username">用户名</label>
                <input
                  id="username"
                  className="input"
                  type="text"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="管理员用户名"
                  autoFocus
                  autoComplete="username"
                />
              </div>
              <div className="field">
                <label htmlFor="password">密码</label>
                <input
                  id="password"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={mode === "register" ? "至少 8 位" : "输入密码"}
                  autoComplete={
                    mode === "register" ? "new-password" : "current-password"
                  }
                />
              </div>
            </>
          ) : (
            <div className="field">
              <label htmlFor="token">API 访问令牌</label>
              <input
                id="token"
                className="input"
                type="password"
                value={token}
                onChange={(event) => setTokenInput(event.target.value)}
                placeholder="输入 WEBUI_API_TOKEN"
                autoFocus
                autoComplete="current-password"
              />
            </div>
          )}

          {error ? <p className="state state-error">{error}</p> : null}

          <button className="btn btn-block" type="submit" disabled={busy}>
            {mode === "register" ? "创建并登录" : "进入控制台"}
          </button>
        </form>

        {mode === "token" ? (
          <button
            className="btn btn-ghost btn-block"
            style={{ justifyContent: "center" }}
            onClick={() => setMode("login")}
          >
            返回账号密码登录
          </button>
        ) : !needsBootstrap ? (
          <button
            className="btn btn-ghost btn-block"
            style={{ justifyContent: "center" }}
            onClick={() => setMode(mode === "login" ? "token" : "login")}
          >
            {mode === "login" ? "使用令牌登录" : "返回账号密码登录"}
          </button>
        ) : null}

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