import { useState } from "react";
import { useSse } from "./hooks/useSse";
import { navigate, tabOf, useHashRoute } from "./hooks/useHash";
import { eventsUrl, getToken, setToken } from "./lib/auth";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { ProviderPage } from "./pages/ProviderPage";
import { ResultsPage } from "./pages/ResultsPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { TasksPage } from "./pages/TasksPage";

const STATUS_LABEL = {
  connecting: "connecting…",
  online: "live",
  offline: "offline",
} as const;

const TABS = [
  { path: "/", label: "概览" },
  { path: "/issues", label: "Issue" },
  { path: "/tasks", label: "任务" },
  { path: "/pr", label: "PR" },
  { path: "/provider", label: "Provider" },
] as const;

export function App() {
  const [token, setTokenState] = useState<string>(() => getToken());

  if (!token) {
    return (
      <Login
        onAuthenticated={(value) => {
          setToken(value);
          setTokenState(value);
        }}
      />
    );
  }

  return (
    <AuthedConsole
      onLogout={() => {
        setToken("");
        setTokenState("");
        navigate("/");
      }}
    />
  );
}

function AuthedConsole(props: { onLogout: () => void }) {
  const route = useHashRoute();
  const active = tabOf(route);
  const sse = useSse(eventsUrl());

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <span>AperturePrism</span>
        </div>
        <nav className="tabs">
          {TABS.map((tab) => (
            <a
              key={tab.path}
              href={`#${tab.path}`}
              className={active === tab.path ? "tab tab-active" : "tab"}
              onClick={(event) => {
                event.preventDefault();
                navigate(tab.path);
              }}
            >
              {tab.label}
            </a>
          ))}
        </nav>
        <span className={`badge badge-${sse.status}`}>{STATUS_LABEL[sse.status]}</span>
        <button className="logout" onClick={props.onLogout}>
          退出
        </button>
      </header>

      <main>
        {route.startsWith("/tasks/") && route.length > "/tasks/".length ? (
          <TaskDetailPage id={route.slice("/tasks/".length)} />
        ) : active === "/" ? (
          <Overview />
        ) : active === "/tasks" ? (
          <TasksPage />
        ) : active === "/issues" ? (
          <ResultsPage type="issue" label="Issue" />
        ) : active === "/pr" ? (
          <ResultsPage type="pr" label="PR" />
        ) : (
          <ProviderPage />
        )}
      </main>
    </div>
  );
}