"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Queue = "gpt" | "residual" | "ai";
type Decision = "keep" | "remove" | "uncertain";

type ReviewItem = {
  id: string;
  queue: Queue;
  title: string;
  account: string;
  language: string;
  visual: "map" | "poster" | "photo" | "checklist" | "timeline";
  clip: number;
  gpt: "keep" | "not_keep" | "uncertain";
  criteria: [number, number, number];
  type: string;
  c2pa: string;
  tencent: string;
  tencentScore: number | null;
  reason: string;
};

const queues: { id: Queue; label: string; hint: string }[] = [
  { id: "gpt", label: "纠正 GPT 判断", hint: "核对 keep / not_keep / uncertain" },
  { id: "residual", label: "清理非信息图残留", hint: "集中移除 poster、photograph 等残留" },
  { id: "ai", label: "AI 图片辅助复核", hint: "结合 C2PA 与腾讯云信号人工判断" },
];

const stages = [
  ["01", "前期预处理", "规则与范围筛选", "120 → 74"],
  ["02", "OpenCLIP", "p ≥ 0.10 高召回", "74 → 41"],
  ["03", "GPT-5.5", "单图三项审核", "41 / 41"],
  ["04", "人工纠正", "修正 GPT 判断", "12 待审"],
  ["05", "残留清理", "poster / photograph", "7 待审"],
  ["06", "C2PA", "来源凭证检查", "16 / 16"],
  ["07", "腾讯云检测", "辅助人工复核", "3 待审"],
  ["08", "Final Dataset", "结果与复现包", "进行中"],
];

const items: ReviewItem[] = [
  { id: "EN-0041", queue: "gpt", title: "7-day China rail itinerary", account: "@travel_demo", language: "EN", visual: "map", clip: 0.86, gpt: "keep", criteria: [1, 1, 1], type: "route_map", c2pa: "尚未执行", tencent: "尚未执行", tencentScore: null, reason: "GPT 判断为路线图；需确认图片是否提供可执行的旅行信息。" },
  { id: "ES-0028", queue: "gpt", title: "Festival de primavera", account: "@culture_demo", language: "ES", visual: "poster", clip: 0.62, gpt: "keep", criteria: [1, 1, 1], type: "event_poster", c2pa: "尚未执行", tencent: "尚未执行", tencentScore: null, reason: "GPT 保留，但视觉上可能只是活动海报。" },
  { id: "JA-0017", queue: "gpt", title: "上海旅行チェックリスト", account: "@journey_demo", language: "JA", visual: "checklist", clip: 0.73, gpt: "uncertain", criteria: [1, 1, 0], type: "checklist", c2pa: "尚未执行", tencent: "尚未执行", tencentScore: null, reason: "语言与主题明确，信息组织结构需人工确认。" },
  { id: "EN-0063", queue: "residual", title: "Visit China this summer", account: "@fly_demo", language: "EN", visual: "photo", clip: 0.31, gpt: "keep", criteria: [1, 1, 1], type: "photograph", c2pa: "尚未执行", tencent: "尚未执行", tencentScore: null, reason: "GPT 残留清理：照片叠加短标题，缺少实质信息组织。" },
  { id: "ES-0054", queue: "residual", title: "Semana cultural", account: "@event_demo", language: "ES", visual: "poster", clip: 0.44, gpt: "keep", criteria: [1, 1, 1], type: "poster", c2pa: "尚未执行", tencent: "尚未执行", tencentScore: null, reason: "GPT 残留清理：需要区分活动海报与信息图。" },
  { id: "JA-0082", queue: "ai", title: "北京 3 日モデルコース", account: "@route_demo", language: "JA", visual: "timeline", clip: 0.91, gpt: "keep", criteria: [1, 1, 1], type: "timeline", c2pa: "no_claim_found", tencent: "疑似 AI 生成", tencentScore: 0.78, reason: "腾讯云检测仅作风险信号；结合可见证据决定是否需要进一步核查。" },
  { id: "EN-0095", queue: "ai", title: "First trip to Chengdu", account: "@panda_demo", language: "EN", visual: "checklist", clip: 0.88, gpt: "keep", criteria: [1, 1, 1], type: "checklist", c2pa: "no_claim_found", tencent: "未发现明显 AI 信号", tencentScore: 0.12, reason: "未检出凭证不等于真人制作；保留检测结果供人工判断。" },
];

