import { useEffect, useState, type ReactElement } from "react";
import { useSse } from "./hooks/useSse";
import { navigate, tabOf, useHashRoute } from "./hooks/useHash";
import { eventsUrl, getToken, setToken } from "./lib/auth";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { LogOverviewPage } from "./pages/LogOverviewPage";
import { ProviderPage } from "./pages/ProviderPage";
import { ResultsPage } from "./pages/ResultsPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { TasksPage } from "./pages/TasksPage";
import { ReposPage } from "./pages/ReposPage";
import { VectorPage } from "./pages/VectorPage";
import { ConfigPage } from "./pages/ConfigPage";
import { AboutPage } from "./pages/AboutPage";
import { SetupPage } from "./pages/SetupPage";
import {
  ActivityIcon,
  BugIcon,
  CpuIcon,
  DatabaseIcon,
  FolderIcon,
  GearIcon,
  GridIcon,
  InfoIcon,
  ListIcon,
  LogoutIcon,
  PullRequestIcon,
  SparkleIcon,
} from "./components/icons";

const STATUS_TEXT: Record<string, string> = {
  connecting: "连接中",
  online: "实时连接",
  offline: "已断开",
};

type NavItem = { path: string; label: string; icon: (p: { size?: number }) => ReactElement };
type NavGroup = { title?: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    items: [
      { path: "/", label: "仪表盘", icon: GridIcon },
      { path: "/logs", label: "日志总览", icon: ActivityIcon },
    ],
  },
  {
    title: "分析",
    items: [
      { path: "/issues", label: "Issue 分析", icon: BugIcon },
      { path: "/pr", label: "PR 审查", icon: PullRequestIcon },
      { path: "/tasks", label: "审查队列", icon: ListIcon },
    ],
  },
  {
    title: "数据与运维",
    items: [
      { path: "/repos", label: "已安装仓库", icon: FolderIcon },
      { path: "/vector", label: "向量存储", icon: DatabaseIcon },
      { path: "/provider", label: "模型路由", icon: CpuIcon },
    ],
  },
  {
    title: "系统",
    items: [
      { path: "/config", label: "系统配置", icon: GearIcon },
      { path: "/about", label: "关于", icon: InfoIcon },
    ],
  },
];

export function App() {
  const [token, setTokenState] = useState<string>(() => getToken());
  const route = useHashRoute();
  const showSetup = route === "/setup";

  // Consume the OAuth callback result carried in the hash (#/?token=… | oauth_error).
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash === "/setup") return;
    const queryIdx = hash.indexOf("?");
    if (queryIdx === -1) return;
    const params = new URLSearchParams(hash.slice(queryIdx + 1));
    const oauthToken = params.get("token");
    if (oauthToken) {
      setToken(oauthToken);
      setTokenState(oauthToken);
      window.history.replaceState(null, "", "#/");
    } else if (params.get("oauth_error")) {
      window.alert("GitHub 登录失败：" + params.get("oauth_error"));
      window.history.replaceState(null, "", "#/");
    }
  }, []);

  if (showSetup) return <SetupPage />;

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

  let page;
  if (route.startsWith("/tasks/") && route.length > "/tasks/".length) {
    page = <TaskDetailPage id={route.slice("/tasks/".length)} />;
  } else if (active === "/" || active === "") page = <Overview sse={sse} />;
  else if (active === "/logs") page = <LogOverviewPage />;
  else if (active === "/tasks") page = <TasksPage />;
  else if (active === "/issues") page = <ResultsPage type="issue" label="Issue 分析" />;
  else if (active === "/pr") page = <ResultsPage type="pr" label="PR 审查" />;
  else if (active === "/repos") page = <ReposPage />;
  else if (active === "/vector") page = <VectorPage />;
  else if (active === "/provider") page = <ProviderPage />;
  else if (active === "/config") page = <ConfigPage />;
  else page = <AboutPage />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <div className="brand">
            <span className="brand-mark">
              <SparkleIcon size={18} />
            </span>
            <span>AperturePrism</span>
          </div>
          <div className="brand-sub">AI Code Review</div>
        </div>

        <nav className="nav">
          {NAV.map((group, gi) => (
            <div key={gi} className="nav-group">
              {group.title ? <div className="nav-title">{group.title}</div> : null}
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive =
                  active === item.path || (item.path !== "/" && route.startsWith(item.path));
                return (
                  <a
                    key={item.path}
                    href={`#${item.path}`}
                    className={isActive ? "nav-item nav-item-active" : "nav-item"}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(item.path);
                    }}
                  >
                    <Icon size={16} />
                    {item.label}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="side-foot">
          <span className={`status-badge status-${sse.status}`}>
            <span className="dot-pulse" />
            {STATUS_TEXT[sse.status]}
          </span>
          <button className="btn btn-ghost" onClick={props.onLogout}>
            <LogoutIcon size={16} />
            退出登录
          </button>
        </div>
      </aside>

      <main className="main">{page}</main>
    </div>
  );
}