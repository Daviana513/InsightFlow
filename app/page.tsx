"use client";
/* eslint-disable @next/next/no-img-element -- Local Agent image URLs cannot use hosted image optimization. */

import { useCallback, useEffect, useMemo, useState } from "react";

type TemplateId = "ai_keyword" | "duplicate" | "gpt_correction" | "residual" | "risk" | "custom";
type View = "dashboard" | "create" | "review";
type Project = { id: string; name: string; images_dir: string; metadata_csv: string; image_count: number; record_count: number; missing_images: number; headers: string[]; mapping: Record<string, string | null>; ready: boolean; warnings: string[] };
type Task = { id: string; name: string; template: TemplateId; layout: "single" | "compare"; status: "in_progress" | "complete"; total: number; reviewed: number; labels: string[]; caption_field: string; updated_at: string };
type ReviewItem = { item_id: string; group_id: string; rows: Record<string, string>[]; image_paths: string[]; decision: string; reason: string; note: string; canonical_record_id: string; reviewed_at?: string };
type ReviewPage = { task: Task; item: ReviewItem | null; offset: number; filtered_total: number };

const publicOrigin = "https://insightflow-research.wuyixuan003.chatgpt.site";
const templates: Record<TemplateId, { title: string; short: string; description: string; layout: "single" | "compare"; labels: Record<string, string> }> = {
  ai_keyword: { title: "AI 关键词疑似项", short: "前期验证", description: "结合图片、帖文与命中字段，判断关键词是否真的构成 AI 生成证据。", layout: "single", labels: { explicit_ai: "明确 AI 声明", suspected_ai: "疑似 AI 生成", no_evidence: "没有生成证据", unrelated_keyword: "关键词无关", uncertain: "无法判断" } },
  duplicate: { title: "重复图片候选", short: "对比审核", description: "并排检查完全重复、缩放、裁剪或加字版本，并指定主记录。", layout: "compare", labels: { exact_duplicate: "完全相同", resized_duplicate: "同图不同尺寸", edited_duplicate: "裁剪或加字", similar_not_duplicate: "相似但不重复", unrelated: "不相关", uncertain: "无法判断" } },
  gpt_correction: { title: "模型判断纠错", short: "结果审核", description: "保留机器原始判断，追加人工纠正、原因与备注。", layout: "single", labels: { keep: "保留", remove: "排除", uncertain: "待定" } },
  residual: { title: "非信息图残留清理", short: "结果审核", description: "细分海报、照片、广告及其他非目标图片。", layout: "single", labels: { infographic: "确认信息图", poster: "海报", photograph: "照片", advertisement: "广告", other: "其他非信息图", uncertain: "待定" } },
  risk: { title: "来源与 AI 风险复核", short: "证据复核", description: "审核外部风险信号，不覆盖图片是否属于信息图的结论。", layout: "single", labels: { likely_human: "倾向真人", likely_ai: "倾向 AI", insufficient: "证据不足", not_applicable: "不适用" } },
  custom: { title: "自定义单图打标", short: "通用审核", description: "为新的前期规则或模型输出创建简单的是、否、待定审核队列。", layout: "single", labels: { yes: "是", no: "否", uncertain: "待定" } },
};

const demoTasks: Task[] = [
  { id: "demo_ai", name: "AI 关键词候选人工验证", template: "ai_keyword", layout: "single", status: "in_progress", total: 86, reviewed: 51, labels: Object.keys(templates.ai_keyword.labels), caption_field: "caption", updated_at: "2026-08-13" },
  { id: "demo_dup", name: "感知哈希重复组复核", template: "duplicate", layout: "compare", status: "in_progress", total: 42, reviewed: 18, labels: Object.keys(templates.duplicate.labels), caption_field: "caption", updated_at: "2026-08-12" },
  { id: "demo_gpt", name: "GPT 信息图判断纠错", template: "gpt_correction", layout: "single", status: "complete", total: 203, reviewed: 203, labels: Object.keys(templates.gpt_correction.labels), caption_field: "caption", updated_at: "2026-08-10" },
];

