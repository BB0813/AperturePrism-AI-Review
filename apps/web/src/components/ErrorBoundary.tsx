import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * 全局错误兜底（5.3）：此前任何页面渲染抛错都会把整个 React 树打白屏，用户
 * 只能强刷且丢失现场。边界捕获后给出可读面板 + 恢复按钮；错误对象写入 console
 * 便于反馈截图。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page">
        <section className="panel" style={{ borderColor: "var(--warn-bd)" }}>
          <div className="panel-title"><h2>页面出错了</h2></div>
          <p className="result-summary">
            界面渲染遇到未预期的错误，其余功能不受影响。可尝试「重试」恢复当前页；
            若反复出现，请刷新页面或带着控制台里的报错信息反馈。
          </p>
          <pre
            className="mono"
            style={{
              margin: "12px 0",
              padding: "10px 12px",
              fontSize: 12,
              background: "var(--panel-2)",
              borderRadius: 8,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {error.message}
          </pre>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" onClick={this.reset}>
              重试
            </button>
            <button className="btn" onClick={() => window.location.reload()}>
              刷新页面
            </button>
          </div>
        </section>
      </div>
    );
  }
}
