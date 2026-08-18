import { useState } from "react";

/** Full-screen gate shown when no access token is stored. */
export function Login(props: { onAuthenticated: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const token = value.trim();
    if (!token) {
      setError("请输入访问令牌");
      return;
    }
    props.onAuthenticated(token);
  };

  return (
    <div className="shell login-wrap">
      <div className="brand">
        <span className="brand-mark">A</span>
        <span>AperturePrism</span>
      </div>
      <form
        className="card login"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2>访问控制台</h2>
        <p className="muted">该控制台受保护，请输入 API 访问令牌以继续。</p>
        <input
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="API token"
          autoFocus
          autoComplete="current-password"
        />
        {error ? <p className="state-error">{error}</p> : null}
        <button type="submit">进入</button>
      </form>
    </div>
  );
}