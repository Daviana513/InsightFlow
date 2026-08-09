"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Decision = "keep" | "remove" | "uncertain";
type AiReview = "likely_human" | "likely_ai" | "uncertain";
type StageId = "preprocess" | "openclip" | "gpt" | "human" | "residual" | "c2pa" | "tencent" | "final";
type ViewId = "overview" | StageId;
type Visual = "map" | "poster" | "photo" | "checklist" | "timeline";
type RunState = "paused" | "running" | "complete";

type LocalProject = {
  id: string;
  name: string;
  images_dir: string;
  metadata_csv: string;
  image_count: number;
  record_count: number;
  missing_images: number;
  mapping: Record<string, string | null>;
  ready: boolean;
  warnings: string[];
};

type LocalRun = {
  id: string;
  status: "ready" | "running" | "paused" | "complete";
  stage: string;
  processed: number;
  total: number;
  threshold: number;
  candidate_count: number;
  message: string;
};

type OpenClipRuntime = {
  ready: boolean;
  model_version: string;
  metrics: { sample_counts?: { labeled_images?: number; positive_images?: number; negative_images?: number }; test_metrics_at_0_60?: { recall?: number; precision?: number } };
};

type OpenClipSummary = { scored: number; candidates: number; below_threshold: number; errors: number };
type TrainingLabel = "infographic" | "not_infographic" | "uncertain";
type TrainingCandidate = { record_id: string; image_path: string; caption: string; account_name: string; post_shortcode: string; image_index: string; label: TrainingLabel | null };
type TrainingPage = { items: TrainingCandidate[]; total: number; offset: number; limit: number; counts: Partial<Record<TrainingLabel, number>> };

type ReviewRecord = {
  id: string;
  title: string;
  fileName: string;
  account: string;
  language: string;
  type: string;
  visual: Visual;
  preprocess: "passed" | "excluded";
  clip: number;
  gpt: "keep" | "not_keep" | "uncertain";
  criteria: [number, number, number];
  humanGptDecision: Decision | null;
  residualDecision: Decision | null;
  c2pa: "valid_claim" | "no_claim" | "parse_error";
  tencentResult: "Pass" | "Review" | "Block";
  humanAiReview: AiReview | null;
  note: string;
};

const stages: { id: StageId; no: string; title: string; short: string; surface: "LOCAL" | "API" | "HUMAN" | "OUTPUT" }[] = [
  { id: "preprocess", no: "01", title: "数据源与预处理", short: "字段、范围、去重", surface: "LOCAL" },
  { id: "openclip", no: "02", title: "本地模型筛选", short: "OpenCLIP 高召回", surface: "LOCAL" },
  { id: "gpt", no: "03", title: "AI 单图审核", short: "结构化视觉判断", surface: "API" },
  { id: "human", no: "04", title: "人工纠正", short: "修正模型判断", surface: "HUMAN" },
  { id: "residual", no: "05", title: "残留清理", short: "poster / photograph", surface: "HUMAN" },
  { id: "c2pa", no: "06", title: "来源凭证", short: "C2PA 本地验证", surface: "LOCAL" },
  { id: "tencent", no: "07", title: "外部风险检测", short: "腾讯云辅助复核", surface: "API" },
  { id: "final", no: "08", title: "Final Dataset", short: "冻结、审计、导出", surface: "OUTPUT" },
];

const navGroups: { label: string; items: { id: ViewId; title: string }[] }[] = [
  { label: "PROJECT", items: [{ id: "overview", title: "任务总览" }, { id: "preprocess", title: "数据源与预处理" }] },
  { label: "SCREEN", items: [{ id: "openclip", title: "本地模型筛选" }, { id: "gpt", title: "AI 单图审核" }] },
  { label: "REVIEW", items: [{ id: "human", title: "人工纠正" }, { id: "residual", title: "残留清理" }] },
  { label: "VERIFY", items: [{ id: "c2pa", title: "来源凭证" }, { id: "tencent", title: "外部风险检测" }] },
  { label: "OUTPUT", items: [{ id: "final", title: "Final Dataset" }] },
];

const initialRecords: ReviewRecord[] = [
  { id: "EN-0041", title: "7-day China rail itinerary", fileName: "en_0041.jpg", account: "@travel_demo", language: "EN", type: "route_map", visual: "map", preprocess: "passed", clip: 0.86, gpt: "keep", criteria: [1, 1, 1], humanGptDecision: "keep", residualDecision: "keep", c2pa: "no_claim", tencentResult: "Pass", humanAiReview: "likely_human", note: "" },
  { id: "ES-0028", title: "Festival de primavera", fileName: "es_0028.jpg", account: "@culture_demo", language: "ES", type: "event_poster", visual: "poster", preprocess: "passed", clip: 0.62, gpt: "keep", criteria: [1, 1, 1], humanGptDecision: "keep", residualDecision: "remove", c2pa: "no_claim", tencentResult: "Pass", humanAiReview: "likely_human", note: "活动海报，不属于目标信息图。" },
  { id: "JA-0017", title: "上海旅行チェックリスト", fileName: "ja_0017.jpg", account: "@journey_demo", language: "JA", type: "checklist", visual: "checklist", preprocess: "passed", clip: 0.73, gpt: "uncertain", criteria: [1, 1, 0], humanGptDecision: null, residualDecision: null, c2pa: "no_claim", tencentResult: "Review", humanAiReview: null, note: "" },
  { id: "EN-0063", title: "Visit China this summer", fileName: "en_0063.jpg", account: "@fly_demo", language: "EN", type: "photograph", visual: "photo", preprocess: "passed", clip: 0.31, gpt: "keep", criteria: [1, 1, 1], humanGptDecision: "keep", residualDecision: "remove", c2pa: "valid_claim", tencentResult: "Pass", humanAiReview: "likely_human", note: "旅行照片，文字不足以构成信息图。" },
  { id: "ES-0054", title: "Semana cultural", fileName: "es_0054.jpg", account: "@event_demo", language: "ES", type: "poster", visual: "poster", preprocess: "passed", clip: 0.44, gpt: "keep", criteria: [1, 1, 1], humanGptDecision: "remove", residualDecision: null, c2pa: "no_claim", tencentResult: "Pass", humanAiReview: null, note: "" },
  { id: "JA-0082", title: "北京 3 日モデルコース", fileName: "ja_0082.jpg", account: "@route_demo", language: "JA", type: "timeline", visual: "timeline", preprocess: "passed", clip: 0.91, gpt: "keep", criteria: [1, 1, 1], humanGptDecision: "keep", residualDecision: "keep", c2pa: "parse_error", tencentResult: "Review", humanAiReview: "uncertain", note: "保留为信息图；来源证据不足。" },
];

