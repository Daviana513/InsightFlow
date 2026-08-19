"use client";
/* eslint-disable @next/next/no-img-element -- Images are local browser object URLs. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CandidateRow, guessField, parseCandidateData, toCsv } from "./local-review";

type TemplateId = "ai_keyword" | "duplicate" | "gpt_correction" | "residual" | "risk" | "custom";
type View = "dashboard" | "create" | "review";
type Filter = "all" | "unreviewed" | "reviewed" | "uncertain";
type ReviewItem = { item_id: string; group_id: string; rows: CandidateRow[]; image_paths: string[]; decision: string; note: string; canonical_record_id: string; reviewed_at: string };
type Task = {
  id: string; name: string; template: TemplateId; layout: "single" | "compare"; status: "in_progress" | "complete";
  total: number; reviewed: number; labels: string[]; folder_name: string; source_name: string; headers: string[];
  id_field: string; image_field: string; caption_field: string; group_field: string; updated_at: string; items: ReviewItem[];
};
type SourceData = { folderName: string; dataName: string; rows: CandidateRow[]; headers: string[]; imageCount: number };

const templates: Record<TemplateId, { title: string; short: string; description: string; layout: "single" | "compare"; labels: Record<string, string> }> = {
  ai_keyword: { title: "AI 关键词疑似项", short: "前期验证", description: "结合图片、帖文与命中字段，判断关键词是否真的构成 AI 生成证据。", layout: "single", labels: { explicit_ai: "明确 AI 声明", suspected_ai: "疑似 AI 生成", no_evidence: "没有生成证据", unrelated_keyword: "关键词无关", uncertain: "无法判断" } },
  duplicate: { title: "重复图片候选", short: "对比审核", description: "并排检查完全重复、缩放、裁剪或加字版本，并指定主记录。", layout: "compare", labels: { exact_duplicate: "完全相同", resized_duplicate: "同图不同尺寸", edited_duplicate: "裁剪或加字", similar_not_duplicate: "相似但不重复", unrelated: "不相关", uncertain: "无法判断" } },
  gpt_correction: { title: "模型判断纠错", short: "结果审核", description: "保留机器原始判断，追加人工纠正、原因与备注。", layout: "single", labels: { keep: "保留", remove: "排除", uncertain: "待定" } },
  residual: { title: "非信息图残留清理", short: "结果审核", description: "细分海报、照片、广告及其他非目标图片。", layout: "single", labels: { infographic: "确认信息图", poster: "海报", photograph: "照片", advertisement: "广告", other: "其他非信息图", uncertain: "待定" } },
  risk: { title: "来源与 AI 风险复核", short: "证据复核", description: "审核外部风险信号，不覆盖图片是否属于信息图的结论。", layout: "single", labels: { likely_human: "倾向真人", likely_ai: "倾向 AI", insufficient: "证据不足", not_applicable: "不适用" } },
  custom: { title: "通用图片筛选", short: "通用审核", description: "逐张查看图片，判断保留、排除或待定。", layout: "single", labels: { keep: "保留", remove: "排除", uncertain: "待定" } },
};

const DB_NAME = "insightflow";
const STORE_NAME = "tasks";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readTasks(): Promise<Task[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result as Task[]).sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
    request.onerror = () => reject(request.error);
  });
}

async function writeTask(task: Task): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(task);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function percentage(task: Task) { return task.total ? Math.round(task.reviewed / task.total * 100) : 0; }
function filteredItems(task: Task, filter: Filter) {
  if (filter === "unreviewed") return task.items.filter((item) => !item.decision);
  if (filter === "reviewed") return task.items.filter((item) => item.decision);
  if (filter === "uncertain") return task.items.filter((item) => ["uncertain", "insufficient"].includes(item.decision));
  return task.items;
}
function imageKey(path: string) { return path.replaceAll("\\", "/").split("/").pop() || path; }
function isImageFile(file: File) { return /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(file.name); }
function localPath(file: File) {
  const relative = file.webkitRelativePath.replaceAll("\\", "/");
  return relative.split("/").slice(1).join("/") || file.name;
}

function LocalImage({ file, alt }: { file?: File; alt: string }) {
  const [url] = useState(() => file ? URL.createObjectURL(file) : "");
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url ? <img src={url} alt={alt} /> : <span>未找到本地图片，请重新选择来源文件夹</span>;
}

export default function Home() {
  const [view, setView] = useState<View>("dashboard");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [source, setSource] = useState<SourceData | null>(null);
  const [dataNames, setDataNames] = useState<string[]>([]);
  const [selectedDataName, setSelectedDataName] = useState("");
  const [template, setTemplate] = useState<TemplateId>("custom");
  const [taskName, setTaskName] = useState("");
  const [idField, setIdField] = useState("");
  const [imageField, setImageField] = useState("");
  const [captionField, setCaptionField] = useState("");
  const [groupField, setGroupField] = useState("");
  const [filter, setFilter] = useState<Filter>("unreviewed");
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState("选择本地文件夹即可开始，图片与数据不会上传。");
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [imageFiles, setImageFiles] = useState(new Map<string, File>());
  const [imageSession, setImageSession] = useState(0);
  const folderInput = useRef<HTMLInputElement>(null);
  const attachInput = useRef<HTMLInputElement>(null);
  const resultInput = useRef<HTMLInputElement>(null);
  const dataFiles = useRef(new Map<string, File>());

  useEffect(() => { readTasks().then(setTasks).catch(() => setNotice("无法读取浏览器中的审核任务。")); }, []);

  const visibleItems = useMemo(() => activeTask ? filteredItems(activeTask, filter) : [], [activeTask, filter]);
  const item = visibleItems[Math.min(offset, Math.max(0, visibleItems.length - 1))] || null;
  const currentTemplate = activeTask ? templates[activeTask.template] : null;
  const primaryRow = item?.rows[0] || {};
  const totals = useMemo(() => ({
    all: tasks.reduce((sum, task) => sum + task.total, 0),
    reviewed: tasks.reduce((sum, task) => sum + task.reviewed, 0),
    active: tasks.filter((task) => task.status === "in_progress").length,
  }), [tasks]);

  const rememberTask = useCallback(async (task: Task) => {
    setActiveTask(task);
    setTasks((current) => [task, ...current.filter((entry) => entry.id !== task.id)]);
    await writeTask(task);
  }, []);

  const indexImages = (files: File[]) => {
    const next = new Map<string, File>();
    files.filter(isImageFile).forEach((file) => {
      const relative = file.webkitRelativePath.replaceAll("\\", "/");
      const withoutRoot = localPath(file);
      next.set(relative, file); next.set(withoutRoot, file); next.set(file.name, file);
    });
    setImageFiles(next);
    setImageSession((value) => value + 1);
    return new Set(next.values()).size;
  };

  const loadDataFile = async (file: File, folderName: string, imageCount: number) => {
    const rows = parseCandidateData(file.name, await file.text());
    if (!rows.length) throw new Error("候选数据中没有记录。");
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    setSource({ folderName, dataName: file.name, rows, headers, imageCount });
    setSelectedDataName(file.name);
    setIdField(guessField(headers, ["record_id", "id", "shortcode", "post_id"]));
    setImageField(guessField(headers, ["image_path", "image", "filename", "file_path"]));
    setCaptionField(guessField(headers, ["caption", "post_text", "text"]));
    setGroupField(guessField(headers, ["group_id", "duplicate_group", "cluster_id"]));
    setNotice(`已读取 ${rows.length} 条候选记录和 ${imageCount} 张图片。`);
  };

  const chooseFolder = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const list = [...files];
      const folderName = list[0].webkitRelativePath.split("/")[0] || "本地审核文件夹";
      const imageCount = indexImages(list);
      const images = list.filter(isImageFile);
      const candidates = list.filter((file) => file.webkitRelativePath.split("/").length <= 2 && /\.(csv|json)$/i.test(file.name));
      dataFiles.current = new Map(candidates.map((file) => [file.name, file]));
      setDataNames(candidates.map((file) => file.name));
      if (!images.length) throw new Error("这个文件夹里没有找到可显示的图片。");
      if (!candidates[0]) {
        const rows = images.map((file) => ({ record_id: localPath(file), image_path: localPath(file) }));
        setSource({ folderName, dataName: "本地图片文件夹", rows, headers: ["record_id", "image_path"], imageCount });
        setSelectedDataName("");
        setIdField("record_id"); setImageField("image_path"); setCaptionField(""); setGroupField("");
        setNotice(`文件夹读取成功：${imageCount} 张图片。点击“开始图片审核”即可进入。`);
        return;
      }
      await loadDataFile(candidates[0], folderName, imageCount);
    } catch (error) {
      setSource(null);
      setNotice(error instanceof Error ? error.message : "无法读取本地文件夹。");
    } finally {
      setBusy(false);
      if (folderInput.current) folderInput.current.value = "";
    }
  };

  const switchDataFile = async (name: string) => {
    if (!source) return;
    const file = dataFiles.current.get(name);
    if (!file) return;
    setBusy(true);
    try { await loadDataFile(file, source.folderName, source.imageCount); }
    catch (error) { setNotice(error instanceof Error ? error.message : "无法读取候选文件。"); }
    finally { setBusy(false); }
  };

  const attachFolder = (files: FileList | null) => {
    if (!files?.length) return;
    const count = indexImages([...files]);
    setNotice(`已重新连接 ${count} 张本地图片，可以继续审核。`);
    if (attachInput.current) attachInput.current.value = "";
  };

  const missingImages = useMemo(() => {
    if (!source || !imageField) return 0;
    return source.rows.filter((row) => !imageFiles.has(row[imageField]) && !imageFiles.has(imageKey(row[imageField] || ""))).length;
  }, [imageField, imageFiles, source]);

  const createTask = async () => {
    if (!source || !idField || !imageField || (template === "duplicate" && !groupField)) return;
    setBusy(true);
    const makeItem = (rows: CandidateRow[], groupId = ""): ReviewItem => ({
      item_id: groupId || rows[0][idField], group_id: groupId, rows,
      image_paths: rows.map((row) => row[imageField]).filter(Boolean), decision: "", note: "", canonical_record_id: "", reviewed_at: "",
    });
    const items = template === "duplicate"
      ? [...source.rows.reduce((groups, row) => {
          const key = row[groupField]; groups.set(key, [...(groups.get(key) || []), row]); return groups;
        }, new Map<string, CandidateRow[]>())].map(([groupId, rows]) => makeItem(rows, groupId))
      : source.rows.map((row) => makeItem([row]));
    const task: Task = {
      id: `review_${Date.now()}`, name: taskName.trim() || templates[template].title, template,
      layout: templates[template].layout, status: "in_progress", total: items.length, reviewed: 0,
      labels: Object.keys(templates[template].labels), folder_name: source.folderName, source_name: source.dataName,
      headers: source.headers, id_field: idField, image_field: imageField, caption_field: captionField,
      group_field: groupField, updated_at: new Date().toISOString(), items,
    };
    try {
      await rememberTask(task); setFilter("unreviewed"); setOffset(0); setView("review");
      setNotice(`任务“${task.name}”已创建，人工判断会自动保存在当前浏览器。`);
    } catch { setNotice("任务保存失败，请检查浏览器是否允许本地存储。"); }
    finally { setBusy(false); }
  };

  const openTask = (task: Task) => {
    setActiveTask(task); setFilter("unreviewed"); setOffset(0); setView("review");
    if (!imageFiles.size) setNotice("审核记录已恢复。请重新选择原文件夹以显示本地图片。你的已有判断不会丢失。");
  };

  const saveDecision = useCallback(async (decision: string) => {
    if (!activeTask || !item) return;
    const reviewedAt = new Date().toISOString();
    const items = activeTask.items.map((entry) => entry.item_id === item.item_id ? { ...entry, decision, reviewed_at: reviewedAt } : entry);
    const reviewed = items.filter((entry) => entry.decision).length;
    const next: Task = { ...activeTask, items, reviewed, status: reviewed === items.length ? "complete" : "in_progress", updated_at: reviewedAt };
    await rememberTask(next);
    if (filter !== "unreviewed") setOffset((value) => Math.min(value + 1, Math.max(0, filteredItems(next, filter).length - 1)));
    setNotice("人工标签已保存。JSON 可以随时导出并继续编辑。");
  }, [activeTask, filter, item, rememberTask]);

  const selectCanonical = async (recordId: string) => {
    if (!activeTask || !item) return;
    const next = { ...activeTask, items: activeTask.items.map((entry) => entry.item_id === item.item_id ? { ...entry, canonical_record_id: recordId } : entry), updated_at: new Date().toISOString() };
    await rememberTask(next);
  };

  const editNote = (value: string) => {
    if (!item) return;
    setActiveTask((current) => current ? {
      ...current,
      items: current.items.map((entry) => entry.item_id === item.item_id ? { ...entry, note: value } : entry),
    } : current);
  };

  const saveNote = () => {
    if (activeTask) void rememberTask({ ...activeTask, updated_at: new Date().toISOString() });
  };

  const goTo = useCallback((nextOffset: number) => {
    setOffset(Math.max(0, Math.min(nextOffset, visibleItems.length - 1)));
  }, [visibleItems.length]);

  useEffect(() => {
    if (view !== "review") return;
    const key = (event: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes((event.target as HTMLElement)?.tagName)) return;
      const labels = activeTask ? Object.keys(templates[activeTask.template].labels) : [];
      const number = Number(event.key);
      if (number > 0 && labels[number - 1]) void saveDecision(labels[number - 1]);
      if (event.key === "ArrowLeft") void goTo(offset - 1);
      if (event.key === "ArrowRight") void goTo(offset + 1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [activeTask, goTo, offset, saveDecision, view]);

  const exportJson = (task: Task) => {
    download(`${task.name}_review.json`, JSON.stringify({ format_version: 1, tool_kind: "insightflow-review-result", exported_at: new Date().toISOString(), task }, null, 2), "application/json");
    setNotice("审核 JSON 已导出，包含任务配置、原始字段和全部人工判断，不包含图片文件。");
  };
  const exportCsv = (task: Task) => {
    const rows = task.items.flatMap((entry) => entry.rows.map((row) => ({ ...row,
      insightflow_task_id: task.id, human_review_template: task.template, human_decision: entry.decision,
      human_note: entry.note, canonical_record_id: entry.canonical_record_id, human_reviewed_at: entry.reviewed_at,
    })));
    download(`${task.name}_reviewed.csv`, `\uFEFF${toCsv(rows)}`, "text/csv;charset=utf-8");
    setNotice("审核 CSV 已导出，原始字段保持不变，人工字段追加在末尾。");
  };
  const importResult = async (file?: File) => {
    if (!file) return;
    try {
      const result = JSON.parse(await file.text()) as { tool_kind?: string; task?: Task };
      if (result.tool_kind !== "insightflow-review-result" || !result.task?.items) throw new Error("这不是 InsightFlow 审核结果文件。");
      await rememberTask(result.task);
      setImageFiles(new Map()); setImageSession((value) => value + 1);
      setFilter("unreviewed"); setOffset(0); setView("review");
      setNotice(`进度已导入：${result.task.reviewed} / ${result.task.total} 项已审核。重新选择原图片文件夹后即可继续。`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "无法导入审核结果。"); }
    finally { if (resultInput.current) resultInput.current.value = ""; }
  };

  const imageFor = (path: string) => imageFiles.get(path) || imageFiles.get(imageKey(path));
  const contextFields = Object.entries(primaryRow).filter(([key, value]) => value && key !== activeTask?.caption_field && key !== activeTask?.image_field).slice(0, 12);
  const openFolderPicker = () => { setView("create"); folderInput.current?.click(); };

  return <div className="if-shell">
    <input ref={folderInput} type="file" multiple hidden {...{ webkitdirectory: "" }} onChange={(event) => void chooseFolder(event.target.files)} />
    <input ref={attachInput} type="file" multiple hidden {...{ webkitdirectory: "" }} onChange={(event) => attachFolder(event.target.files)} />
    <input ref={resultInput} type="file" accept=".json,application/json" hidden onChange={(event) => void importResult(event.target.files?.[0])} />

    <aside className="if-sidebar">
      <button className="if-brand" onClick={() => setView("dashboard")}><span>IF</span><div><b>InsightFlow</b><small>HUMAN REVIEW AGENT</small></div></button>
      <div className="agent-state online"><i /><div><b>浏览器本地模式</b><small>{imageFiles.size ? `${new Set(imageFiles.values()).size} 张本地图片` : "文件不会上传"}</small></div></div>
      <nav><span>WORKSPACE</span><button className={view === "dashboard" ? "active" : ""} onClick={() => setView("dashboard")}>任务总览</button><button className={view === "create" ? "active" : ""} onClick={() => setView("create")}>新建审核任务</button>{activeTask && <button className={view === "review" ? "active" : ""} onClick={() => setView("review")}>继续当前审核</button>}</nav>
      <div className="scope-note"><b>只负责人工审核</b><p>外部脚本或模型负责发现候选项；这里负责看图、核对帖文、打标和导出。</p></div>
      <button className="help-link" onClick={() => setShowHelp(true)}>本地文件夹应该怎么放？</button>
    </aside>

    <main className="if-main">
      <header><div><span>{view === "dashboard" ? "REVIEW WORKSPACE" : view === "create" ? "NEW REVIEW TASK" : currentTemplate?.short}</span><b>{activeTask && view === "review" ? activeTask.name : source?.folderName || "Image Research Workspace"}</b></div><div className="header-actions"><button className="ghost" onClick={() => resultInput.current?.click()}>导入审核 JSON</button><button className="accent" onClick={() => setView("create")}>＋ 新建审核任务</button></div></header>
      <div className="if-notice"><span>{notice}</span><button onClick={() => setNotice("本地审核工作区已就绪。")}>×</button></div>

      {view === "dashboard" && <section className="if-page dashboard">
        <div className="dashboard-hero"><div><span className="kicker">LOCAL-FIRST · HUMAN-IN-THE-LOOP</span><h1>打开本地图片，<br />开始人工审核。</h1><p>直接选择图片文件夹；如果文件夹中还有 CSV/JSON，系统会同时读取帖文和其他字段。数据不上传，结果导出为 JSON。</p><div><button className="accent large" onClick={openFolderPicker}>选择本地文件夹并开始</button>{tasks[0] && <button className="dark" onClick={() => openTask(tasks.find((task) => task.status === "in_progress") || tasks[0])}>继续上次审核 →</button>}</div></div><div className="hero-flow"><span>本地图片 + 可选数据表</span><i>→</i><strong>人工审核</strong><i>→</i><span>审核结果 JSON</span><small>文件只在浏览器中读取 · 判断自动保存 · 可随时导出</small></div></div>
        <div className="metrics"><article><span>审核任务</span><b>{tasks.length}</b><small>{totals.active} 个进行中</small></article><article><span>候选记录</span><b>{totals.all}</b><small>单图或重复组</small></article><article><span>已完成人审</span><b>{totals.reviewed}</b><small>{totals.all ? Math.round(totals.reviewed / totals.all * 100) : 0}% 总进度</small></article><article><span>数据位置</span><b className="text-metric">LOCAL</b><small>浏览器本地保存</small></article></div>
        <div className="section-heading"><div><span className="kicker">REVIEW TASKS</span><h2>审核任务</h2></div><button className="ghost" onClick={() => setView("create")}>创建新任务</button></div>
        <div className="task-grid">{tasks.length ? tasks.map((task) => <article className="task-card" key={task.id}><div className="task-top"><span>{templates[task.template].short}</span><em className={task.status}>{task.status === "complete" ? "已完成" : "进行中"}</em></div><h3>{task.name}</h3><p>{task.folder_name} · {task.source_name}</p><div className="progress"><div><span>审核进度</span><b>{task.reviewed} / {task.total}</b></div><i><span style={{ width: `${percentage(task)}%` }} /></i></div><div className="task-actions"><button className="accent" onClick={() => openTask(task)}>{task.status === "complete" ? "查看审核" : "继续审核"}</button><button className="ghost" onClick={() => exportJson(task)}>导出 JSON</button><button className="ghost" onClick={() => exportCsv(task)}>导出 CSV</button></div></article>) : <div className="empty-card"><h3>还没有审核任务</h3><p>选择本地文件夹后即可开始，不要求必须准备 CSV。</p><button className="accent" onClick={openFolderPicker}>选择本地文件夹</button></div>}</div>
      </section>}

      {view === "create" && <section className="if-page create-page">
        <div className="page-title"><span className="kicker">START REVIEW</span><h1>选择文件夹，开始图片审核</h1><p>只有图片也可以直接开始；如果顶层有 CSV/JSON，系统会自动读取并关联图片信息。</p></div>
        <section className="form-panel start-panel">
          <div className="step-title"><span>01</span><div><b>选择审核类型</b><small>默认使用通用的保留、排除、待定筛选</small></div></div>
          <div className="template-grid">{(Object.keys(templates) as TemplateId[]).map((key) => <button className={template === key ? "selected" : ""} onClick={() => setTemplate(key)} key={key}><b>{templates[key].title}</b><small>{templates[key].description}</small></button>)}</div>
          <div className="step-title folder-step"><span>02</span><div><b>打开本地图片文件夹</b><small>浏览器只读取文件，图片不会上传</small></div></div>
          <button className="folder-picker" disabled={busy} onClick={() => folderInput.current?.click()}><b>{busy ? "正在读取文件夹…" : source ? "重新选择文件夹" : "选择本地图片文件夹"}</b><small>图片可放在任意子文件夹，CSV/JSON 可选</small></button>
          {source && <div className="folder-ready" role="status"><div><b>✓ 文件夹读取成功</b><strong>{source.folderName}</strong><span>{source.imageCount} 张图片 · {source.rows.length} 条审核记录 · {missingImages} 条缺图</span><small>{source.dataName === "本地图片文件夹" ? "未发现数据表，将按图片文件名创建审核记录。" : `已关联 ${source.dataName}`}</small></div><button className="accent" disabled={!idField || !imageField || busy || (template === "duplicate" && !groupField)} onClick={() => void createTask()}>{template === "duplicate" && !groupField ? "请先设置重复组字段" : "开始图片审核 →"}</button></div>}
          {dataNames.length > 1 && <label><span>候选数据文件</span><select value={selectedDataName} onChange={(event) => void switchDataFile(event.target.value)}>{dataNames.map((name) => <option key={name}>{name}</option>)}</select></label>}
          {source && <details className="advanced-fields" open={!idField || !imageField || (template === "duplicate" && !groupField)}><summary>高级设置：任务名称与数据字段</summary><div className="field-grid"><label><span>任务名称</span><input value={taskName} onChange={(event) => setTaskName(event.target.value)} placeholder={templates[template].title} /></label><label><span>唯一 ID 字段</span><select value={idField} onChange={(event) => setIdField(event.target.value)}><option value="">请选择</option>{source.headers.map((field) => <option key={field}>{field}</option>)}</select></label><label><span>图片路径字段</span><select value={imageField} onChange={(event) => setImageField(event.target.value)}><option value="">请选择</option>{source.headers.map((field) => <option key={field}>{field}</option>)}</select></label><label><span>帖文内容字段</span><select value={captionField} onChange={(event) => setCaptionField(event.target.value)}><option value="">不单独展示</option>{source.headers.map((field) => <option key={field}>{field}</option>)}</select></label>{template === "duplicate" && <label><span>重复组 ID 字段</span><select value={groupField} onChange={(event) => setGroupField(event.target.value)}><option value="">请选择</option>{source.headers.map((field) => <option key={field}>{field}</option>)}</select></label>}</div></details>}
        </section>
      </section>}

      {view === "review" && activeTask && currentTemplate && <section className="review-layout">
        <aside className="review-rail"><span className="kicker">QUEUE</span><h2>{activeTask.name}</h2><p>{currentTemplate.description}</p><div className="progress large-progress"><div><span>总进度</span><b>{activeTask.reviewed} / {activeTask.total}</b></div><i><span style={{ width: `${percentage(activeTask)}%` }} /></i></div><div className="filter-list">{([["all", "全部"], ["unreviewed", "未审核"], ["reviewed", "已审核"], ["uncertain", "待定"]] as [Filter, string][]).map(([value, label]) => <button className={filter === value ? "active" : ""} key={value} onClick={() => { setFilter(value); setOffset(0); }}><span>{label}</span>{value === "all" && <em>{activeTask.total}</em>}{value === "unreviewed" && <em>{activeTask.total - activeTask.reviewed}</em>}{value === "reviewed" && <em>{activeTask.reviewed}</em>}</button>)}</div><div className="rail-actions"><button className="ghost wide" onClick={() => attachInput.current?.click()}>重新选择图片文件夹</button><button className="ghost wide" onClick={() => exportJson(activeTask)}>导出审核 JSON</button><button className="ghost wide" onClick={() => exportCsv(activeTask)}>导出审核 CSV</button><button className="text" onClick={() => setView("dashboard")}>← 返回任务总览</button></div></aside>
        {item ? <><section className="review-canvas">{!imageFiles.size && <div className="reconnect-folder" role="status"><div><b>审核进度已恢复</b><span>为保护本地文件，浏览器不会把图片保存进 JSON。请选择原图片文件夹即可继续。</span></div><button className="accent" onClick={() => attachInput.current?.click()}>重新连接图片文件夹</button></div>}<div className="review-meta"><div><b>{item.group_id || item.item_id}</b><span>{currentTemplate.layout === "compare" ? `${item.rows.length} 张候选图` : currentTemplate.short}</span></div><small>{Math.min(offset + 1, visibleItems.length)} / {visibleItems.length}</small></div><div className={currentTemplate.layout === "compare" ? "compare-images" : "single-image"}>{currentTemplate.layout === "compare" ? item.image_paths.map((path, index) => <article key={`${path}-${index}`}><div className="real-image"><LocalImage key={`${path}-${imageSession}`} file={imageFor(path)} alt={`重复候选 ${index + 1}`} /></div><label><input type="radio" name="canonical" checked={item.canonical_record_id === item.rows[index]?.[activeTask.id_field]} onChange={() => void selectCanonical(item.rows[index]?.[activeTask.id_field] || "")} /> 设为主记录</label><small>{item.rows[index]?.[activeTask.id_field]}</small></article>) : <div className="real-image"><LocalImage key={`${item.image_paths[0]}-${imageSession}`} file={imageFor(item.image_paths[0] || "")} alt={item.item_id} /></div>}</div>{activeTask.caption_field && primaryRow[activeTask.caption_field] && <div className="caption-card"><span>帖文内容 · {activeTask.caption_field}</span><p>{primaryRow[activeTask.caption_field]}</p></div>}<label className="note-field"><span>人工备注（可选）</span><textarea value={item.note} onChange={(event) => editNote(event.target.value)} onBlur={saveNote} placeholder="记录判断依据或需要讨论的问题…" /></label><div className="decision-grid">{Object.entries(currentTemplate.labels).map(([value, label], index) => <button className={item.decision === value ? "selected" : ""} disabled={busy} onClick={() => void saveDecision(value)} key={value}><kbd>{index + 1}</kbd>{label}</button>)}</div><div className="review-nav"><button disabled={offset === 0} onClick={() => goTo(offset - 1)}>← 上一项</button><span>数字键快速打标 · 左右键切换 · 判断自动保存</span><button disabled={offset + 1 >= visibleItems.length} onClick={() => goTo(offset + 1)}>下一项 →</button></div></section>
          <aside className="context-panel"><span className="kicker">SOURCE CONTEXT</span><h2>图片与帖子信息</h2><p>原始字段只读；人工判断单独保存在审核结果中。</p><dl>{contextFields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd className={key.toLowerCase().includes("keyword") ? "highlight" : ""}>{value}</dd></div>)}</dl>{item.decision && <div className="saved-decision"><span>当前人工标签</span><b>{currentTemplate.labels[item.decision] || item.decision}</b><small>{item.reviewed_at}</small></div>}</aside></> : <section className="review-empty"><span>✓</span><h2>当前队列已经处理完</h2><p>可以切换到“全部”检查历史判断，或直接导出审核结果。</p><button className="accent" onClick={() => exportJson(activeTask)}>导出审核 JSON</button></section>}
      </section>}
    </main>

    {showHelp && <div className="modal"><button aria-label="关闭" onClick={() => setShowHelp(false)} /><section><button className="close" onClick={() => setShowHelp(false)}>×</button><span className="kicker">LOCAL FOLDER</span><h2>准备一个本地审核文件夹</h2><p>候选 CSV 或 JSON 放在文件夹顶层，图片可以放在 images 等子文件夹。数据表里需要唯一 ID、图片路径；如果审核重复图片，再准备重复组 ID。</p><ol><li><b>1</b><span>选择整个文件夹，不需要逐张选择图片</span></li><li><b>2</b><span>确认系统识别出的字段</span></li><li><b>3</b><span>创建任务并开始打标</span></li></ol><button className="accent wide" onClick={() => setShowHelp(false)}>知道了</button></section></div>}
  </div>;
}
