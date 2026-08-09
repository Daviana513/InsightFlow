"use client";
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useState } from "react";

type Decision = "keep" | "remove" | "uncertain";
type AiReview = "likely_human" | "likely_ai" | "uncertain";
type StageId = "preprocess" | "openclip" | "gpt" | "human" | "residual" | "c2pa" | "tencent" | "final";
type Visual = "map" | "poster" | "photo" | "checklist" | "timeline";

type ReviewRecord = {
  id: string;
  title: string;
  fileName: string;
  account: string;
  language: string;
  type: string;
  visual: Visual;
  imageSrc?: string;
  uploaded: boolean;
  preprocess: "pending" | "passed" | "excluded";
  clip: number;
  gpt: "pending" | "keep" | "not_keep" | "uncertain";
  criteria: [number, number, number];
  humanGptDecision: Decision | null;
  residualDecision: Decision | null;
  c2pa: "pending" | "claim_found" | "no_claim_found" | "demo_no_claim_found";
  tencentScore: number | null;
  humanAiReview: AiReview | null;
  note: string;
};

const stages: { id: StageId; no: string; title: string; subtitle: string }[] = [
  { id: "preprocess", no: "01", title: "前期预处理", subtitle: "上传 · 规则与范围" },
  { id: "openclip", no: "02", title: "OpenCLIP", subtitle: "p ≥ 0.10 高召回" },
  { id: "gpt", no: "03", title: "GPT-5.5", subtitle: "单图三项审核" },
  { id: "human", no: "04", title: "人工纠正", subtitle: "修正 GPT 判断" },
  { id: "residual", no: "05", title: "残留清理", subtitle: "poster / photograph" },
  { id: "c2pa", no: "06", title: "C2PA", subtitle: "来源凭证检查" },
  { id: "tencent", no: "07", title: "腾讯云检测", subtitle: "辅助人工复核" },
  { id: "final", no: "08", title: "Final Dataset", subtitle: "结果与复现包" },
];

const initialRecords: ReviewRecord[] = [
  { id: "EN-0041", title: "7-day China rail itinerary", fileName: "en_0041.jpg", account: "@travel_demo", language: "EN", type: "route_map", visual: "map", uploaded: false, preprocess: "passed", clip: 0.86, gpt: "keep", criteria: [1, 1, 1], humanGptDecision: null, residualDecision: null, c2pa: "no_claim_found", tencentScore: 0.18, humanAiReview: null, note: "" },
  { id: "ES-0028", title: "Festival de primavera", fileName: "es_0028.jpg", account: "@culture_demo", language: "ES", type: "event_poster", visual: "poster", uploaded: false, preprocess: "passed", clip: 0.62, gpt: "keep", criteria: [1, 1, 1], humanGptDecision: null, residualDecision: null, c2pa: "no_claim_found", tencentScore: 0.21, humanAiReview: null, note: "" },
  { id: "JA-0017", title: "上海旅行チェックリスト", fileName: "ja_0017.jpg", account: "@journey_demo", language: "JA", type: "checklist", visual: "checklist", uploaded: false, preprocess: "passed", clip: 0.73, gpt: "uncertain", criteria: [1, 1, 0], humanGptDecision: null, residualDecision: null, c2pa: "no_claim_found", tencentScore: 0.34, humanAiReview: null, note: "" },
  { id: "EN-0063", title: "Visit China this summer", fileName: "en_0063.jpg", account: "@fly_demo", language: "EN", type: "photograph", visual: "photo", uploaded: false, preprocess: "passed", clip: 0.31, gpt: "keep", criteria: [1, 1, 1], humanGptDecision: null, residualDecision: null, c2pa: "no_claim_found", tencentScore: 0.09, humanAiReview: null, note: "" },
  { id: "ES-0054", title: "Semana cultural", fileName: "es_0054.jpg", account: "@event_demo", language: "ES", type: "poster", visual: "poster", uploaded: false, preprocess: "passed", clip: 0.44, gpt: "keep", criteria: [1, 1, 1], humanGptDecision: null, residualDecision: null, c2pa: "no_claim_found", tencentScore: 0.27, humanAiReview: null, note: "" },
  { id: "JA-0082", title: "北京 3 日モデルコース", fileName: "ja_0082.jpg", account: "@route_demo", language: "JA", type: "timeline", visual: "timeline", uploaded: false, preprocess: "passed", clip: 0.91, gpt: "keep", criteria: [1, 1, 1], humanGptDecision: null, residualDecision: null, c2pa: "no_claim_found", tencentScore: 0.78, humanAiReview: null, note: "" },
];

