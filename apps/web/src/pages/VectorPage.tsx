import { useCallback, useEffect, useState } from "react";
import { fetchVectorStats, type VectorStats } from "../lib/api";
import { RefreshIcon } from "../components/icons";
import { LoadingRows } from "../components/ui";

export function VectorPage() {
  const [stats, setStats] = useState<VectorStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchVectorStats()
      .then(setStats)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load vector stats");
        setStats(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">向量存储 &amp; 数据库</h1>
          <p className="page-desc">重复 Issue 检测的向量索引（issue_documents）与 Embedding 状态</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={load} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <div className="panel"><p className="state state-error">加载失败：{error}</p></div>
      ) : loading || !stats ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          <div className="kpi-grid">
            <Kpi value={stats.documents} label="已索引文档" tone="acc" />
            <Kpi value={stats.withEmbedding} label="含向量" tone="info" />
            <Kpi value={stats.withSignals} label="含信号特征" tone="vio" />
            <Kpi value={stats.repositoryCoverage} label="覆盖仓库" tone="ok" />
            <Kpi value={stats.embeddingConfigured ? "on" : "off"} label="Embedding 引擎" tone={stats.embeddingConfigured ? "ok" : "err"} />
          </div>

          <section className="panel">
            <div className="panel-title"><h2>Embedding 配置</h2></div>
            <dl className="kv">
              <dt>模型</dt><dd className="mono">{stats.embeddingModel}</dd>
              <dt>维度</dt><dd className="mono">4096</dd>
              <dt>状态</dt>
              <dd>
                {stats.embeddingConfigured ? (
                  <span className="pill pill-ok">已启用</span>
                ) : (
                  <span className="pill pill-err">未配置（需 EMBEDDING_BASE_URL / API_KEY）</span>
                )}
              </dd>
            </dl>
            <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
              pgvector 4096 维先于 ANN 索引上限（2000），当前以精确顺序扫描召回，规模较小时可接受。
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

function Kpi(props: { value: number | string; label: string; tone: string }) {
  return (
    <div className={`kpi ${props.tone}`}>
      <div className="kpi-value">{props.value}</div>
      <div className="kpi-label">{props.label}</div>
    </div>
  );
}