const demoItem: ReviewItem = { item_id: "DH3Zt1UoP41#1", group_id: "", image_paths: [], decision: "", reason: "", note: "", canonical_record_id: "", rows: [{ record_id: "DH3Zt1UoP41#1", account_name: "travel_research_demo", caption: "A visual guide to planning your China itinerary. Created with AI-assisted tools and edited by our design team.", ai_keyword_hits: "AI-assisted", infographic_reason: "caption_keyword_match", post_url: "https://example.com/post", publish_year: "2025" }] };

async function agent<T>(path: string, init?: RequestInit): Promise<T> {
  const host = window.location.hostname === "localhost" ? "localhost" : "127.0.0.1";
  const response = await fetch(`http://${host}:8765${path}`, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "Local Agent 请求失败");
  return result;
}

function imageUrl(path: string) {
  const host = window.location.hostname === "localhost" ? "localhost" : "127.0.0.1";
  return `http://${host}:8765/image?path=${encodeURIComponent(path)}`;
}

function percentage(task: Task) { return task.total ? Math.round(task.reviewed / task.total * 100) : 0; }

export default function Home() {
  const [view, setView] = useState<View>("dashboard");
  const [connected, setConnected] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>(demoTasks);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [reviewPage, setReviewPage] = useState<ReviewPage | null>(null);
  const [filter, setFilter] = useState("unreviewed");
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState("公开页面提供交互预览；启动电脑上的 Local Agent 后即可审核真实图片和 CSV。");
  const [busy, setBusy] = useState(false);
  const [imagesDir, setImagesDir] = useState("");
  const [csvPath, setCsvPath] = useState("");
  const [taskName, setTaskName] = useState("");
  const [template, setTemplate] = useState<TemplateId>("ai_keyword");
  const [idField, setIdField] = useState("");
  const [imageField, setImageField] = useState("");
  const [captionField, setCaptionField] = useState("");
  const [groupField, setGroupField] = useState("");
  const [note, setNote] = useState("");
  const [showHelp, setShowHelp] = useState(false);

  const refreshTasks = useCallback(async () => {
    const result = await agent<{ tasks: Task[] }>("/review-tasks");
    setTasks(result.tasks);
  }, []);

  useEffect(() => {
    if (![publicOrigin, "http://localhost:3000"].includes(window.location.origin) && window.location.hostname !== "127.0.0.1") return;
    const ping = async () => {
      try {
        const health = await agent<{ ok: boolean; project: Project | null }>("/health");
        setConnected(health.ok);
        if (health.project) {
          setProject(health.project);
          setImagesDir(health.project.images_dir);
          setCsvPath(health.project.metadata_csv);
          const result = await agent<{ tasks: Task[] }>("/review-tasks");
          setTasks(result.tasks);
        }
      } catch { setConnected(false); }
    };
    void ping();
    const timer = window.setInterval(ping, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const loadItem = useCallback(async (task: Task, nextOffset = 0, nextFilter = filter) => {
    if (!connected || task.id.startsWith("demo_")) {
      setReviewPage({ task, item: demoItem, offset: 0, filtered_total: 1 });
      return;
    }
    const page = await agent<ReviewPage>(`/review-items?task_id=${encodeURIComponent(task.id)}&offset=${nextOffset}&filter=${nextFilter}`);
    setReviewPage(page);
    setOffset(page.offset);
    setNote(page.item?.note || "");
  }, [connected, filter]);

  const openTask = async (task: Task) => {
    setActiveTask(task);
    setFilter("unreviewed");
    setOffset(0);
    setView("review");
    await loadItem(task, 0, "unreviewed");
  };

  const inspectData = async () => {
    setBusy(true);
    try {
      const result = await agent<{ project: Project }>("/projects/open", { method: "POST", body: JSON.stringify({ images_dir: imagesDir, metadata_csv: csvPath }) });
      setProject(result.project);
      setIdField(result.project.mapping.record_id || "");
      setImageField(result.project.mapping.image_path || "");
      setCaptionField(result.project.mapping.caption || "");
      setNotice(`数据检查完成：${result.project.record_count} 条记录，${result.project.missing_images} 条缺图。`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法检查数据"); }
    finally { setBusy(false); }
  };

  const createTask = async () => {
    if (!project) return;
    setBusy(true);
    try {
      const result = await agent<{ task: Task }>("/review-tasks", { method: "POST", body: JSON.stringify({ name: taskName || templates[template].title, template, id_field: idField, image_field: imageField, caption_field: captionField, group_field: groupField }) });
      await refreshTasks();
      setNotice(`审核任务“${result.task.name}”已创建，进度会自动保存在电脑中。`);
      await openTask(result.task);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法创建审核任务"); }
    finally { setBusy(false); }
  };

  const saveDecision = useCallback(async (decision: string) => {
    if (!activeTask || !reviewPage?.item) return;
    if (!connected || activeTask.id.startsWith("demo_")) {
      setReviewPage({ ...reviewPage, item: { ...reviewPage.item, decision, note } });
      setNotice("演示标签已更新；连接 Local Agent 后才会写入真实项目。");
      return;
    }
    setBusy(true);
    try {
      const canonical = reviewPage.item.canonical_record_id || reviewPage.item.rows[0]?.__insightflow_record_id || "";
      await agent("/review-items", { method: "PATCH", body: JSON.stringify({ task_id: activeTask.id, item_id: reviewPage.item.item_id, decision, note, canonical_record_id: canonical }) });
      await refreshTasks();
      await loadItem(activeTask, filter === "unreviewed" ? offset : offset + 1, filter);
      setNotice("人工标签已自动保存。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  }, [activeTask, connected, filter, loadItem, note, offset, refreshTasks, reviewPage]);

  useEffect(() => {
    if (view !== "review") return;
    const key = (event: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes((event.target as HTMLElement)?.tagName)) return;
      const labels = activeTask ? Object.keys(templates[activeTask.template].labels) : [];
      const number = Number(event.key);
      if (number > 0 && labels[number - 1]) void saveDecision(labels[number - 1]);
      if (event.key === "ArrowLeft" && activeTask) void loadItem(activeTask, Math.max(0, offset - 1));
      if (event.key === "ArrowRight" && activeTask) void loadItem(activeTask, offset + 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [activeTask, loadItem, offset, saveDecision, view]);

  const exportTask = async (task: Task) => {
    if (!connected || task.id.startsWith("demo_")) return setNotice("连接 Local Agent 后可导出真实审核 CSV。");
    const host = window.location.hostname === "localhost" ? "localhost" : "127.0.0.1";
    const response = await fetch(`http://${host}:8765/review-export?task_id=${encodeURIComponent(task.id)}`);
    if (!response.ok) return setNotice("导出失败，请检查 Local Agent。");
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url; link.download = `${task.name}_reviewed.csv`; link.click(); URL.revokeObjectURL(url);
    setNotice("审核 CSV 已导出：原始列保持不变，人工字段追加在末尾。");
  };

  const totals = useMemo(() => ({ all: tasks.reduce((sum, task) => sum + task.total, 0), reviewed: tasks.reduce((sum, task) => sum + task.reviewed, 0), active: tasks.filter((task) => task.status === "in_progress").length }), [tasks]);
  const item = reviewPage?.item;
  const currentTemplate = activeTask ? templates[activeTask.template] : null;
  const primaryRow = item?.rows[0] || {};
  const contextFields = Object.entries(primaryRow).filter(([key, value]) => value && !key.startsWith("__") && key !== activeTask?.caption_field && !key.includes("image_path")).slice(0, 10);

  return <div className="if-shell">
    <aside className="if-sidebar">
      <button className="if-brand" onClick={() => setView("dashboard")}><span>IF</span><div><b>InsightFlow</b><small>HUMAN REVIEW AGENT</small></div></button>
      <div className={`agent-state ${connected ? "online" : "preview"}`}><i /><div><b>{connected ? "Local Agent 已连接" : "公开交互预览"}</b><small>{connected ? project?.name || "等待选择数据" : "不读取本地文件"}</small></div></div>
      <nav><span>WORKSPACE</span><button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>任务总览</button><button className={view === "create" ? "active" : ""} onClick={() => setView("create")}>新建审核任务</button>{activeTask && <button className={view === "review" ? "active" : ""} onClick={() => setView("review")}>继续当前审核</button>}</nav>
      <div className="scope-note"><b>Agent 只负责人审</b><p>外部脚本负责发现疑似项；这里负责看图、核对上下文、打标和导出。</p></div>
      <button className="help-link" onClick={() => setShowHelp(true)}>{connected ? "本地数据保持在电脑中" : "如何连接电脑数据？"}</button>
    </aside>

    <main className="if-main">
      <header><div><span>{view === "dashboard" ? "REVIEW WORKSPACE" : view === "create" ? "NEW REVIEW TASK" : currentTemplate?.short}</span><b>{activeTask && view === "review" ? activeTask.name : project?.name || "Image Research Workspace"}</b></div><div className="header-actions"><button className="ghost" onClick={() => setView("dashboard")}>任务总览</button><button className="accent" onClick={() => setView("create")}>＋ 新建审核任务</button></div></header>
      <div className="if-notice"><span>{notice}</span><button onClick={() => setNotice(connected ? "本地审核工作区已就绪。" : "公开交互预览已就绪。")}>×</button></div>

      {view === "dashboard" && <section className="if-page dashboard">
        <div className="dashboard-hero"><div><span className="kicker">LOCAL-FIRST · HUMAN-IN-THE-LOOP</span><h1>把每一次人工判断，<br />变成可恢复的研究证据。</h1><p>导入外部规则、模型或 API 生成的候选 CSV，在统一界面中核对图片与帖文、完成多阶段打标，并导出不覆盖原始字段的审核结果。</p><div><button className="accent large" onClick={() => setView("create")}>新建审核任务</button>{tasks[0] && <button className="dark" onClick={() => void openTask(tasks.find((task) => task.status === "in_progress") || tasks[0])}>继续上次审核 →</button>}</div></div><div className="hero-flow"><span>外部候选 CSV</span><i>→</i><strong>人工审核 Agent</strong><i>→</i><span>已打标 CSV</span><small>图片始终留在电脑 · 判断自动保存 · 原始结果不覆盖</small></div></div>
        <div className="metrics"><article><span>审核任务</span><b>{tasks.length}</b><small>{totals.active} 个进行中</small></article><article><span>候选记录</span><b>{totals.all}</b><small>单图或重复组</small></article><article><span>已完成人审</span><b>{totals.reviewed}</b><small>{totals.all ? Math.round(totals.reviewed / totals.all * 100) : 0}% 总进度</small></article><article><span>数据位置</span><b className="text-metric">{connected ? "LOCAL" : "DEMO"}</b><small>{connected ? "SQLite 自动保存" : "公开脱敏样例"}</small></article></div>
        <div className="section-heading"><div><span className="kicker">REVIEW TASKS</span><h2>审核任务</h2></div><button className="ghost" onClick={() => setView("create")}>创建新任务</button></div>
        <div className="task-grid">{tasks.length ? tasks.map((task) => <article className="task-card" key={task.id}><div className="task-top"><span>{templates[task.template].short}</span><em className={task.status}>{task.status === "complete" ? "已完成" : "进行中"}</em></div><h3>{task.name}</h3><p>{templates[task.template].description}</p><div className="progress"><div><span>审核进度</span><b>{task.reviewed} / {task.total}</b></div><i><span style={{ width: `${percentage(task)}%` }} /></i></div><div className="task-actions"><button className="accent" onClick={() => void openTask(task)}>{task.status === "complete" ? "查看审核" : "继续审核"}</button><button className="ghost" onClick={() => void exportTask(task)}>导出 CSV</button></div></article>) : <div className="empty-card"><h3>还没有审核任务</h3><p>选择本地图片目录和候选 CSV，创建第一项人工审核。</p><button className="accent" onClick={() => setView("create")}>新建任务</button></div>}</div>
      </section>}

      {view === "create" && <section className="if-page create-page">
        <div className="page-title"><span className="kicker">NEW REVIEW TASK</span><h1>创建人工审核队列</h1><p>外部脚本负责筛出疑似项；InsightFlow 读取候选 CSV 与本地图片，并保存你的人工判断。</p></div>
        {!connected && <div className="connect-warning"><div><b>当前是公开预览，无法读取电脑路径</b><p>启动 Local Agent 并刷新后，即可创建真实任务。你仍可查看下面的任务配置方式。</p></div><button className="ghost" onClick={() => setShowHelp(true)}>查看连接方式</button></div>}
        <div className="create-grid"><section className="form-panel"><div className="step-title"><span>01</span><div><b>选择候选数据</b><small>图片不上传，只由电脑上的运行器建立索引</small></div></div><label><span>图片文件夹</span><input value={imagesDir} onChange={(event) => setImagesDir(event.target.value)} placeholder="/Users/你的名字/project/images" /></label><label><span>待审核 CSV</span><input value={csvPath} onChange={(event) => setCsvPath(event.target.value)} placeholder="/Users/你的名字/project/ai_keyword_candidates.csv" /></label><button className="ghost wide" disabled={!connected || busy || !imagesDir || !csvPath} onClick={() => void inspectData()}>{busy ? "正在检查…" : "检查图片与 CSV"}</button>{project && <div className={`data-check ${project.ready ? "ok" : "warn"}`}><b>{project.ready ? "数据已通过基础检查" : "需要修正字段"}</b><span>{project.record_count} 条记录 · {project.image_count} 张图片 · {project.missing_images} 条缺图</span></div>}</section>
          <section className="form-panel"><div className="step-title"><span>02</span><div><b>选择审核模板</b><small>模板只决定布局、标签和上下文字段</small></div></div><div className="template-grid">{(Object.keys(templates) as TemplateId[]).map((key) => <button className={template === key ? "selected" : ""} onClick={() => setTemplate(key)} key={key}><b>{templates[key].title}</b><small>{templates[key].description}</small></button>)}</div></section>
        </div>
        <section className="form-panel mapping-panel"><div className="step-title"><span>03</span><div><b>确认字段并创建任务</b><small>系统保留 CSV 全部原始列，只追加人工审核字段</small></div></div><div className="field-grid"><label><span>任务名称</span><input value={taskName} onChange={(event) => setTaskName(event.target.value)} placeholder={templates[template].title} /></label><label><span>唯一 ID 字段</span><select value={idField} onChange={(event) => setIdField(event.target.value)}>{idField && !project?.headers.includes(idField) && <option value={idField}>{idField}（组合 ID）</option>}{project?.headers.map((field) => <option key={field}>{field}</option>)}</select></label><label><span>图片路径字段</span><select value={imageField} onChange={(event) => setImageField(event.target.value)}>{project?.headers.map((field) => <option key={field}>{field}</option>)}</select></label><label><span>帖文内容字段</span><select value={captionField} onChange={(event) => setCaptionField(event.target.value)}><option value="">不显示</option>{project?.headers.map((field) => <option key={field}>{field}</option>)}</select></label>{template === "duplicate" && <label><span>重复组 ID 字段</span><select value={groupField} onChange={(event) => setGroupField(event.target.value)}><option value="">请选择</option>{project?.headers.map((field) => <option key={field}>{field}</option>)}</select></label>}</div><button className="accent create-submit" disabled={!connected || !project?.ready || busy || (template === "duplicate" && !groupField)} onClick={() => void createTask()}>{busy ? "正在创建…" : "创建任务并开始审核 →"}</button></section>
      </section>}

      {view === "review" && activeTask && currentTemplate && <section className="review-layout">
        <aside className="review-rail"><span className="kicker">QUEUE</span><h2>{activeTask.name}</h2><p>{currentTemplate.description}</p><div className="progress large-progress"><div><span>总进度</span><b>{activeTask.reviewed} / {activeTask.total}</b></div><i><span style={{ width: `${percentage(activeTask)}%` }} /></i></div><div className="filter-list">{[["all", "全部"], ["unreviewed", "未审核"], ["reviewed", "已审核"], ["uncertain", "待定"]].map(([value, label]) => <button className={filter === value ? "active" : ""} key={value} onClick={() => { setFilter(value); setOffset(0); void loadItem(activeTask, 0, value); }}><span>{label}</span>{value === "all" && <em>{activeTask.total}</em>}{value === "unreviewed" && <em>{activeTask.total - activeTask.reviewed}</em>}{value === "reviewed" && <em>{activeTask.reviewed}</em>}</button>)}</div><div className="rail-actions"><button className="ghost wide" onClick={() => void exportTask(activeTask)}>导出当前 CSV</button><button className="text" onClick={() => setView("dashboard")}>← 返回任务总览</button></div></aside>
        {item ? <><section className="review-canvas"><div className="review-meta"><div><b>{item.group_id || item.item_id}</b><span>{currentTemplate.layout === "compare" ? `${item.rows.length} 张候选图` : currentTemplate.short}</span></div><small>{reviewPage.offset + 1} / {reviewPage.filtered_total}</small></div><div className={currentTemplate.layout === "compare" ? "compare-images" : "single-image"}>{currentTemplate.layout === "compare" ? item.image_paths.map((path, index) => <article key={`${path}-${index}`}><div className="real-image">{path ? <img src={imageUrl(path)} alt={`重复候选 ${index + 1}`} /> : <span>图片缺失</span>}</div><label><input type="radio" name="canonical" checked={item.canonical_record_id === item.rows[index]?.__insightflow_record_id} onChange={() => setReviewPage({ ...reviewPage, item: { ...item, canonical_record_id: item.rows[index]?.__insightflow_record_id || "" } })} /> 设为主记录</label><small>{item.rows[index]?.__insightflow_record_id}</small></article>) : <div className="real-image">{item.image_paths[0] ? <img src={imageUrl(item.image_paths[0])} alt={item.item_id} /> : <div className="demo-visual"><span>LOCAL IMAGE PREVIEW</span><b>{primaryRow.record_id || item.item_id}</b><small>连接 Local Agent 后显示真实图片</small></div>}</div>}</div>{activeTask.caption_field && primaryRow[activeTask.caption_field] && <div className="caption-card"><span>帖文内容 · {activeTask.caption_field}</span><p>{primaryRow[activeTask.caption_field]}</p></div>}<label className="note-field"><span>人工备注（可选）</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录判断依据、边界情况或需要讨论的问题…" /></label><div className="decision-grid">{Object.entries(currentTemplate.labels).map(([value, label], index) => <button className={item.decision === value ? "selected" : ""} disabled={busy} onClick={() => void saveDecision(value)} key={value}><kbd>{index + 1}</kbd>{label}</button>)}</div><div className="review-nav"><button disabled={offset === 0} onClick={() => void loadItem(activeTask, Math.max(0, offset - 1))}>← 上一项</button><span>数字键快速打标 · 判断自动保存</span><button disabled={offset + 1 >= reviewPage.filtered_total} onClick={() => void loadItem(activeTask, offset + 1)}>下一项 →</button></div></section>
          <aside className="context-panel"><span className="kicker">SOURCE CONTEXT</span><h2>图片与帖子信息</h2><p>原始字段只读；人工判断会作为新列写入导出文件。</p><dl>{contextFields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd className={key.toLowerCase().includes("keyword") ? "highlight" : ""}>{value}</dd></div>)}</dl>{item.decision && <div className="saved-decision"><span>当前人工标签</span><b>{currentTemplate.labels[item.decision] || item.decision}</b><small>{item.reviewed_at || "演示状态"}</small></div>}</aside></> : <section className="review-empty"><span>✓</span><h2>当前筛选条件下没有待审记录</h2><p>你可以切换到“全部”查看历史判断，或者导出当前审核进度。</p><button className="accent" onClick={() => void exportTask(activeTask)}>导出审核 CSV</button></section>}
      </section>}
    </main>

    {showHelp && <div className="modal"><button aria-label="关闭" onClick={() => setShowHelp(false)} /><section><button className="close" onClick={() => setShowHelp(false)}>×</button><span className="kicker">LOCAL AGENT</span><h2>连接电脑上的图片与 CSV</h2><p>在 InsightFlow 项目目录启动 Local Agent 并保持窗口开启，然后刷新正式网页。网页只显示图片和字段，原始文件与审核数据库都留在电脑中。</p><ol><li><b>1</b><span>运行 <code>npm run agent</code></span></li><li><b>2</b><span>刷新当前网页，确认左侧显示“Local Agent 已连接”</span></li><li><b>3</b><span>点击“新建审核任务”，填写图片目录与候选 CSV 路径</span></li></ol><button className="accent wide" onClick={() => setShowHelp(false)}>知道了</button></section></div>}
  </div>;
}
