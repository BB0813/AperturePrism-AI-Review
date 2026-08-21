import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useSse } from "./hooks/useSse";
import { navigate, tabOf, useHashRoute } from "./hooks/useHash";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./components/Toast";
import { eventsUrl, getToken, setToken } from "./lib/auth";
import { fetchSetupStatus } from "./lib/api";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { LogOverviewPage } from "./pages/LogOverviewPage";
import { ProviderPage } from "./pages/ProviderPage";
import { ResultsPage } from "./pages/ResultsPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { TasksPage } from "./pages/TasksPage";
import { ReposPage } from "./pages/ReposPage";
import { VectorPage } from "./pages/VectorPage";
import { LabelsPage } from "./pages/LabelsPage";
import { ConfigPage } from "./pages/ConfigPage";
import { AccountPage } from "./pages/AccountPage";
import { UsersPage } from "./pages/UsersPage";
import { SecurityPage } from "./pages/SecurityPage";
import { MemoryPage } from "./pages/MemoryPage";
import { AgentPage } from "./pages/AgentPage";
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
  LayersIcon,
  ListIcon,
  LogoutIcon,
  MenuIcon,
  MoonIcon,
  PullRequestIcon,
  ShieldIcon,
  SparkleIcon,
  SunIcon,
  TagIcon,
  UserCircleIcon,
  UserIcon,
} from "./components/icons";

const STATUS_TEXT: Record<string, string> = {
  connecting: "连接中",
  online: "实时连接",
  offline: "已断开",
};

type NavItem = { path: string; label: string; icon: (p: { size?: number }) => ReactElement };
export type NavGroup = { title?: string; items: NavItem[] };

export const NAV: NavGroup[] = [
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
      { path: "/memory", label: "记忆管理", icon: SparkleIcon },
      { path: "/labels", label: "标签配置", icon: TagIcon },
      { path: "/provider", label: "模型路由", icon: CpuIcon },
      { path: "/agent", label: "Agent 能力", icon: LayersIcon },
    ],
  },
  {
    title: "系统",
    items: [
      { path: "/config", label: "系统配置", icon: GearIcon },
      { path: "/security", label: "安全管理", icon: ShieldIcon },
      { path: "/users", label: "用户管理", icon: UserIcon },
      { path: "/about", label: "关于", icon: InfoIcon },
    ],
  },
];

export function App() {
  const [token, setTokenState] = useState<string>(() => getToken());
  const route = useHashRoute();
  const toast = useToast();
  const showSetup = route === "/setup";
  // Install state: `null` = still probing; `false` = not initialized (wizard
  // is public); `true` = already installed (wizard requires auth / is hidden).
  const [setupInstalled, setSetupInstalled] = useState<boolean | null>(null);

  // On the setup route, decide whether the wizard may be shown without auth.
  // A fresh install keeps it public; once initialized it must be gated behind
  // the WebUI token so the wizard is hidden by default.
  useEffect(() => {
    if (!showSetup) return;
    fetchSetupStatus()
      .then((s) => setSetupInstalled(s.initialized))
      .catch(() => setSetupInstalled(true)); // unknown → treat as installed
  }, [showSetup]);

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
      toast.error(`GitHub 登录失败：${params.get("oauth_error")}`);
      window.history.replaceState(null, "", "#/");
    }
  }, [toast]);

  const loginGate = (
    <Login
      onAuthenticated={(value) => {
        setToken(value);
        setTokenState(value);
      }}
    />
  );

  if (showSetup) {
    if (setupInstalled === null) return null; // probing install state
    // Already installed → the wizard is hidden by default and gated behind
    // the WebUI token; unauthenticated visitors land on the login screen.
    if (setupInstalled && !token) return loginGate;
    return <SetupPage />;
  }

  if (!token) return loginGate;

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
  const { theme, toggle } = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Route change always collapses the mobile drawer.
  useEffect(() => setDrawerOpen(false), [route]);

  const closeDrawer = () => setDrawerOpen(false);

  const pageTitle = useMemo(() => {
    if (route.startsWith("/tasks/") && route.length > "/tasks/".length) {
      return { eyebrow: "审查队列", title: `任务 #${route.slice("/tasks/".length).slice(0, 8)}` };
    }
    const match = NAV.flatMap((g) => g.items).find((i) => i.path === active);
    if (match) return { eyebrow: routeGroupTitle(active) ?? "工作台", title: match.label };
    return { eyebrow: "工作台", title: "关于" };
  }, [route, active]);

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
  else if (active === "/memory") page = <MemoryPage />;
  else if (active === "/labels") page = <LabelsPage />;
  else if (active === "/agent") page = <AgentPage />;
  else if (active === "/provider") page = <ProviderPage />;
  else if (active === "/config") page = <ConfigPage />;
  else if (active === "/security") page = <SecurityPage />;
  else if (active === "/account") page = <AccountPage />;
  else if (active === "/users") page = <UsersPage />;
  else page = <AboutPage />;

  return (
    <div className="shell">
      <aside className={drawerOpen ? "sidebar drawer-open" : "sidebar"}>
        <div>
          <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
            <img src="/aprism-logo.png" alt="AperturePrism" className="brand-logo" />
            <span>AperturePrism</span>
          </a>
          <div className="brand-sub">AI Code Review</div>
        </div>

        <nav className="nav">
          {NAV.map((group, gi) => (
            <div key={gi} className="nav-group">
              {group.title ? <div className="nav-title">{group.title}</div> : null}
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = active === item.path;
                return (
                  <a
                    key={item.path}
                    href={`#${item.path}`}
                    className={isActive ? "nav-item nav-item-active" : "nav-item"}
                    aria-current={isActive ? "page" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(item.path);
                      closeDrawer();
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
          <a
            className="account-entry"
            href="#/account"
            aria-current={active === "/account" ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate("/account");
              closeDrawer();
            }}
          >
            <UserCircleIcon size={18} />
            <span>个人设置</span>
          </a>
          <button className="btn btn-ghost" onClick={props.onLogout}>
            <LogoutIcon size={16} />
            退出登录
          </button>
        </div>
      </aside>

      {drawerOpen ? (
        <div className="nav-backdrop" onClick={closeDrawer} aria-hidden="true" />
      ) : null}

      <main className="main" id="main">
        <div className="topbar">
          <button
            type="button"
            className="nav-burger"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开菜单"
            aria-expanded={drawerOpen}
          >
            <MenuIcon size={18} />
          </button>
          <div className="topbar-meta">
            <span className="topbar-eyebrow">{pageTitle.eyebrow}</span>
            <span className="topbar-dot" aria-hidden="true" />
            <span className="topbar-title">{pageTitle.title}</span>
          </div>
          <div className="topbar-actions">
            <span className={`status-badge status-${sse.status} status-pill-compact`}>
              <span className="dot-pulse" />
              {STATUS_TEXT[sse.status]}
            </span>
            <button
              className="theme-toggle"
              onClick={toggle}
              aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
              title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            >
              {theme === "dark" ? <SunIcon size={13} /> : <MoonIcon size={13} />}
              {theme === "dark" ? "浅色" : "深色"}
            </button>
          </div>
        </div>
        {page}
      </main>
    </div>
  );
}

export function routeGroupTitle(active: string): string | undefined {
  for (const group of NAV) {
    if (group.items.some((it) => it.path === active)) return group.title;
  }
  return undefined;
}
