import { useSse } from "./hooks/useSse";
import { navigate, tabOf, useHashRoute } from "./hooks/useHash";
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
  const route = useHashRoute();
  const active = tabOf(route);
  const sse = useSse("/events");

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