const decisionLabel: Record<Decision, string> = { keep: "保留", remove: "排除", uncertain: "待定" };
const aiLabel: Record<AiReview, string> = { likely_human: "倾向真人制作", likely_ai: "倾向 AI 生成", uncertain: "证据不足" };
const storageKey = "insightflow-local-workspace-v1";

function hash(text: string) {
  return [...text].reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 7);
}

function readImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function finalDecision(record: ReviewRecord, threshold: number): Decision {
  if (record.preprocess === "excluded" || record.clip < threshold) return "remove";
  if (record.humanGptDecision === "remove" || record.residualDecision === "remove") return "remove";
  if (record.humanGptDecision === "uncertain" || record.residualDecision === "uncertain") return "uncertain";
  if (record.residualDecision === "keep") return "keep";
  return "uncertain";
}

export default function Home() {
  const [activeStage, setActiveStage] = useState(0);
  const [records, setRecords] = useState<ReviewRecord[]>(initialRecords);
  const [projectName, setProjectName] = useState("China Travel Infographics");
  const [threshold, setThreshold] = useState(0.1);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [showConfig, setShowConfig] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState("演示数据已加载。你也可以在第 1 步上传自己的图片。");
  const [rules, setRules] = useState({ scope: true, relevance: true, deduplicate: true });

  useEffect(() => {
    const restoreTimer = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const workspace = JSON.parse(saved);
          if (Array.isArray(workspace.records)) setRecords(workspace.records);
          if (workspace.projectName) setProjectName(workspace.projectName);
          if (typeof workspace.threshold === "number") setThreshold(workspace.threshold);
          if (workspace.rules) setRules(workspace.rules);
          setNotice("已恢复这台设备上次保存的审核进度。");
        }
      } catch {
        setNotice("本地进度无法恢复，已重新加载演示数据。");
      }
      const stage = new URLSearchParams(window.location.search).get("stage");
      const stageIndex = stages.findIndex((entry) => entry.id === stage);
      if (stageIndex >= 0) setActiveStage(stageIndex);
      setHydrated(true);
    }, 0);
    const onPopState = () => {
      const current = new URLSearchParams(window.location.search).get("stage");
      const index = stages.findIndex((entry) => entry.id === current);
      if (index >= 0) setActiveStage(index);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.clearTimeout(restoreTimer);
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ records, projectName, threshold, rules }));
    } catch {
      window.setTimeout(() => setNotice("图片总量超过浏览器本地容量，请减少图片后重试。"), 0);
    }
  }, [hydrated, projectName, records, rules, threshold]);

  const candidates = useMemo(() => records.filter((record) => record.preprocess === "passed" && record.clip >= threshold), [records, threshold]);
  const humanQueue = useMemo(() => candidates.filter((record) => record.gpt !== "pending"), [candidates]);
  const residualQueue = useMemo(() => humanQueue.filter((record) => record.humanGptDecision === "keep"), [humanQueue]);
  const finalRecords = useMemo(() => records.map((record) => ({ ...record, final: finalDecision(record, threshold) })), [records, threshold]);

  const updateRecord = useCallback((id: string, patch: Partial<ReviewRecord>) => {
    setRecords((current) => current.map((record) => record.id === id ? { ...record, ...patch } : record));
  }, []);

  const navigate = useCallback((index: number) => {
    const safeIndex = Math.max(0, Math.min(stages.length - 1, index));
    setActiveStage(safeIndex);
    setReviewIndex(0);
    window.history.pushState({}, "", `?stage=${stages[safeIndex].id}`);
  }, []);

  const stageProgress = useMemo(() => {
    const risky = records.filter((record) => record.tencentScore != null && record.tencentScore >= 0.5);
    return [
      `${records.filter((record) => record.preprocess !== "pending").length}/${records.length}`,
      `${candidates.length}/${records.filter((record) => record.preprocess === "passed").length}`,
      `${candidates.filter((record) => record.gpt !== "pending").length}/${candidates.length}`,
      `${humanQueue.filter((record) => record.humanGptDecision).length}/${humanQueue.length}`,
      `${residualQueue.filter((record) => record.residualDecision).length}/${residualQueue.length}`,
      `${records.filter((record) => record.c2pa !== "pending").length}/${records.length}`,
      `${risky.filter((record) => record.humanAiReview).length}/${risky.length}`,
      `${finalRecords.filter((record) => record.final === "keep").length} keep`,
    ];
  }, [candidates, finalRecords, humanQueue, records, residualQueue]);

  const stageDone = [
    records.length > 0 && records.every((record) => record.preprocess !== "pending"),
    candidates.length > 0,
    candidates.length > 0 && candidates.every((record) => record.gpt !== "pending"),
    humanQueue.length > 0 && humanQueue.every((record) => record.humanGptDecision),
    residualQueue.length > 0 && residualQueue.every((record) => record.residualDecision),
    records.length > 0 && records.every((record) => record.c2pa !== "pending"),
    records.filter((record) => (record.tencentScore ?? 0) >= 0.5).every((record) => record.humanAiReview),
    false,
  ];

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    const images = [...files].filter((file) => file.type.startsWith("image/"));
    const totalBytes = images.reduce((total, file) => total + file.size, 0);
    if (!images.length) return setNotice("请选择 JPG、PNG 或 WebP 图片。");
    if (images.length > 12 || totalBytes > 4_000_000) return setNotice("公开 Demo 最多保存 12 张、合计 4MB 的图片。");
    const uploaded = await Promise.all(images.map(async (file, index): Promise<ReviewRecord> => {
      const seed = hash(file.name);
      const clip = Number((0.05 + (seed % 91) / 100).toFixed(2));
      return {
        id: `UP-${Date.now()}-${String(index + 1).padStart(2, "0")}`,
        title: file.name.replace(/\.[^.]+$/, "").replaceAll(/[-_]/g, " "),
        fileName: file.name,
        account: "local_upload",
        language: "待识别",
        type: "unclassified",
        visual: ["map", "poster", "photo", "checklist", "timeline"][seed % 5] as Visual,
        imageSrc: await readImage(file),
        uploaded: true,
        preprocess: "pending",
        clip,
        gpt: "pending",
        criteria: [0, 0, 0],
        humanGptDecision: null,
        residualDecision: null,
        c2pa: "pending",
        tencentScore: null,
        humanAiReview: null,
        note: "",
      };
    }));
    setRecords((current) => current.every((record) => !record.uploaded) ? uploaded : [...current, ...uploaded]);
    setProjectName("My Screening Run");
    setNotice(`已在这台设备保存 ${uploaded.length} 张图片。模型结果将在各步骤中以 Demo 模拟运行。`);
  };

  const resetWorkspace = () => {
    if (!window.confirm("确定清除这台设备上的当前进度并恢复演示数据吗？")) return;
    localStorage.removeItem(storageKey);
    setRecords(initialRecords);
    setProjectName("China Travel Infographics");
    setThreshold(0.1);
    setNotice("已恢复脱敏演示数据。");
    navigate(0);
  };

  const runPreprocess = () => {
    setRecords((current) => current.map((record) => ({ ...record, preprocess: "passed" })));
    setNotice("预处理完成：公开 Demo 默认通过已上传图片，正式规则将在研究模式运行。");
    navigate(1);
  };

  const runGptDemo = () => {
    setRecords((current) => current.map((record) => {
      if (record.preprocess !== "passed" || record.clip < threshold || record.gpt !== "pending") return record;
      const keep = record.clip >= 0.55;
      return { ...record, gpt: keep ? "keep" : record.clip >= 0.25 ? "uncertain" : "not_keep", criteria: [1, 1, keep ? 1 : 0] };
    }));
    setNotice("GPT Demo 结果已生成。这是可复现模拟信号，不代表真实 API 调用。");
  };

  const runC2paDemo = () => {
    setRecords((current) => current.map((record) => ({ ...record, c2pa: record.c2pa === "pending" ? "demo_no_claim_found" : record.c2pa })));
    setNotice("C2PA Demo 检查完成：未检出凭证不等于真人制作。");
  };

  const runTencentDemo = () => {
    setRecords((current) => current.map((record) => ({ ...record, tencentScore: record.tencentScore ?? Number(((hash(record.fileName) % 91) / 100).toFixed(2)) })));
    setNotice("腾讯云 Demo 风险分数已生成；最终结论仍需人工确认。");
  };

  const exportCsv = () => {
    const headers = ["record_id", "file_name", "clip_probability", "gpt_decision", "human_gpt_correction", "residual_cleanup", "c2pa_status", "tencent_ai_score", "human_ai_review", "final_decision", "note"];
    const rows = finalRecords.map((record) => [record.id, record.fileName, record.clip, record.gpt, record.humanGptDecision, record.residualDecision, record.c2pa, record.tencentScore, record.humanAiReview, record.final, record.note].map(csvCell).join(","));
    download("insightflow_final_dataset.csv", `\ufeff${[headers.join(","), ...rows].join("\n")}`, "text/csv;charset=utf-8");
  };

  const exportManifest = () => download("insightflow_reproduction_manifest.json", JSON.stringify({
    product: "InsightFlow",
    workflowVersion: "local-demo-v0.2",
    exportedAt: new Date().toISOString(),
    projectName,
    deviceLocal: true,
    clipThreshold: threshold,
    rules,
    models: { openclip: "Demo deterministic score · production target ViT-B/32", gpt: "Demo deterministic decision · production target GPT-5.5", c2pa: "Demo status", tencent: "Demo risk score" },
    stages: stages.map(({ no, title }) => ({ no, title })),
    records: finalRecords,
  }, null, 2), "application/json");

  const reviewerMode = activeStage === 3 ? "humanGptDecision" : "residualDecision";
  const reviewQueue = activeStage === 3 ? humanQueue : residualQueue;
  const reviewRecord = reviewQueue[reviewIndex] ?? reviewQueue[0];
  const reviewValue = reviewRecord ? reviewRecord[reviewerMode] : null;

  const decide = useCallback((decision: Decision) => {
    if (!reviewRecord) return;
    updateRecord(reviewRecord.id, { [reviewerMode]: decision });
    setReviewIndex((current) => Math.min(reviewQueue.length - 1, current + 1));
    setNotice(`已保存 ${reviewRecord.id}：${decisionLabel[decision]}。可返回上一张修改。`);
  }, [reviewQueue.length, reviewRecord, reviewerMode, updateRecord]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (showConfig || ![3, 4].includes(activeStage) || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target?.tagName)) return;
      if (event.key === "1") decide("keep");
      if (event.key === "2") decide("remove");
      if (event.key === "3") decide("uncertain");
      if (event.key === "ArrowLeft") setReviewIndex((value) => Math.max(0, value - 1));
      if (event.key === "ArrowRight") setReviewIndex((value) => Math.min(reviewQueue.length - 1, value + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeStage, decide, reviewQueue.length, showConfig]);

  const uploadCard = (
    <section className="upload-card">
      <div><span className="eyebrow">LOCAL DEMO WORKSPACE</span><h2>创建一次可复现筛选</h2><p>图片只保存在当前设备。公开版不会上传论文数据，也不会调用真实模型。</p></div>
      <label className="upload-button"><input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => handleUpload(event.target.files)} />＋ 选择图片</label>
      <small>JPG / PNG / WebP · 最多 12 张 · 合计不超过 4MB</small>
    </section>
  );

  const reviewWorkspace = reviewRecord ? (
    <section className="review-workspace">
      <aside className="review-sidebar">
        <span className="eyebrow">HUMAN REVIEW</span>
        <h2>{activeStage === 3 ? "纠正 GPT 判断" : "清理非信息图残留"}</h2>
        <p>{activeStage === 3 ? "核对语言、China 主题和信息图结构，不覆盖 GPT 原始结果。" : "集中清除 GPT 残留的 poster、photograph 等非信息图。"}</p>
        <div className="queue-list">{reviewQueue.map((record, index) => <button className={index === reviewIndex ? "selected" : ""} onClick={() => setReviewIndex(index)} key={record.id}><span>{record.id}<small>{record.title}</small></span><em>{record[reviewerMode] ? decisionLabel[record[reviewerMode] as Decision] : "待审"}</em></button>)}</div>
        <button className="secondary wide" onClick={() => navigate(activeStage + 1)}>进入下一步骤 →</button>
      </aside>
      <section className="review-center">
        <div className="record-meta"><div><b>{reviewRecord.id}</b><span>{reviewRecord.language}</span><span>{reviewRecord.type}</span></div><small>{reviewIndex + 1} / {reviewQueue.length}</small></div>
        {reviewRecord.imageSrc ? <img className="uploaded-preview" src={reviewRecord.imageSrc} alt={reviewRecord.title} /> : <div className={`mock-image ${reviewRecord.visual}`} role="img" aria-label={`${reviewRecord.title} 脱敏示意图`}><div className="mock-grid" /><div className="mock-route" /><div className="mock-copy"><small>TRAVEL FIELD NOTE</small><strong>{reviewRecord.title}</strong><span>DEMO · SOURCE REDACTED</span></div></div>}
        <div className="record-title"><div><strong>{reviewRecord.title}</strong><span>{reviewRecord.account} · {reviewRecord.uploaded ? "本地上传" : "脱敏演示"}</span></div><b className={`decision-pill ${reviewValue ?? ""}`}>{reviewValue ? `人工：${decisionLabel[reviewValue]}` : "等待人工判断"}</b></div>
        <textarea aria-label="人工审核备注" value={reviewRecord.note} onChange={(event) => updateRecord(reviewRecord.id, { note: event.target.value })} placeholder="记录判断依据（自动保存到当前设备）" />
        <div className="decision-actions"><button className="keep" onClick={() => decide("keep")}><kbd>1</kbd> 人工保留</button><button className="remove" onClick={() => decide("remove")}><kbd>2</kbd> 人工排除</button><button className="uncertain" onClick={() => decide("uncertain")}><kbd>3</kbd> 暂时待定</button></div>
        <div className="pagination"><button disabled={reviewIndex === 0} onClick={() => setReviewIndex((value) => value - 1)}>← 上一张</button><span>模型原始结果始终保留</span><button disabled={reviewIndex === reviewQueue.length - 1} onClick={() => setReviewIndex((value) => value + 1)}>下一张 →</button></div>
      </section>
      <aside className="evidence-panel"><span className="eyebrow">EVIDENCE TRACE</span><h2>单图处理轨迹</h2><div className="trace-list"><div><span>01</span><p><b>前期预处理</b><small>规则与范围</small></p><em>{reviewRecord.preprocess}</em></div><div><span>02</span><p><b>OpenCLIP</b><small>阈值 p ≥ {threshold.toFixed(2)}</small></p><em>p {reviewRecord.clip.toFixed(2)}</em></div><div><span>03</span><p><b>GPT-5.5</b><small>原始结果不覆盖</small></p><em>{reviewRecord.gpt}</em></div><div><span>04</span><p><b>人工纠正</b><small>独立字段</small></p><em>{reviewRecord.humanGptDecision ?? "pending"}</em></div><div><span>05</span><p><b>残留清理</b><small>独立字段</small></p><em>{reviewRecord.residualDecision ?? "pending"}</em></div><div><span>06</span><p><b>C2PA</b><small>来源凭证</small></p><em>{reviewRecord.c2pa}</em></div><div><span>07</span><p><b>AI 风险信号</b><small>不自动删除</small></p><em>{reviewRecord.tencentScore ?? "pending"}</em></div></div><p className="principle">C2PA 与腾讯云只提供来源和风险线索，是否进入最终数据集仍由人工结论决定。</p></aside>
    </section>
  ) : <section className="empty-state"><span>当前队列为空</span><h2>请先完成上一个步骤</h2><p>只有通过前序条件的图片才会进入本阶段。</p><button className="primary" onClick={() => navigate(activeStage - 1)}>返回上一步</button></section>;

  return (
    <main className="app-shell">
      <header className="topbar"><div className="brand"><span className="brand-mark">IF</span><div><strong>InsightFlow</strong><small>Reproducible Data Screening</small></div></div><div className="project-switch"><span className="live-dot" />{projectName}<b>Local Demo</b></div><div className="top-actions"><button className="ghost" onClick={() => setShowConfig(true)}>运行配置</button><button className="primary" onClick={() => navigate(0)}>＋ 新建 / 上传</button></div></header>

      <nav className="pipeline" aria-label="Data Screening 流程">{stages.map((stage, index) => <button className={`stage-step ${index === activeStage ? "current" : stageDone[index] ? "done" : "pending"}`} onClick={() => navigate(index)} aria-current={index === activeStage ? "step" : undefined} key={stage.id}><span>{stage.no}</span><div><strong>{stage.title}</strong><small>{stage.subtitle}</small></div><em>{stageProgress[index]}</em></button>)}</nav>
      <div className="notice-bar"><span>{notice}</span><button onClick={resetWorkspace}>恢复演示数据</button></div>

      {activeStage === 0 && <section className="stage-page"><header className="stage-heading"><div><span className="eyebrow">STEP 01 · INPUT</span><h1>上传与前期预处理</h1><p>建立本次运行的数据边界。正式研究模式会在这里接入批量 ZIP、metadata CSV 与服务端存储。</p></div><button className="primary" onClick={runPreprocess}>执行预处理 →</button></header>{uploadCard}<div className="content-grid"><section className="panel"><h3>预处理规则</h3>{[["scope", "研究范围与国家范围"], ["relevance", "内容相关性"], ["deduplicate", "重复与 canonical 记录"]].map(([key, label]) => <label className="rule-row" key={key}><span className="sr-only">启用预处理规则</span><input aria-label={label} type="checkbox" checked={rules[key as keyof typeof rules]} onChange={(event) => setRules((current) => ({ ...current, [key]: event.target.checked }))} /><span><b>{label}</b><small>当前 Demo 记录配置，不在浏览器中伪造正式筛选。</small></span></label>)}</section><section className="panel"><div className="panel-head"><h3>输入记录</h3><span>{records.length} items</span></div><div className="compact-list">{records.map((record) => <div key={record.id}><span>{record.imageSrc ? <img src={record.imageSrc} alt="" /> : <i className={record.visual} />}</span><p><b>{record.fileName}</b><small>{record.uploaded ? "本地上传" : "脱敏演示数据"}</small></p><em>{record.preprocess}</em></div>)}</div></section></div></section>}

      {activeStage === 1 && <section className="stage-page"><header className="stage-heading"><div><span className="eyebrow">STEP 02 · HIGH RECALL</span><h1>OpenCLIP 候选筛选</h1><p>阈值只决定哪些图片进入下一阶段，不代表最终信息图分类。</p></div><button className="primary" onClick={() => navigate(2)}>确认候选集 →</button></header><section className="threshold-card"><div><span>候选阈值</span><strong>p ≥ {threshold.toFixed(2)}</strong><small>公开版分数为可复现 Demo 信号</small></div><input aria-label="OpenCLIP 候选阈值" type="range" min="0.05" max="0.9" step="0.05" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /><div className="threshold-metrics"><p><b>{records.filter((record) => record.preprocess === "passed").length}</b><span>输入</span></p><p><b>{candidates.length}</b><span>进入 GPT</span></p><p><b>{records.filter((record) => record.preprocess === "passed" && record.clip < threshold).length}</b><span>低于阈值</span></p></div></section><section className="panel"><div className="panel-head"><h3>分数与候选结果</h3><span>ViT-B/32 · production target</span></div><div className="score-list">{records.filter((record) => record.preprocess === "passed").map((record) => <div key={record.id}><p><b>{record.id}</b><small>{record.title}</small></p><div><i style={{ width: `${record.clip * 100}%` }} /></div><em>{record.clip.toFixed(2)}</em><span className={record.clip >= threshold ? "pass" : "fail"}>{record.clip >= threshold ? "进入" : "排除"}</span></div>)}</div></section></section>}

      {activeStage === 2 && <section className="stage-page"><header className="stage-heading"><div><span className="eyebrow">STEP 03 · MODEL REVIEW</span><h1>GPT-5.5 单图审核</h1><p>按目标语言、China 主题和信息图结构三项标准逐图输出原始判断。</p></div><button className="primary" onClick={runGptDemo}>运行 Demo 审核</button></header><div className="model-banner"><b>Demo 模拟模式</b><span>真实 API、费用与 Prompt 版本将在论文研究模式由服务端管理。</span></div><section className="panel"><div className="panel-head"><h3>单图审核结果</h3><span>{candidates.filter((record) => record.gpt !== "pending").length}/{candidates.length} complete</span></div><div className="result-table"><div className="table-head"><span>Record</span><span>CLIP</span><span>语言</span><span>China</span><span>信息图</span><span>GPT 判断</span></div>{candidates.map((record) => <div key={record.id}><p><b>{record.id}</b><small>{record.title}</small></p><span>{record.clip.toFixed(2)}</span>{record.criteria.map((value, index) => <span className={value ? "yes" : "no"} key={index}>{record.gpt === "pending" ? "—" : value ? "yes" : "no"}</span>)}<em>{record.gpt}</em></div>)}</div></section><button className="secondary next-button" onClick={() => navigate(3)}>进入人工纠正 →</button></section>}

      {(activeStage === 3 || activeStage === 4) && reviewWorkspace}

      {activeStage === 5 && <section className="stage-page"><header className="stage-heading"><div><span className="eyebrow">STEP 06 · PROVENANCE</span><h1>C2PA 来源凭证检查</h1><p>检查内容凭证及 manifest，不把“未检出凭证”解释为真人制作。</p></div><button className="primary" onClick={runC2paDemo}>运行 Demo 检查</button></header><div className="model-banner neutral"><b>来源信号，不是分类器</b><span>C2PA 结果不会自动修改信息图判断或删除记录。</span></div><section className="card-grid">{records.map((record) => <article className="provenance-card" key={record.id}><div><b>{record.id}</b><span>{record.title}</span></div><strong>{record.c2pa}</strong><dl><div><dt>凭证</dt><dd>{record.c2pa === "claim_found" ? "found" : "not found"}</dd></div><div><dt>最终动作</dt><dd>保留信号，人工判断</dd></div></dl></article>)}</section><button className="secondary next-button" onClick={() => navigate(6)}>进入 AI 图片辅助复核 →</button></section>}

      {activeStage === 6 && <section className="stage-page"><header className="stage-heading"><div><span className="eyebrow">STEP 07 · AI RISK SIGNAL</span><h1>腾讯云检测辅助人工复核</h1><p>风险分数与信息图标签相互独立，不自动触发删除。</p></div><button className="primary" onClick={runTencentDemo}>生成 Demo 风险分数</button></header><div className="model-banner"><b>Demo 模拟模式</b><span>真实腾讯云调用需要在服务端保存 SecretId 与 SecretKey。</span></div><section className="ai-review-list">{records.map((record) => <article key={record.id}><div className="risk-score"><span>AI risk</span><strong>{record.tencentScore == null ? "—" : record.tencentScore.toFixed(2)}</strong><i style={{ width: `${(record.tencentScore ?? 0) * 100}%` }} /></div><div><b>{record.id}</b><span>{record.title}</span></div><div className="ai-actions">{(["likely_human", "likely_ai", "uncertain"] as AiReview[]).map((value) => <button className={record.humanAiReview === value ? "selected" : ""} onClick={() => updateRecord(record.id, { humanAiReview: value })} key={value}>{aiLabel[value]}</button>)}</div></article>)}</section><button className="secondary next-button" onClick={() => navigate(7)}>生成最终数据集 →</button></section>}

      {activeStage === 7 && <section className="stage-page"><header className="stage-heading"><div><span className="eyebrow">STEP 08 · OUTPUT</span><h1>Final Dataset 与复现包</h1><p>最终标签由规则、模型原始结果和各阶段人工判断共同形成，AI 风险信号不会自动删除数据。</p></div><div className="heading-actions"><button className="secondary" onClick={exportManifest}>复现 JSON</button><button className="primary" onClick={exportCsv}>下载 Dataset CSV</button></div></header><section className="final-metrics"><div><span>输入记录</span><strong>{records.length}</strong></div><div><span>OpenCLIP 候选</span><strong>{candidates.length}</strong></div><div><span>最终保留</span><strong>{finalRecords.filter((record) => record.final === "keep").length}</strong></div><div><span>待人工确认</span><strong>{finalRecords.filter((record) => record.final === "uncertain").length}</strong></div></section><section className="panel"><div className="panel-head"><h3>最终记录</h3><span>所有原始信号均保留</span></div><div className="final-table"><div className="table-head"><span>Record</span><span>GPT</span><span>人工纠正</span><span>残留清理</span><span>AI 复核</span><span>Final</span></div>{finalRecords.map((record) => <div key={record.id}><p><b>{record.id}</b><small>{record.fileName}</small></p><span>{record.gpt}</span><span>{record.humanGptDecision ?? "—"}</span><span>{record.residualDecision ?? "—"}</span><span>{record.humanAiReview ?? "—"}</span><em className={record.final}>{record.final}</em></div>)}</div></section></section>}

      {showConfig && <div className="modal-backdrop"><button className="modal-dismiss" aria-label="关闭运行配置" onClick={() => setShowConfig(false)} /><section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="config-title"><button className="modal-close" aria-label="关闭" onClick={() => setShowConfig(false)}>×</button><span className="eyebrow">RUN CONFIGURATION</span><h2 id="config-title">运行配置快照</h2><p>公开版状态仅保存在当前设备；真实密钥、批处理与论文数据不会进入浏览器。</p><dl><div><dt>OpenCLIP 候选线</dt><dd>p ≥ {threshold.toFixed(2)}</dd></div><div><dt>模型信号</dt><dd>可复现 Demo</dd></div><div><dt>人工阶段</dt><dd>纠正 + 残留 + AI 复核</dd></div><div><dt>保存范围</dt><dd>当前设备</dd></div></dl><button className="primary wide" onClick={exportManifest}>下载 JSON 复现配置</button></section></div>}
    </main>
  );
}