const decisionLabel: Record<Decision, string> = { keep: "保留", remove: "排除", uncertain: "待定" };
const aiLabel: Record<AiReview, string> = { likely_human: "倾向真人", likely_ai: "倾向 AI", uncertain: "证据不足" };
const storageKey = "insightflow-workbench-preview-v3";
const publicSiteOrigin = "https://insightflow-research.wuyixuan003.chatgpt.site";
async function agentRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const host = window.location.hostname === "127.0.0.1" ? "127.0.0.1" : "localhost";
  const response = await fetch(`http://${host}:8765${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "Local Agent 请求失败");
  return result;
}

function agentImageUrl(path: string) {
  const host = window.location.hostname === "127.0.0.1" ? "127.0.0.1" : "localhost";
  return `http://${host}:8765/image?path=${encodeURIComponent(path)}`;
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

function SurfaceBadge({ value }: { value: "LOCAL" | "API" | "HUMAN" | "OUTPUT" }) {
  return <span className={`surface-badge ${value.toLowerCase()}`}>{value}</span>;
}

function MockImage({ record }: { record: ReviewRecord }) {
  return <div className={`mock-image ${record.visual}`} role="img" aria-label={`${record.title} 脱敏示意图`}><div className="mock-grid" /><div className="mock-route" /><div className="mock-copy"><small>TRAVEL FIELD NOTE</small><strong>{record.title}</strong><span>SAMPLE · SOURCE REDACTED</span></div></div>;
}

export default function Home() {
  const [activeView, setActiveView] = useState<ViewId>("overview");
  const [records, setRecords] = useState<ReviewRecord[]>(initialRecords);
  const [threshold, setThreshold] = useState(0.1);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [runState, setRunState] = useState<RunState>("paused");
  const [runProgress, setRunProgress] = useState(3241);
  const [showConfig, setShowConfig] = useState(false);
  const [showLocalHelp, setShowLocalHelp] = useState(false);
  const [showProjectSetup, setShowProjectSetup] = useState(false);
  const [isLocalMode, setIsLocalMode] = useState(false);
  const [agentConnected, setAgentConnected] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [localProject, setLocalProject] = useState<LocalProject | null>(null);
  const [localRun, setLocalRun] = useState<LocalRun | null>(null);
  const [imagesDir, setImagesDir] = useState("");
  const [metadataCsv, setMetadataCsv] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);
  const [preprocessBusy, setPreprocessBusy] = useState(false);
  const [openclipBusy, setOpenclipBusy] = useState(false);
  const [openclipRuntime, setOpenclipRuntime] = useState<OpenClipRuntime | null>(null);
  const [openclipSummary, setOpenclipSummary] = useState<OpenClipSummary>({ scored: 0, candidates: 0, below_threshold: 0, errors: 0 });
  const [openclipMode, setOpenclipMode] = useState<"screen" | "train">("screen");
  const [trainingPage, setTrainingPage] = useState<TrainingPage | null>(null);
  const [trainingBusy, setTrainingBusy] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [notice, setNotice] = useState("这是脱敏交互预览。真实研究数据由电脑上的 Local Agent 处理，不会上传到此站点。");

  /* eslint-disable react-hooks/set-state-in-effect -- hydrate browser storage and the local runtime */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const workspace = JSON.parse(saved);
        if (Array.isArray(workspace.records)) setRecords(workspace.records);
        if (typeof workspace.threshold === "number") setThreshold(workspace.threshold);
      }
    } catch {
      // Public preview falls back to bundled sample data.
    }
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("view") ?? params.get("stage");
    if (requested === "overview" || stages.some((stage) => stage.id === requested)) setActiveView(requested as ViewId);
    const onPopState = () => {
      const current = new URLSearchParams(window.location.search).get("view") ?? new URLSearchParams(window.location.search).get("stage");
      if (current === "overview" || stages.some((stage) => stage.id === current)) setActiveView(current as ViewId);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const local = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
    setIsLocalMode(local);
    if (!local && window.location.origin !== publicSiteOrigin) return;
    const ping = async () => {
      try {
        const result = await agentRequest<{ ok: boolean; project: LocalProject | null }>("/health");
        setAgentConnected(result.ok);
        setAgentError("");
        setNotice((current) => current.startsWith("这是脱敏交互预览") ? "Local Agent 已连接。现在可以打开真实图片目录与帖文 CSV。" : current);
        if (result.project) {
          setLocalProject(result.project);
          setImagesDir(result.project.images_dir);
          setMetadataCsv(result.project.metadata_csv);
          const current = await agentRequest<{ run: LocalRun | null }>("/runs/current");
          setLocalRun(current.run);
          const runtime = await agentRequest<OpenClipRuntime>("/models/openclip");
          setOpenclipRuntime(runtime);
          if (current.run && current.run.stage !== "preprocess") {
            const clip = await agentRequest<{ run: LocalRun; summary: OpenClipSummary }>(`/runs/${current.run.id}/openclip`);
            setLocalRun(clip.run);
            setOpenclipSummary(clip.summary);
          }
        }
      } catch (error) {
        setAgentConnected(false);
        setAgentError(error instanceof Error ? error.message : "无法连接 Local Agent");
      }
    };
    ping();
    const timer = window.setInterval(ping, 5000);
    return () => window.clearInterval(timer);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify({ records, threshold })); } catch { /* sample decisions can safely reset */ }
  }, [records, threshold]);

  useEffect(() => {
    if (runState !== "running") return;
    const timer = window.setInterval(() => {
      setRunProgress((current) => {
        if (current >= 5892) {
          setRunState("complete");
          return 5892;
        }
        return Math.min(5892, current + 7);
      });
    }, 900);
    return () => window.clearInterval(timer);
  }, [runState]);

  const navigate = useCallback((view: ViewId) => {
    setActiveView(view);
    setReviewIndex(0);
    window.history.pushState({}, "", view === "overview" ? "?view=overview" : `?stage=${view}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const candidates = useMemo(() => records.filter((record) => record.preprocess === "passed" && record.clip >= threshold), [records, threshold]);
  const humanQueue = candidates;
  const residualQueue = humanQueue.filter((record) => record.humanGptDecision === "keep");
  const finalRecords = useMemo(() => records.map((record) => ({ ...record, final: finalDecision(record, threshold) })), [records, threshold]);
  const updateRecord = useCallback((id: string, patch: Partial<ReviewRecord>) => {
    setRecords((current) => current.map((record) => record.id === id ? { ...record, ...patch } : record));
  }, []);

  const reviewerMode = activeView === "human" ? "humanGptDecision" : "residualDecision";
  const reviewQueue = activeView === "human" ? humanQueue : residualQueue;
  const reviewRecord = reviewQueue[reviewIndex] ?? reviewQueue[0];
  const reviewValue = reviewRecord ? reviewRecord[reviewerMode] : null;

  const decide = useCallback((decision: Decision) => {
    if (!reviewRecord) return;
    updateRecord(reviewRecord.id, { [reviewerMode]: decision });
    setReviewIndex((current) => Math.min(reviewQueue.length - 1, current + 1));
    setNotice(`已保存 ${reviewRecord.id} 的人工判断：${decisionLabel[decision]}。模型原始结果保持不变。`);
  }, [reviewQueue.length, reviewRecord, reviewerMode, updateRecord]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (!reviewRecord || !["human", "residual"].includes(activeView) || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target?.tagName)) return;
      if (event.key === "1") decide("keep");
      if (event.key === "2") decide("remove");
      if (event.key === "3") decide("uncertain");
      if (event.key === "ArrowLeft") setReviewIndex((value) => Math.max(0, value - 1));
      if (event.key === "ArrowRight") setReviewIndex((value) => Math.min(reviewQueue.length - 1, value + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeView, decide, reviewQueue.length, reviewRecord]);

  const toggleRun = () => {
    if (runState === "complete") {
      setRunProgress(3241);
      setRunState("running");
      setNotice("脱敏示例任务已重新开始。真实模式会把任务交给电脑上的 Local Agent。");
      return;
    }
    const next = runState === "running" ? "paused" : "running";
    setRunState(next);
    setNotice(next === "running" ? "示例任务继续运行。你可以离开总览页查看其他阶段。" : "示例任务已暂停，当前进度已保存。");
  };

  const openLocalProject = async () => {
    setSetupBusy(true);
    setSetupError("");
    try {
      const result = await agentRequest<{ project: LocalProject }>("/projects/open", {
        method: "POST",
        body: JSON.stringify({ images_dir: imagesDir, metadata_csv: metadataCsv }),
      });
      setLocalProject(result.project);
      setLocalRun(null);
      setNotice(`已读取本地项目：${result.project.record_count.toLocaleString()} 条记录、${result.project.image_count.toLocaleString()} 张图片。`);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "无法读取这个项目");
    } finally {
      setSetupBusy(false);
    }
  };

  const createLocalRun = async () => {
    setSetupBusy(true);
    setSetupError("");
    try {
      const result = await agentRequest<{ run: LocalRun }>("/runs", {
        method: "POST",
        body: JSON.stringify({ threshold }),
      });
      setLocalRun(result.run);
      setShowProjectSetup(false);
      setNotice(`真实任务 ${result.run.id} 已创建，配置和进度会保存在项目目录中。`);
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "无法创建任务");
    } finally {
      setSetupBusy(false);
    }
  };

  const runPreprocess = async () => {
    if (!localRun) return setShowProjectSetup(true);
    setPreprocessBusy(true);
    try {
      const result = await agentRequest<{ run: LocalRun; summary: { total?: number; passed?: number; image_missing?: number } }>(`/runs/${localRun.id}/preprocess`, {
        method: "POST",
        body: "{}",
      });
      setLocalRun(result.run);
      setNotice(`预处理完成：${result.summary.passed ?? result.run.processed} 条通过，${result.summary.image_missing ?? 0} 条缺图。下一步是配置 OpenCLIP。`);
      navigate("openclip");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "预处理失败");
    } finally {
      setPreprocessBusy(false);
    }
  };

  const runOpenClip = async () => {
    if (!localRun) return;
    setOpenclipBusy(true);
    try {
      const result = await agentRequest<{ run: LocalRun; summary: OpenClipSummary }>(`/runs/${localRun.id}/openclip`, {
        method: "POST", body: "{}",
      });
      setLocalRun(result.run);
      setOpenclipSummary(result.summary);
      setNotice("OpenCLIP 已开始运行。首次使用会先准备模型文件，页面会自动刷新进度。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法启动 OpenCLIP");
    } finally {
      setOpenclipBusy(false);
    }
  };

  const loadTrainingCandidates = async (offset = 0) => {
    if (!localRun) return;
    setTrainingBusy(true);
    try {
      setTrainingPage(await agentRequest<TrainingPage>(`/training/candidates?run_id=${encodeURIComponent(localRun.id)}&offset=${offset}&limit=12`));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法读取训练候选图片");
    } finally {
      setTrainingBusy(false);
    }
  };

  const setTrainingLabel = async (candidate: TrainingCandidate, label: TrainingLabel) => {
    try {
      await agentRequest("/training/labels", { method: "POST", body: JSON.stringify({ record_id: candidate.record_id, label }) });
      await loadTrainingCandidates(trainingPage?.offset ?? 0);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "训练标签保存失败");
    }
  };

  const switchOpenClipMode = (mode: "screen" | "train") => {
    setOpenclipMode(mode);
    if (mode === "train" && !trainingPage) void loadTrainingCandidates();
  };

  const exportCsv = () => {
    const headers = ["record_id", "file_name", "clip_probability", "gpt_decision", "human_correction", "residual_cleanup", "c2pa_status", "external_risk", "human_ai_review", "final_decision", "note"];
    const rows = finalRecords.map((record) => [record.id, record.fileName, record.clip, record.gpt, record.humanGptDecision, record.residualDecision, record.c2pa, record.tencentResult, record.humanAiReview, record.final, record.note].map(csvCell).join(","));
    download("insightflow_sample_decisions.csv", `\ufeff${[headers.join(","), ...rows].join("\n")}`, "text/csv;charset=utf-8");
    setNotice("示例决定文件已下载。真实模式会用相同格式在本地生成最终图片集合。");
  };

  const exportManifest = () => download("insightflow_run_manifest.json", JSON.stringify({
    product: "InsightFlow", mode: "public_preview", workflowVersion: "local-first-v0.3", exportedAt: new Date().toISOString(),
    threshold, model: "OpenCLIP ViT-B/32 + Logistic Regression", connectors: ["OpenAI vision adapter", "C2PA local", "Tencent Cloud adapter"], stages, records: finalRecords,
  }, null, 2), "application/json");

  const liveMode = agentConnected;
  const openSetup = () => liveMode ? setShowProjectSetup(true) : setShowLocalHelp(true);
  const preprocessComplete = Boolean(localRun && localRun.stage !== "preprocess");
  const openclipComplete = Boolean(localRun && !["preprocess", "openclip"].includes(localRun.stage));
  const activeThreshold = liveMode && localRun ? localRun.threshold : threshold;
  const localPrimaryLabel = !localProject ? "打开真实项目" : !localRun ? "创建真实任务" : !preprocessComplete ? preprocessBusy ? "正在预处理…" : "开始预处理" : "进入 OpenCLIP";
  const localPrimaryAction = () => !localProject || !localRun ? setShowProjectSetup(true) : !preprocessComplete ? runPreprocess() : navigate("openclip");

  const renderOverview = () => {
    const total = liveMode ? localRun?.total ?? localProject?.record_count ?? 0 : 5892;
    const processed = liveMode ? localRun?.processed ?? 0 : runProgress;
    const percentage = total ? Math.round((processed / total) * 100) : 0;
    const visibleRunState = liveMode ? localRun?.status === "running" ? "running" : localRun?.status === "complete" ? "complete" : "paused" : runState;
    const runRows = liveMode ? [
      ["01", "前期预处理", "LOCAL", localRun ? `${processed.toLocaleString()} / ${total.toLocaleString()}` : "等待创建任务", visibleRunState],
      ["02", "OpenCLIP 高召回", "LOCAL", openclipComplete ? `${localRun?.candidate_count ?? 0} 条候选` : localRun?.stage === "openclip" && localRun.status === "running" ? `${localRun.processed} / ${localRun.total}` : "等待开始", openclipComplete ? "complete" : localRun?.status === "running" ? "running" : "waiting"],
      ["03", "GPT 单图审核", "API", openclipComplete ? "等待 API 配置" : "等待前序阶段", "waiting"],
      ["04", "人工纠正", "HUMAN", "等待真实候选集", "waiting"],
      ["05", "残留与来源检查", "MIXED", "等待前序阶段", "waiting"],
    ] : [
      ["01", "前期预处理", "LOCAL", "42,680 / 42,680", "complete"], ["02", "OpenCLIP 高召回", "LOCAL", "42,534 / 42,534", "complete"], ["03", "GPT 单图审核", "API", `${runProgress.toLocaleString()} / 5,892`, runState], ["04", "人工纠正", "HUMAN", "1,080 / 3,241", "attention"], ["05", "残留与来源检查", "MIXED", "等待前序阶段", "waiting"],
    ];
    return <section className="workspace-page overview-page">
      <div className="overview-hero">
        <div><span className="eyebrow light">LOCAL-FIRST IMAGE SCREENING</span><h1>把一次大规模筛选，<br />变成可恢复的任务。</h1><p>InsightFlow 连接电脑上的图片、模型与第三方 API，让你从一个界面启动流程、追踪异常并完成人工判断。</p><div className="hero-actions"><button className="primary large" disabled={preprocessBusy} onClick={liveMode ? localPrimaryAction : toggleRun}>{liveMode ? localPrimaryLabel : runState === "running" ? "暂停示例任务" : runState === "complete" ? "重新运行示例" : "继续示例任务"}</button><button className="dark-secondary" onClick={() => navigate(liveMode ? "preprocess" : "human")}>{liveMode ? "查看启动步骤 →" : "进入人工待审队列 →"}</button></div></div>
        <div className="agent-card"><div className="agent-card-head"><span className="agent-icon">LA</span><div><small>LOCAL AGENT</small><strong>{liveMode ? localProject ? `已连接 · ${localProject.name}` : "已连接 · 等待打开项目" : isLocalMode ? "本地界面已打开 · 运行器未连接" : "研究运行器未连接"}</strong></div><span className={`status-dot ${liveMode ? "online" : "offline"}`} /></div><p>{liveMode ? "当前页面只连接本机运行器。目录校验、任务状态与审核记录都会保存在你的电脑中。" : isLocalMode ? `页面会每 5 秒重试连接。${agentError ? `错误：${agentError}` : "请确认 Local Agent 仍在运行。"}` : "公开站点只展示脱敏运行镜像。启动本地版后，图片始终留在电脑，界面将显示真实设备、目录和任务状态。"}</p><button onClick={openSetup}>{liveMode ? localProject ? "查看本地项目" : "打开本地项目" : "查看本地研究模式"}</button></div>
      </div>

      <div className="metric-strip"><article><span>原始记录</span><strong>{liveMode ? (localProject?.record_count ?? 0).toLocaleString() : "42,680"}</strong><small>本地索引</small></article><article><span>OpenCLIP 候选</span><strong>{liveMode ? (localRun?.candidate_count ?? 0).toLocaleString() : "5,892"}</strong><small>p ≥ {activeThreshold.toFixed(2)}</small></article><article><span>当前阶段</span><strong>{percentage}%</strong><small>{liveMode ? localRun?.stage ?? "项目设置" : "AI 单图审核"}</small></article><article className="attention"><span>需要人工处理</span><strong>{liveMode ? "—" : "426"}</strong><small>{liveMode ? openclipComplete ? "等待 GPT 审核" : "等待真实候选集" : "不确定与冲突项"}</small></article></div>

      <div className="overview-grid">
        <section className="run-console panel"><div className="panel-heading"><div><span className="eyebrow">{liveMode ? "ACTIVE RUN · LOCAL" : "ACTIVE RUN · DEMO MIRROR"}</span><h2>{localProject?.name ?? "China Travel Infographics"}</h2></div><span className={`run-state ${visibleRunState}`}>{visibleRunState === "running" ? "运行中" : visibleRunState === "complete" ? "已完成" : "已暂停"}</span></div>
          <div className="active-progress"><div><span>{liveMode ? "前期预处理" : "GPT-5.5 单图审核"}</span><b>{processed.toLocaleString()} / {total.toLocaleString()}</b></div><i><span style={{ width: `${percentage}%` }} /></i><small>{liveMode ? "当前已保存真实任务状态 · 数据处理器将在下一阶段接入" : "示例运行速度 7 items/s · 真实速度由设备与 API 限额决定"}</small></div>
          <div className="run-list">
            {runRows.map(([no, name, surface, progress, state]) => <button onClick={() => no === "01" ? navigate("preprocess") : no === "02" ? navigate("openclip") : no === "03" ? navigate("gpt") : no === "04" ? navigate("human") : navigate("residual")} key={no}><span>{no}</span><div><b>{name}</b><small>{surface}</small></div><em>{progress}</em><i className={`mini-state ${state}`} /></button>)}
          </div>
        </section>

        <aside className="right-stack">
          <section className="panel issue-card"><div className="panel-heading"><div><span className="eyebrow">NEEDS ATTENTION</span><h2>异常与待处理</h2></div><b>28</b></div><button><span>图片无法读取</span><em>17</em></button><button><span>API 请求超时</span><em>8</em></button><button><span>响应无法解析</span><em>3</em></button><p>失败不会被记作负面判断，可单独重试。</p></section>
          <section className="panel quick-review"><span className="eyebrow">HUMAN QUEUE</span><h2>下一张待审图片</h2><div className="quick-image"><MockImage record={humanQueue.find((record) => !record.humanGptDecision) ?? humanQueue[0]} /></div><div><b>{humanQueue.find((record) => !record.humanGptDecision)?.id ?? humanQueue[0].id}</b><span>模型判断：uncertain</span></div><button className="secondary wide" onClick={() => navigate("human")}>开始逐张审核</button></section>
        </aside>
      </div>
    </section>;
  };

  const renderPreprocess = () => <section className="workspace-page"><PageHeading surface="LOCAL" eyebrow="STEP 01 · DATA SOURCE" title="数据源与前期预处理" description="按顺序完成下面三步。预处理结束后，系统会直接带你进入 OpenCLIP 阶段。" action={<button className="secondary" onClick={openSetup}>{liveMode ? localProject ? "更换数据源" : "打开本地项目" : "连接 Local Agent"}</button>} />
    {liveMode && <section className="launch-flow" aria-label="开始真实筛选"><article className={localProject ? "done" : "current"}><span>1</span><div><b>打开数据源</b><small>{localProject ? `${localProject.record_count.toLocaleString()} 条记录已通过字段检查` : "选择图片文件夹与帖文 CSV"}</small></div><em>{localProject ? "已完成" : "当前步骤"}</em></article><article className={localRun ? "done" : localProject ? "current" : "locked"}><span>2</span><div><b>创建本次任务</b><small>{localRun ? localRun.id : "冻结阈值与字段映射，保存可恢复进度"}</small></div><em>{localRun ? "已完成" : localProject ? "下一步" : "等待"}</em></article><article className={preprocessComplete ? "done" : localRun ? "current" : "locked"}><span>3</span><div><b>运行前期预处理</b><small>{preprocessComplete ? `${localRun?.processed.toLocaleString()} 条记录已建立稳定索引` : "验证每条记录、图片路径与唯一 ID"}</small></div><em>{preprocessComplete ? "已完成" : localRun ? "可以开始" : "等待"}</em></article><button className="primary" disabled={preprocessBusy} onClick={localPrimaryAction}>{localPrimaryLabel} →</button></section>}
    <div className="local-banner"><span className="agent-icon">LA</span><div><b>{liveMode ? localProject ? "本地项目已通过基础校验" : "Local Agent 已连接，请打开项目" : "研究数据应由本地后端读取"}</b><p>{liveMode ? localProject ? `${localProject.metadata_csv} · 数据不会上传` : "填写图片目录和 CSV 路径后，运行器会先检查字段与缺图。" : "公开预览仅展示字段与规则。连接后可选择项目目录、扫描图片、映射字段并运行现有脚本。"}</p></div><span className={`connection-pill ${liveMode ? "connected" : ""}`}>{liveMode ? "已连接" : "未连接"}</span></div>
    <div className="three-grid"><article className="source-card panel"><span className="eyebrow">IMAGE SOURCE</span><h3>本地图片目录</h3><strong>{(localProject?.image_count ?? 42534).toLocaleString()}</strong><p>{localProject ? localProject.images_dir : "images / en · es · ja"}</p><small>原图不进入在线站点</small></article><article className="source-card panel"><span className="eyebrow">METADATA</span><h3>帖文主表</h3><strong>{(localProject?.record_count ?? 42680).toLocaleString()}</strong><p>{localProject ? localProject.metadata_csv : "source_master.csv"}</p><small>{localProject ? `${localProject.missing_images} 条缺图` : "29 个字段 · 146 条缺图"}</small></article><article className="source-card panel"><span className="eyebrow">TASK STATE</span><h3>真实任务</h3><strong>{localRun ? localRun.status.toUpperCase() : "—"}</strong><p>{localRun?.id ?? "尚未创建"}</p><small>SQLite 自动保存</small></article></div>
    <div className="two-grid"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">FIELD MAPPING</span><h2>字段映射预检</h2></div><span className="check-label">{localProject ? localProject.ready ? "必要字段已匹配" : "需要补充字段" : "DEMO MAPPING"}</span></div><div className="mapping-list">{[["稳定记录 ID", "record_id"], ["图片路径", "image_path"], ["帖文正文", "caption"], ["语言", "language"], ["账号信息", "account"]].map(([label, key]) => { const field = localProject?.mapping[key]; return <div key={key}><b>{label}</b><code>{field ?? key}</code><span>{localProject ? field ? "已匹配" : "未找到" : "示例"}</span></div>; })}</div>{localProject?.warnings.map((warning) => <p className="field-warning" key={warning}>{warning}</p>)}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">PREPROCESS RULES</span><h2>本次运行规则</h2></div><button className="text-button" onClick={() => setShowConfig(true)}>查看快照</button></div><div className="rule-list">{[["研究范围与时间", "仅保留目标国家、年份与语言"], ["帖文相关性", "根据 caption、tags 与来源字段筛选"], ["图片与轮播去重", "按哈希和 canonical record 合并"], ["缺失数据隔离", "不把读取失败当作规则排除"]].map(([title, desc]) => <div key={title}><span>✓</span><p><b>{title}</b><small>{desc}</small></p></div>)}</div><button className="primary wide" disabled={preprocessBusy} onClick={liveMode ? localPrimaryAction : () => navigate("openclip")}>{liveMode ? localPrimaryLabel : "查看本地模型阶段"} →</button></section></div>
  </section>;

  const renderOpenClip = () => {
    if (liveMode) return <section className="workspace-page"><PageHeading surface="LOCAL" eyebrow="STEP 02 · HIGH RECALL" title="本地模型与训练集" description="先选择使用已有模型筛选本次数据，或为下一版模型标注训练图片。两套数据互不混淆。" action={<button className="secondary" onClick={() => navigate("preprocess")}>← 返回预处理</button>} />
      <div className="model-mode-tabs" role="tablist" aria-label="OpenCLIP 工作模式"><button className={openclipMode === "screen" ? "active" : ""} onClick={() => switchOpenClipMode("screen")}>筛选本次数据</button><button className={openclipMode === "train" ? "active" : ""} onClick={() => switchOpenClipMode("train")}>选择训练图片</button></div>
      {openclipMode === "screen" ? <>
        <div className={`stage-gate ${preprocessComplete ? "ready" : "waiting"}`}><span>{preprocessComplete ? "✓" : "1"}</span><div><b>{preprocessComplete ? "前期预处理已完成" : "请先完成前期预处理"}</b><p>{preprocessComplete ? `${localRun?.total.toLocaleString()} 条记录可以进入 OpenCLIP。` : "返回上一步，点击“开始预处理”。"}</p></div>{!preprocessComplete && <button className="primary" onClick={() => navigate("preprocess")}>返回预处理</button>}</div>
        <section className="model-stack"><div><span className="eyebrow light">ACTIVE MODEL</span><h2>ViT-B/32 <i>→</i> EN Infographic v3</h2><p>{openclipRuntime?.ready ? `运行环境已就绪 · ${openclipRuntime.model_version} · 606 张平衡训练样本` : "正在检查本地运行环境"}</p></div><div><span>本次冻结阈值</span><strong>p ≥ {activeThreshold.toFixed(2)}</strong><small>创建任务后不可修改</small></div></section>
        <div className="metric-strip compact"><article><span>模型输入</span><strong>{(localRun?.total ?? 0).toLocaleString()}</strong><small>预处理通过</small></article><article><span>已计算</span><strong>{openclipSummary.scored.toLocaleString()}</strong><small>{localRun?.status === "running" ? "正在运行" : "已保存概率"}</small></article><article><span>候选集</span><strong>{openclipSummary.candidates.toLocaleString()}</strong><small>p ≥ {activeThreshold.toFixed(2)}</small></article><article><span>读取失败</span><strong>{openclipSummary.errors.toLocaleString()}</strong><small>不会记为负样本</small></article></div>
        <section className="next-action-panel panel"><span className="eyebrow">REAL LOCAL RUN</span><h2>{openclipComplete ? "OpenCLIP 筛选已完成" : localRun?.status === "running" ? "正在计算每张图片的概率" : "使用已有 EN v3 模型开始筛选"}</h2><p>{localRun?.message || `模型测试集召回率 ${Math.round((openclipRuntime?.metrics.test_metrics_at_0_60?.recall ?? 0.9) * 100)}%。本次使用 p ≥ ${activeThreshold.toFixed(2)} 的高召回策略，低分图片仅归档，不会被删除。`}</p>
          {localRun?.status === "running" && <div className="clip-progress"><i><span style={{ width: `${localRun.total ? (localRun.processed / localRun.total) * 100 : 0}%` }} /></i><small>{localRun.processed.toLocaleString()} / {localRun.total.toLocaleString()}</small></div>}
          {openclipComplete ? <button className="primary" onClick={() => navigate("gpt")}>下一步：配置 AI 单图审核 →</button> : <button className="primary" disabled={!preprocessComplete || !openclipRuntime?.ready || openclipBusy || localRun?.status === "running"} onClick={runOpenClip}>{localRun?.status === "running" ? "OpenCLIP 运行中…" : openclipBusy ? "正在启动…" : "开始 OpenCLIP 筛选"}</button>}
        </section>
      </> : <>
        <section className="training-intro panel"><div><span className="eyebrow">OPTIONAL MODEL LAB</span><h2>为下一版分类器选择训练图片</h2><p>这里的标注不会改变本次筛选结果。建议优先选择模型边界样本和历史误判，并保持“信息图 / 非信息图”数量接近。</p></div><div className="training-counts"><span><b>{trainingPage?.counts.infographic ?? 0}</b> 信息图</span><span><b>{trainingPage?.counts.not_infographic ?? 0}</b> 非信息图</span><span><b>{trainingPage?.counts.uncertain ?? 0}</b> 不确定</span></div></section>
        {!preprocessComplete ? <div className="stage-gate waiting"><span>1</span><div><b>请先完成预处理</b><p>训练候选也需要稳定记录 ID 和有效图片路径。</p></div><button className="primary" onClick={() => navigate("preprocess")}>返回预处理</button></div> : <section className="panel"><div className="panel-heading"><div><span className="eyebrow">TRAINING CANDIDATE POOL</span><h2>逐张选择训练标签</h2></div><span className="sample-pill">{trainingPage?.total ?? localRun?.total ?? 0} 张可选</span></div>
          {trainingBusy && !trainingPage ? <p className="training-loading">正在读取本地图片…</p> : <div className="training-grid">{trainingPage?.items.map((candidate) => <article className="training-card" key={candidate.record_id}><div className="training-thumb" role="img" aria-label={candidate.record_id} style={{ backgroundImage: `url("${agentImageUrl(candidate.image_path)}")` }} /><div><b>{candidate.record_id}</b><small>@{candidate.account_name || "unknown"} · {candidate.post_shortcode} #{candidate.image_index}</small><p>{candidate.caption || "无帖文正文"}</p></div><div className="training-actions"><button className={candidate.label === "infographic" ? "selected keep" : ""} onClick={() => setTrainingLabel(candidate, "infographic")}>信息图</button><button className={candidate.label === "not_infographic" ? "selected remove" : ""} onClick={() => setTrainingLabel(candidate, "not_infographic")}>非信息图</button><button className={candidate.label === "uncertain" ? "selected uncertain" : ""} onClick={() => setTrainingLabel(candidate, "uncertain")}>不确定</button></div></article>)}</div>}
          <div className="training-pager"><button className="secondary" disabled={!trainingPage?.offset || trainingBusy} onClick={() => loadTrainingCandidates(Math.max(0, (trainingPage?.offset ?? 0) - 12))}>← 上一页</button><span>{trainingPage ? `${trainingPage.offset + 1}–${Math.min(trainingPage.offset + trainingPage.limit, trainingPage.total)} / ${trainingPage.total}` : "等待载入"}</span><button className="secondary" disabled={trainingBusy || !trainingPage || trainingPage.offset + trainingPage.limit >= trainingPage.total} onClick={() => loadTrainingCandidates((trainingPage?.offset ?? 0) + 12)}>下一页 →</button></div>
        </section>}
      </>}
    </section>;
    return <section className="workspace-page"><PageHeading surface="LOCAL" eyebrow="STEP 02 · HIGH RECALL" title="本地模型高召回筛选" description="OpenCLIP 与自训练分类器运行在电脑后端。阈值只控制候选集，不代表最终信息图判断。" action={<button className="primary" onClick={toggleRun}>{runState === "running" ? "暂停示例" : "运行示例"}</button>} />
      <section className="model-stack"><div><span className="eyebrow light">MODEL STACK</span><h2>ViT-B/32 <i>→</i> StandardScaler <i>→</i> Logistic Regression</h2><p>laion2b_s34b_b79k · infographic classifier v3 · 本地 MPS</p></div><div><span>候选阈值</span><strong>p ≥ {threshold.toFixed(2)}</strong><input aria-label="候选阈值" type="range" min="0.05" max="0.9" step="0.05" value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} /></div></section>
      <div className="metric-strip compact"><article><span>模型输入</span><strong>42,534</strong><small>预处理通过</small></article><article><span>候选集</span><strong>5,892</strong><small>进入 AI 审核</small></article><article><span>低于阈值</span><strong>36,642</strong><small>保留审计记录</small></article><article><span>读取失败</span><strong>17</strong><small>单独重试</small></article></div>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">INTERACTIVE SAMPLE</span><h2>候选分数预览</h2></div><span className="sample-pill">6 条脱敏样例</span></div><div className="score-list">{records.map((record) => <div key={record.id}><p><b>{record.id}</b><small>{record.title}</small></p><div><i style={{ width: `${record.clip * 100}%` }} /></div><em>{record.clip.toFixed(2)}</em><span className={record.clip >= threshold ? "pass" : "fail"}>{record.clip >= threshold ? "进入" : "排除"}</span></div>)}</div></section>
    </section>;
  };

  const renderGpt = () => {
    if (liveMode) return <section className="workspace-page"><PageHeading surface="API" eyebrow="STEP 03 · AI REVIEW" title="AI 单图审核" description="OpenCLIP 候选集将在本地后端逐张调用视觉模型；密钥与原图不会进入公开站点。" action={<button className="secondary" onClick={() => navigate("openclip")}>← 返回 OpenCLIP</button>} /><div className={`stage-gate ${openclipComplete ? "ready" : "waiting"}`}><span>{openclipComplete ? "✓" : "2"}</span><div><b>{openclipComplete ? `${localRun?.candidate_count ?? 0} 张候选已准备好` : "请先完成 OpenCLIP 筛选"}</b><p>{openclipComplete ? "下一步需要配置视觉模型 API、审核 Prompt、并发与费用上限。" : "这里不会显示或使用公开演示数据。"}</p></div>{!openclipComplete && <button className="primary" onClick={() => navigate("openclip")}>返回 OpenCLIP</button>}</div><section className="next-action-panel panel"><span className="eyebrow">NEXT CONNECTOR</span><h2>真实 GPT 审核尚未接入</h2><p>OpenCLIP 的真实概率已经保存；在 API 连接完成前，系统会锁定人工纠正队列，避免把示例判断混入论文数据。</p><button className="primary" disabled>配置本地 API 后解锁</button></section></section>;
    return <section className="workspace-page"><PageHeading surface="API" eyebrow="STEP 03 · AI REVIEW" title="AI 单图审核" description="本地后端将候选图片按结构化 Prompt 调用视觉模型，管理密钥、并发、费用、超时与重试。" action={<button className="primary" onClick={() => navigate("human")}>进入人工纠正 →</button>} />
    <div className="connector-banner"><div><span className="connector-mark">AI</span><p><b>OpenAI Vision Adapter</b><small>GPT-5.5 snapshot · Prompt infographic_review_v1</small></p></div><span className="connector-state">公开版：已保存结果</span></div>
    <div className="metric-strip compact"><article><span>候选输入</span><strong>5,892</strong><small>仅 p ≥ 0.10</small></article><article><span>已完成</span><strong>{runProgress.toLocaleString()}</strong><small>结构化响应</small></article><article><span>等待中</span><strong>{(5892 - runProgress).toLocaleString()}</strong><small>可暂停和恢复</small></article><article><span>失败待重试</span><strong>11</strong><small>不生成伪判断</small></article></div>
    <section className="panel table-panel"><div className="panel-heading"><div><span className="eyebrow">SAVED SAMPLE RESULTS</span><h2>单图审核结果</h2></div><span className="sample-pill">原始结果不可覆盖</span></div><div className="result-table"><div className="table-head"><span>Record</span><span>CLIP</span><span>语言</span><span>China</span><span>信息图</span><span>AI 判断</span></div>{candidates.map((record) => <div key={record.id}><p><b>{record.id}</b><small>{record.title}</small></p><span>{record.clip.toFixed(2)}</span>{record.criteria.map((value, index) => <span className={value ? "yes" : "no"} key={index}>{value ? "yes" : "no"}</span>)}<em>{record.gpt}</em></div>)}</div></section>
    </section>;
  };

  const renderReview = () => reviewRecord ? <section className="review-workspace">
    <aside className="review-sidebar"><div className="review-side-head"><SurfaceBadge value="HUMAN" /><span>{reviewQueue.filter((record) => record[reviewerMode]).length}/{reviewQueue.length}</span></div><h2>{activeView === "human" ? "纠正 AI 判断" : "清理非信息图残留"}</h2><p>{activeView === "human" ? "核对语言、主题和信息图结构；人工判断单独保存。" : "集中清除 poster、photograph 等模型残留。"}</p><div className="queue-list">{reviewQueue.map((record, index) => <button className={index === reviewIndex ? "selected" : ""} onClick={() => setReviewIndex(index)} key={record.id}><span>{record.id}<small>{record.title}</small></span><em>{record[reviewerMode] ? decisionLabel[record[reviewerMode] as Decision] : "待审"}</em></button>)}</div><button className="secondary wide" onClick={() => navigate(activeView === "human" ? "residual" : "c2pa")}>进入下一阶段 →</button></aside>
    <section className="review-center"><div className="record-meta"><div><b>{reviewRecord.id}</b><span>{reviewRecord.language}</span><span>{reviewRecord.type}</span></div><small>{reviewIndex + 1} / {reviewQueue.length}</small></div><MockImage record={reviewRecord} /><div className="record-title"><div><strong>{reviewRecord.title}</strong><span>{reviewRecord.account} · 脱敏示例</span></div><b className={`decision-pill ${reviewValue ?? ""}`}>{reviewValue ? `人工：${decisionLabel[reviewValue]}` : "等待人工判断"}</b></div><textarea aria-label="人工审核备注" value={reviewRecord.note} onChange={(event) => updateRecord(reviewRecord.id, { note: event.target.value })} placeholder="记录判断依据（自动保存）" /><div className="decision-actions"><button className="keep" onClick={() => decide("keep")}><kbd>1</kbd> {activeView === "human" ? "人工保留" : "确认信息图"}</button><button className="remove" onClick={() => decide("remove")}><kbd>2</kbd> {activeView === "human" ? "人工排除" : "清除残留"}</button><button className="uncertain" onClick={() => decide("uncertain")}><kbd>3</kbd> 暂时待定</button></div><div className="pagination"><button disabled={reviewIndex === 0} onClick={() => setReviewIndex((value) => value - 1)}>← 上一张</button><span>模型原始结果始终保留</span><button disabled={reviewIndex === reviewQueue.length - 1} onClick={() => setReviewIndex((value) => value + 1)}>下一张 →</button></div></section>
    <aside className="evidence-panel"><span className="eyebrow">EVIDENCE TRACE</span><h2>单图证据链</h2><div className="trace-list"><Trace no="01" title="前期预处理" detail="规则与范围" result={reviewRecord.preprocess} /><Trace no="02" title="OpenCLIP" detail={`候选线 p ≥ ${threshold.toFixed(2)}`} result={`p ${reviewRecord.clip.toFixed(2)}`} /><Trace no="03" title="AI 单图审核" detail="模型原始结果" result={reviewRecord.gpt} /><Trace no="04" title="人工纠正" detail="独立字段" result={reviewRecord.humanGptDecision ?? "pending"} /><Trace no="05" title="残留清理" detail="独立字段" result={reviewRecord.residualDecision ?? "pending"} /><Trace no="06" title="C2PA" detail="来源凭证" result={reviewRecord.c2pa} /><Trace no="07" title="外部风险" detail="不自动删除" result={reviewRecord.tencentResult} /></div><p className="principle">C2PA 与第三方风险检测只提供证据，不自动改变信息图标签。</p></aside>
  </section> : <section className="empty-state"><span>当前队列为空</span><h2>请先完成上一阶段</h2><p>只有符合前序条件的图片才会进入本队列。</p><button className="primary" onClick={() => navigate("human")}>返回人工纠正</button></section>;

  const renderC2pa = () => <section className="workspace-page"><PageHeading surface="LOCAL" eyebrow="STEP 06 · PROVENANCE" title="C2PA 来源凭证检查" description="直接读取电脑上的原始文件，区分有效凭证、无凭证与解析失败；无凭证不等于真人制作。" action={<button className="primary" onClick={() => navigate("tencent")}>继续外部检测 →</button>} /><div className="principle-banner"><b>来源信号，不是分类器</b><span>C2PA 在本地运行，不发送图片；结果不会覆盖人工信息图判断。</span></div><section className="card-grid">{records.map((record) => <article className="provenance-card" key={record.id}><div><b>{record.id}</b><span>{record.title}</span></div><strong className={record.c2pa}>{record.c2pa}</strong><dl><div><dt>执行位置</dt><dd>LOCAL</dd></div><div><dt>最终动作</dt><dd>保存证据</dd></div></dl></article>)}</section></section>;

  const renderTencent = () => <section className="workspace-page"><PageHeading surface="API" eyebrow="STEP 07 · EXTERNAL SIGNAL" title="第三方 AI 图片风险检测" description="通过可替换 Connector 调用腾讯云等服务，只处理残留清理后的保留项，并由人工确认风险含义。" action={<button className="primary" onClick={() => navigate("final")}>查看最终结果 →</button>} /><div className="connector-banner"><div><span className="connector-mark tencent">TC</span><p><b>Tencent Cloud Adapter</b><small>密钥仅保存在 Local Agent · Biztype 由项目配置</small></p></div><span className="connector-state">SAMPLE RESPONSE</span></div><section className="ai-review-list">{records.filter((record) => record.residualDecision === "keep").map((record) => <article key={record.id}><span className={`risk-label ${record.tencentResult.toLowerCase()}`}>{record.tencentResult}</span><div><b>{record.id}</b><span>{record.title}</span></div><div className="ai-actions">{(["likely_human", "likely_ai", "uncertain"] as AiReview[]).map((value) => <button className={record.humanAiReview === value ? "selected" : ""} onClick={() => updateRecord(record.id, { humanAiReview: value })} key={value}>{aiLabel[value]}</button>)}</div></article>)}</section></section>;

  const renderFinal = () => <section className="workspace-page"><PageHeading surface="OUTPUT" eyebrow="STEP 08 · FREEZE & EXPORT" title="Final Dataset 与复现包" description="冻结本次运行版本，在电脑上从原始目录生成最终图片集合，并保留全部排除原因和证据。" action={<div className="heading-actions"><button className="secondary" onClick={exportManifest}>运行清单 JSON</button><button className="primary" onClick={exportCsv}>下载示例决定</button></div>} /><div className="final-funnel"><article><span>原始记录</span><strong>42,680</strong><small>100%</small></article><i /><article><span>预处理后</span><strong>38,240</strong><small>89.6%</small></article><i /><article><span>模型候选</span><strong>5,892</strong><small>13.8%</small></article><i /><article><span>最终保留</span><strong>1,790</strong><small>4.2%</small></article></div><div className="two-grid"><section className="panel export-panel"><span className="eyebrow">LOCAL OUTPUT</span><h2>在电脑生成最终集合</h2><p>Local Agent 根据 record_id 与 SHA-256 从原始目录复制保留图片，避免网页压缩或重命名改变研究文件。</p><div className="file-tree"><span>final_dataset/</span><span>├── images/</span><span>├── final_master.csv</span><span>├── excluded_records.csv</span><span>├── audit_trail.jsonl</span><span>└── run_manifest.json</span></div><button className="primary wide" onClick={() => setShowLocalHelp(true)}>了解本地生成方式</button></section><section className="panel table-panel"><div className="panel-heading"><div><span className="eyebrow">INTERACTIVE SAMPLE</span><h2>最终决定预览</h2></div><span className="sample-pill">{finalRecords.filter((record) => record.final === "keep").length} keep · {finalRecords.filter((record) => record.final === "uncertain").length} pending</span></div><div className="final-list">{finalRecords.map((record) => <div key={record.id}><p><b>{record.id}</b><small>{record.fileName}</small></p><span>{record.humanGptDecision ?? "—"}</span><span>{record.residualDecision ?? "—"}</span><em className={record.final}>{record.final}</em></div>)}</div></section></div></section>;

  const renderContent = () => {
    if (activeView === "overview") return renderOverview();
    if (activeView === "preprocess") return renderPreprocess();
    if (activeView === "openclip") return renderOpenClip();
    if (activeView === "gpt") return renderGpt();
    if (activeView === "human" || activeView === "residual") return renderReview();
    if (activeView === "c2pa") return renderC2pa();
    if (activeView === "tencent") return renderTencent();
    return renderFinal();
  };

  return <main className="app-shell">
    <aside className="app-sidebar"><div className="brand"><span className="brand-mark">IF</span><div><strong>InsightFlow</strong><small>LOCAL-FIRST SCREENING</small></div></div><div className="mode-card"><span className={`status-dot ${liveMode ? "online" : isLocalMode ? "offline" : "preview"}`} /><div><b>{liveMode || isLocalMode ? "Local Research" : "Public Preview"}</b><small>{liveMode ? "真实本地工作区" : isLocalMode ? "正在连接运行器" : "脱敏交互演示"}</small></div></div><nav aria-label="InsightFlow 主导航">{navGroups.map((group) => <div className="nav-group" key={group.label}><span>{group.label}</span>{group.items.map((item) => <button className={activeView === item.id ? "active" : ""} onClick={() => navigate(item.id)} key={item.id}><i />{item.title}{item.id === "human" && <em>426</em>}</button>)}</div>)}</nav><div className="sidebar-agent"><div><span className={`status-dot ${liveMode ? "online" : "offline"}`} /><b>Local Agent</b></div><small>{liveMode ? localProject ? localProject.name : "已连接，等待项目" : isLocalMode ? "连接失败，自动重试中" : "研究运行器未连接"}</small><button onClick={openSetup}>{liveMode ? "打开项目 →" : "如何连接 →"}</button></div></aside>
    <section className="app-main"><header className="app-topbar"><div className="breadcrumb"><span>项目</span><b>{localProject?.name ?? "China Travel Infographics"}</b><em>{localRun ? `${localRun.id} · ${localRun.stage}` : "Run 08 · Demo mirror"}</em></div><div className="top-actions"><button className="icon-button" aria-label="查看运行配置" onClick={() => setShowConfig(true)}>⌘</button><button className="secondary" onClick={() => navigate("overview")}>任务总览</button><button className="primary" disabled={preprocessBusy} onClick={liveMode ? localPrimaryAction : toggleRun}>{liveMode ? localPrimaryLabel : runState === "running" ? "暂停任务" : "继续任务"}</button></div></header><div className="notice-bar"><span>{notice}</span><button onClick={() => setNotice(liveMode ? "本地研究模式已就绪。" : "脱敏交互预览已就绪。")}>知道了</button></div>{renderContent()}</section>

    {showConfig && <Modal title="运行配置快照" eyebrow="RUN CONFIGURATION" onClose={() => setShowConfig(false)}><p>真实运行开始后，规则、模型、Prompt 与阈值会冻结为版本；修改配置将创建新的 Run。</p><dl className="config-list"><div><dt>执行模式</dt><dd>Local-first</dd></div><div><dt>候选阈值</dt><dd>p ≥ {threshold.toFixed(2)}</dd></div><div><dt>本地模型</dt><dd>OpenCLIP + LR v3</dd></div><div><dt>人工阶段</dt><dd>纠正 + 残留 + 风险复核</dd></div><div><dt>保存策略</dt><dd>SQLite + 原始文件哈希</dd></div></dl><button className="primary wide" onClick={exportManifest}>下载示例运行清单</button></Modal>}
    {showLocalHelp && <Modal title="连接电脑上的 Local Agent" eyebrow="COMPUTER BACKEND" onClose={() => setShowLocalHelp(false)}><p>在项目目录运行 <code>npm run agent</code>（或 <code>npm run local</code>）并保持窗口开启，然后刷新当前 InsightFlow 网页。正式站点会自动连接本机运行器，图片仍不会上传。</p><ol className="local-steps"><li><span>01</span><p><b>启动 Local Agent</b><small>它只监听你的电脑，并只信任 InsightFlow 正式站点和本机页面。</small></p></li><li><span>02</span><p><b>刷新当前网页</b><small>连接成功后会自动出现“打开本地项目”。</small></p></li><li><span>03</span><p><b>填写图片目录与 CSV</b><small>任务、模型结果和人工标签全部保存在电脑中。</small></p></li></ol><button className="primary wide" onClick={() => setShowLocalHelp(false)}>返回并刷新</button></Modal>}
    {showProjectSetup && <Modal title="打开本地研究项目" eyebrow="LOCAL PROJECT" onClose={() => setShowProjectSetup(false)}><p>填写电脑上的完整路径。运行器只索引图片和 CSV，不会把文件上传到公开网站。</p><div className="setup-form"><label><span>图片文件夹</span><input value={imagesDir} onChange={(event) => setImagesDir(event.target.value)} placeholder="/Users/你的名字/project/images" /></label><label><span>帖文主表 CSV</span><input value={metadataCsv} onChange={(event) => setMetadataCsv(event.target.value)} placeholder="/Users/你的名字/project/source_master.csv" /></label>{setupError && <p className="setup-error">{setupError}</p>}<button className="secondary wide" disabled={setupBusy || !imagesDir || !metadataCsv} onClick={openLocalProject}>{setupBusy ? "正在检查…" : localProject ? "重新检查项目" : "检查并打开项目"}</button>{localProject && <div className={`setup-result ${localProject.ready ? "ready" : "warning"}`}><b>{localProject.ready ? "基础字段已通过" : "还不能创建任务"}</b><span>{localProject.record_count.toLocaleString()} 条记录 · {localProject.image_count.toLocaleString()} 张图片 · {localProject.missing_images} 条缺图</span></div>}<button className="primary wide" disabled={setupBusy || !localProject?.ready} onClick={createLocalRun}>{localRun ? "创建一个新任务" : "创建真实任务"}</button></div></Modal>}
  </main>;
}

function PageHeading({ surface, eyebrow, title, description, action }: { surface: "LOCAL" | "API" | "HUMAN" | "OUTPUT"; eyebrow: string; title: string; description: string; action: React.ReactNode }) {
  return <header className="page-heading"><div><div className="heading-meta"><SurfaceBadge value={surface} /><span className="eyebrow">{eyebrow}</span></div><h1>{title}</h1><p>{description}</p></div><div>{action}</div></header>;
}

function Trace({ no, title, detail, result }: { no: string; title: string; detail: string; result: string }) {
  return <div><span>{no}</span><p><b>{title}</b><small>{detail}</small></p><em>{result}</em></div>;
}

function Modal({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop"><button className="modal-dismiss" aria-label="关闭" onClick={onClose} /><section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button className="modal-close" aria-label="关闭" onClick={onClose}>×</button><span className="eyebrow">{eyebrow}</span><h2 id="modal-title">{title}</h2>{children}</section></div>;
}
