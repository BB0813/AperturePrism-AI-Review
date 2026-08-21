import { useCallback, useEffect, useState } from "react";
import {
  deleteLabelRule,
  fetchLabelRules,
  saveLabelRule,
  type LabelRuleItem,
} from "../lib/api";
import { useToast } from "../components/Toast";
import { GearIcon, XCircleIcon } from "../components/icons";

const RULE_VALUE_SUGGESTIONS = [
  "bug",
  "feature",
  "question",
  "security",
  "other",
  "S0",
  "S1",
  "S2",
  "S3",
  "unknown",
  "P0",
  "P1",
  "P2",
  "P3",
  "needs_triage",
  "complete",
  "actionable",
  "incomplete",
  "invalid",
];

/** 标签配置：分析结果字段 → GitHub 标签，独立菜单便于维护。 */
export function LabelsPage() {
  const toast = useToast();
  const [items, setItems] = useState<LabelRuleItem[]>([]);
  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [draft, setDraft] = useState({ key: "", label: "", enabled: true });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchLabelRules()
      .then((result) => {
        setItems(result.items);
        setPrefixes(result.prefixes);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => load(), [load]);

  const save = async () => {
    const key = draft.key.trim();
    const label = draft.label.trim();
    if (!key) {
      toast.error("规则键不能为空");
      return;
    }
    setBusy(true);
    try {
      await saveLabelRule({ key, label, enabled: draft.enabled });
      toast.success(
        label
          ? `已保存规则：${key} → ${label}（${draft.enabled ? "启用" : "停用"}）`
          : `已删除规则：${key}`,
      );
      setDraft({ key: "", label: "", enabled: true });
      load();
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (key: string) => {
    if (!window.confirm(`确定要删除标签规则「${key}」吗？`)) return;
    setBusy(true);
    try {
      await deleteLabelRule(key);
      toast.success(`已删除规则：${key}`);
      load();
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>标签配置</h1>
        <p className="sub">
          分析结果字段 → GitHub 标签；Issue 分析完成后命中规则由 worker 自动打标（幂等，失败不影响分析任务）。
        </p>
      </div>

      <div className="stack">
        <section className="panel">
          <div className="panel-title">
            <h2>
              <GearIcon size={14} /> 标签规则
            </h2>
            <span className="count">
              {items.length} 条{prefixes.length > 0 ? ` · 前缀 ${prefixes.join(" / ")}` : ""}
            </span>
          </div>

          <p className="faint" style={{ margin: "0 0 12px", fontSize: 12, lineHeight: 1.6 }}>
            每条规则把<strong>分析结果字段</strong>映射为一个 <strong>GitHub 标签</strong>，例如
            <code className="mono"> severity:S1 </code>→ 标签 <span className="chip">critical</span>、
            <code className="mono"> category:bug </code>→ 标签 <span className="chip">bug</span>。
            左边是匹配键（含前缀），右边箭头后才是实际打到 GitHub Issue 上的标签名，可改成任意 GitHub 标签
            （如 <code className="mono">enhancement</code>）。
          </p>

          <div className="stack" style={{ gap: 8 }}>
            {items.length === 0 ? (
              <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                尚未配置标签规则。Issue 分析完成后，命中规则会由 worker 自动给 GitHub Issue 打标签。
              </p>
            ) : (
              items.map((item) => (
                <div
                  key={item.key}
                  className="result-card"
                  style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
                >
                  <code className="mono" style={{ fontSize: 12 }}>
                    {item.key}
                  </code>
                  <span className="chip">→ {item.label}</span>
                  <span className={`pill ${item.enabled ? "pill-ok" : "pill-dim"}`}>
                    {item.enabled ? "启用" : "停用"}
                  </span>
                  <button
                    className="btn"
                    style={{ marginLeft: "auto" }}
                    onClick={() => remove(item.key)}
                    disabled={busy}
                    aria-label={`删除 ${item.key}`}
                  >
                    <XCircleIcon size={14} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              className="input"
              style={{ flex: "1 1 200px" }}
              list="label-rule-keys"
              placeholder="规则键，如 severity:S1"
              value={draft.key}
              onChange={(event) => setDraft((prev) => ({ ...prev, key: event.target.value }))}
            />
            <datalist id="label-rule-keys">
              {prefixes.flatMap((prefix) =>
                RULE_VALUE_SUGGESTIONS.map((value) => (
                  <option key={`${prefix}:${value}`} value={`${prefix}:${value}`} />
                )),
              )}
            </datalist>
            <input
              className="input"
              style={{ flex: "1 1 160px" }}
              placeholder="GitHub 标签名（留空=删除该规则）"
              value={draft.label}
              onChange={(event) => setDraft((prev) => ({ ...prev, label: event.target.value }))}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft((prev) => ({ ...prev, enabled: event.target.checked }))}
              />
              启用
            </label>
            <button className="btn btn-primary" onClick={save} disabled={busy}>
              {busy ? "保存中…" : "保存规则"}
            </button>
          </div>
          <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
            规则键形如 <code>category:bug</code> / <code>severity:S1</code> / <code>priority:P0</code> /{" "}
            <code>quality:incomplete</code>。首次进入会自动填充一组默认常用标签，可直接修改或删除。
          </p>
        </section>
      </div>
    </div>
  );
}