const decisionLabel: Record<Decision, string> = { keep: "保留", remove: "排除", uncertain: "待定" };

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [queue, setQueue] = useState<Queue>("gpt");
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [showConfig, setShowConfig] = useState(false);

  const queueItems = useMemo(() => items.filter((item) => item.queue === queue), [queue]);
  const item = queueItems[index] ?? queueItems[0];
  const reviewed = Object.keys(decisions).length;

  const decide = useCallback((decision: Decision) => {
    if (!item) return;
    setDecisions((current) => ({ ...current, [item.id]: decision }));
    setIndex((value) => Math.min(queueItems.length - 1, value + 1));
  }, [item, queueItems.length]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (event.key === "1") decide("keep");
      if (event.key === "2") decide("remove");
      if (event.key === "3") decide("uncertain");
      if (event.key === "ArrowLeft") setIndex((value) => Math.max(0, value - 1));
      if (event.key === "ArrowRight") setIndex((value) => Math.min(queueItems.length - 1, value + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, queueItems.length]);

  const switchQueue = (next: Queue) => {
    setQueue(next);
    setIndex(0);
  };

  const exportCsv = () => {
    const rows = ["record_id,queue,manual_decision,note", ...items.map((x) => [x.id, x.queue, decisions[x.id] ?? "", JSON.stringify(notes[x.id] ?? "")].join(","))];
    download("insightflow_demo_reviews.csv", `\ufeff${rows.join("\n")}`, "text/csv;charset=utf-8");
  };

  const exportManifest = () => download("insightflow_reproduction_manifest.json", JSON.stringify({
    demo: true,
    workflow_version: "insightflow-demo-v0.1",
    clip_threshold: 0.10,
    clip_model: "OpenCLIP ViT-B/32",
    gpt_model: "GPT-5.5 single-image review",
    stages: stages.map((stage) => stage[1]),
    decisions,
    notes,
  }, null, 2), "application/json");

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">IF</span><div><strong>InsightFlow</strong><small>Reproducible Data Screening</small></div></div>
        <div className="project-switch"><span className="live-dot" /> China Travel Infographics <b>Demo Run</b></div>
        <div className="top-actions"><button className="ghost" onClick={() => setShowConfig(true)}>运行配置</button><button className="primary" onClick={exportCsv}>导出审核结果</button></div>
      </header>

      <section className="pipeline" aria-label="Data Screening 流程">
        {stages.map(([no, title, subtitle, count], stageIndex) => (
          <div className={`stage-step ${stageIndex < 3 ? "done" : stageIndex < 7 ? "active" : "pending"}`} key={no}>
            <span>{no}</span><div><strong>{title}</strong><small>{subtitle}</small></div><em>{count}</em>
          </div>
        ))}
      </section>

      <section className="workspace">
        <aside className="queue-panel">
          <div className="section-kicker">HUMAN REVIEW</div>
          <h1>分阶段人工审核</h1>
          <p>模型提供信号，人负责最终判断。三类队列独立记录，避免混淆判断目的。</p>
          <nav className="queue-nav">
            {queues.map((entry) => {
              const total = items.filter((x) => x.queue === entry.id).length;
              const done = items.filter((x) => x.queue === entry.id && decisions[x.id]).length;
              return <button className={queue === entry.id ? "selected" : ""} onClick={() => switchQueue(entry.id)} key={entry.id}>
                <span><b>{entry.label}</b><small>{entry.hint}</small></span><em>{done}/{total}</em>
              </button>;
            })}
          </nav>
          <div className="run-summary"><span>本次已审核</span><strong>{reviewed}<small> / {items.length}</small></strong><div><i style={{ width: `${reviewed / items.length * 100}%` }} /></div></div>
          <button className="manifest-button" onClick={exportManifest}>下载复现配置</button>
        </aside>

        {item && <section className="review-stage">
          <div className="review-head"><div><span>{item.id}</span><b>{item.language}</b><b>{item.type}</b></div><small>{index + 1} / {queueItems.length}</small></div>
          <div className={`mock-image ${item.visual}`} role="img" aria-label={`${item.title} 脱敏示意图`}>
            <div className="mock-grid" /><div className="mock-route" /><div className="mock-copy"><small>TRAVEL FIELD NOTE</small><strong>{item.title}</strong><span>DEMO · SOURCE REDACTED</span></div>
          </div>
          <div className="item-caption"><div><strong>{item.title}</strong><span>{item.account} · 公开演示数据已脱敏</span></div><span className={`decision-chip ${decisions[item.id] ?? ""}`}>{decisions[item.id] ? `人工：${decisionLabel[decisions[item.id]]}` : "等待人工判断"}</span></div>
          <div className="reason-box"><span>当前审核任务</span><p>{item.reason}</p></div>
          <textarea aria-label="人工审核备注" value={notes[item.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} placeholder="记录判断依据（可选）" />
          <div className="decision-actions">
            <button className="keep" onClick={() => decide("keep")}><kbd>1</kbd> 人工保留</button>
            <button className="remove" onClick={() => decide("remove")}><kbd>2</kbd> 人工排除</button>
            <button className="uncertain" onClick={() => decide("uncertain")}><kbd>3</kbd> 暂时待定</button>
          </div>
          <div className="pagination"><button disabled={index === 0} onClick={() => setIndex(index - 1)}>← 上一张</button><span>所有判断均保留原始模型结果</span><button disabled={index === queueItems.length - 1} onClick={() => setIndex(index + 1)}>下一张 →</button></div>
        </section>}

        {item && <aside className="evidence-panel">
          <div className="section-kicker">EVIDENCE TRACE</div><h2>完整处理轨迹</h2>
          <div className="trace-list">
            <div className="complete"><span>01</span><p><b>前期预处理</b><small>范围内 · 内容相关 · canonical</small></p><em>通过</em></div>
            <div className="complete"><span>02</span><p><b>OpenCLIP</b><small>ViT-B/32 · 阈值 p ≥ 0.10</small></p><em>p {item.clip.toFixed(2)}</em></div>
            <div className="complete"><span>03</span><p><b>GPT-5.5 单图审核</b><small>语言 / China 主题 / 信息图</small></p><em>{item.gpt}</em></div>
            <div><span>04</span><p><b>人工纠正</b><small>不覆盖 GPT 原始输出</small></p><em>{decisions[item.id] ? decisionLabel[decisions[item.id]] : "待审核"}</em></div>
            <div><span>05</span><p><b>非信息图残留清理</b><small>poster / photograph 等</small></p><em>{item.queue === "residual" ? "当前队列" : "—"}</em></div>
            <div><span>06</span><p><b>C2PA 凭证</b><small>只检查来源凭证</small></p><em>{item.c2pa}</em></div>
            <div><span>07</span><p><b>腾讯云 AI 检测</b><small>只辅助人工复核</small></p><em>{item.tencentScore === null ? item.tencent : `${item.tencentScore.toFixed(2)}`}</em></div>
          </div>
          <div className="gpt-card"><span>GPT 三项判断</span><div>{["目标语言", "China 主题", "信息图结构"].map((label, i) => <p key={label}><b>{label}</b><em className={item.criteria[i] ? "yes" : "no"}>{item.criteria[i] ? "1 · yes" : "0 · no"}</em></p>)}</div></div>
          <p className="principle">C2PA 未检出凭证不代表真人制作；腾讯云分数不自动触发删除。最终标签始终由人工确认。</p>
        </aside>}
      </section>

      {showConfig && <div className="modal-backdrop"><button className="modal-dismiss" aria-label="关闭运行配置" onClick={() => setShowConfig(false)} /><section className="config-modal">
        <button className="modal-close" onClick={() => setShowConfig(false)}>×</button><div className="section-kicker">RUN CONFIGURATION</div><h2>运行配置快照</h2><p>每次运行固定保存配置、模型、Prompt 与代码版本，确保流程可追溯、可重跑。</p>
        <dl><div><dt>OpenCLIP 候选线</dt><dd>p ≥ 0.10</dd></div><div><dt>CLIP 模型</dt><dd>ViT-B/32</dd></div><div><dt>GPT 审核方式</dt><dd>GPT-5.5 · 单图输入</dd></div><div><dt>人工阶段</dt><dd>GPT 纠正 + 残留清理</dd></div><div><dt>来源审查</dt><dd>C2PA + 腾讯云辅助检测</dd></div><div><dt>演示数据</dt><dd>脱敏、预计算，不代表论文最终统计</dd></div></dl>
        <button className="primary full" onClick={exportManifest}>下载 JSON 复现配置</button>
      </section></div>}
    </main>
  );
}
