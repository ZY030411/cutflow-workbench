const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const API_QUERY = new URLSearchParams(location.search).get("api");
const IS_LOCAL_APP = ["127.0.0.1", "localhost"].includes(location.hostname);
const LOCAL_APP_URL = "http://127.0.0.1:8787/";
const DEFAULT_API_BASE = ["127.0.0.1", "localhost"].includes(location.hostname)
  ? ""
  : "http://127.0.0.1:8787";
const API_BASE = (API_QUERY || localStorage.getItem("cutflow.apiBase") || DEFAULT_API_BASE)
  .replace(/\/+$/, "");

if (API_QUERY) localStorage.setItem("cutflow.apiBase", API_QUERY.replace(/\/+$/, ""));

const STAGES = [
  ["PENDING", "任务入队"],
  ["PREFLIGHT", "预检与能力矩阵"],
  ["PREPROCESSING", "画布与音频规范化"],
  ["TRANSCRIBING", "台词识别与字幕"],
  ["PLANNING", "节奏与智能配乐"],
  ["DRAFT_BUILDING", "构建剪映草稿"],
  ["DRAFT_VALIDATING", "草稿结构自检"],
  ["JIANYING_PROCESSING", "调用剪映专业版"],
  ["EXPORTING", "导出与回传"],
  ["QC", "成品完整性自检"],
  ["DELIVERED", "交付"],
];

const STATE_LABELS = {
  PENDING: "排队中",
  QUEUED: "排队中",
  RUNNING: "运行中",
  WAITING_MANUAL_EXPORT: "等待导出",
  INTERRUPTED: "已中断",
  FAILED: "失败",
  DELIVERED: "已交付",
};

const PAGE_TITLES = {
  create: "新建剪辑",
  tasks: "任务中心",
  system: "能力中心",
};

const HINTS = {
  whisper: "使用词级时间戳自动识别，默认跨平台链路。",
  script: "台词已经确定时使用文本稿；标点参与拆句，安装 Whisper 后做强制对齐。",
  native: "仅 Windows + 已验证剪映版本可尝试；探测失败会自动降级，不让任务卡死。",
};

let activeJobId = localStorage.getItem("cutflow.activeJob") || null;
let pollTimer = null;
let health = null;
let featureStatus = null;
let toastTimer = null;
let currentView = "create";
let healthRetryTimer = null;

function setBackendAvailability(online) {
  const button = $("#submitButton");
  if (!button) return;
  button.classList.toggle("backend-offline", !online);
  button.querySelector("span").textContent = online
    ? "开始自动剪辑"
    : "启动本机工作台后重试";
}

function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("cutflow.theme", next);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = next === "dark" ? "#0e1312" : "#f3f5f4";
  const toggle = $("#themeToggle");
  toggle.setAttribute("aria-pressed", String(next === "dark"));
  toggle.setAttribute("aria-label", next === "dark" ? "切换到白天模式" : "切换到夜晚模式");
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(apiUrl(path), { cache: "no-store", ...options });
  } catch {
    throw new Error("无法连接本机工作台。请运行 F:\\AI漫剧自动剪辑工作台\\workbench\\start.ps1 后重试。");
  }
  const type = response.headers.get("content-type") || "";
  const body = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.message || body || `请求失败 (${response.status})`);
  return body;
}

function uploadJob(form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl("/api/jobs"));
    xhr.timeout = 30 * 60 * 1000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      let body = null;
      try {
        body = JSON.parse(xhr.responseText || "{}");
      } catch {
        body = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body);
        return;
      }
      const message = body.message || body.code || `上传失败 (${xhr.status})`;
      reject(new Error(xhr.status === 413
        ? "素材超过当前入口允许的上传大小。请使用 GitHub Pages + 本机后端直连，不要经过公网隧道。"
        : message));
    };
    xhr.onerror = () => reject(new Error(
      "无法连接本机工作台。请确认 start.ps1 已运行，且 http://127.0.0.1:8787/api/health 可以打开。"
    ));
    xhr.ontimeout = () => reject(new Error("上传等待超过 30 分钟，请检查磁盘空间和本机服务后重试。"));
    xhr.send(form);
  });
}

function showToast(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 3400);
}

function humanBytes(value) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let size = Number(value);
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function stateClass(state) {
  if (state === "DELIVERED") return "done";
  if (state === "WAITING_MANUAL_EXPORT") return "waiting";
  if (state === "FAILED" || state === "INTERRUPTED") return "failed";
  return "";
}

function stageIndex(stage) {
  const index = STAGES.findIndex(([code]) => code === stage);
  return index < 0 ? 0 : index;
}

function switchView(view, updateHash = true) {
  const next = ["create", "tasks", "system"].includes(view) ? view : "create";
  currentView = next;
  $$(".app-view").forEach((section) => {
    section.hidden = section.dataset.page !== next;
    const title = section.querySelector("[data-page-title]");
    if (title) {
      const desiredTag = section.dataset.page === next ? "h1" : "h2";
      if (title.tagName.toLowerCase() !== desiredTag) {
        const replacement = document.createElement(desiredTag);
        replacement.dataset.pageTitle = "";
        replacement.innerHTML = title.innerHTML;
        title.replaceWith(replacement);
      }
    }
  });
  $$(".rail-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === next);
  });
  $$(".mobile-nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.mobileView === next);
  });
  $("#pageTitle").textContent = PAGE_TITLES[next];
  if (updateHash && location.hash !== `#${next}`) {
    history.replaceState(null, "", `#${next}`);
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (next === "tasks") loadHistory();
  if (next === "system") loadFeatureStatus();
}

function renderFiles(files) {
  const stack = $("#fileStack");
  stack.innerHTML = "";
  if (!files.length) return;
  [...files].slice(0, 4).forEach((file) => {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    chip.textContent = `${file.name} · ${humanBytes(file.size)}`;
    stack.appendChild(chip);
  });
  if (files.length > 4) {
    const more = document.createElement("span");
    more.className = "file-chip";
    more.textContent = `另有 ${files.length - 4} 个片段`;
    stack.appendChild(more);
  }
}

function bindDropzone() {
  const input = $("#videoInput");
  const zone = $("#dropzone");
  input.addEventListener("change", () => renderFiles(input.files));
  ["dragenter", "dragover"].forEach((name) => {
    zone.addEventListener(name, (event) => {
      event.preventDefault();
      zone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach((name) => {
    zone.addEventListener(name, (event) => {
      event.preventDefault();
      zone.classList.remove("dragging");
    });
  });
  zone.addEventListener("drop", (event) => {
    if (!event.dataTransfer.files.length) return;
    const transfer = new DataTransfer();
    [...event.dataTransfer.files].forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
    renderFiles(transfer.files);
  });
}

function modeChanged() {
  const mode = $("#subtitleMode").value;
  $("#modeHint").textContent = HINTS[mode];
  $("#transcriptSection").hidden = mode !== "script";
  if (mode === "whisper" && health && !health.asr.model_installed) {
    $("#modeHint").textContent = "Whisper 模型尚未缓存；可先选择文本稿模式，或运行 install-asr.ps1。";
  }
}

function formConfig() {
  return {
    subtitle_mode: $("#subtitleMode").value,
    edit_mode: document.querySelector('input[name="editMode"]:checked')?.value || "rough",
    transcript: $("#transcript").value.trim(),
    language: "zh",
    whisper_model: $("#whisperModel").value.trim() || "large-v3",
    publish_to_jianying: $("#publishJianying").checked,
    launch_jianying: $("#launchJianying").checked,
    auto_export: $("#autoExport").checked,
    allow_unverified_materials: $("#allowUnverified").checked,
    matching: {
      music: document.querySelector('[name="match_music"]').checked,
      transitions: document.querySelector('[name="match_transitions"]').checked,
      effects: document.querySelector('[name="match_effects"]').checked,
      sound_effects: document.querySelector('[name="match_sound_effects"]').checked,
      smart_audio: Boolean(featureStatus?.smart_audio?.qwen_configured),
    },
  };
}

async function submitJob(event) {
  event.preventDefault();
  const input = $("#videoInput");
  if (!input.files.length) {
    showToast("请先选择至少一个视频素材", true);
    return;
  }
  const config = formConfig();
  if (config.subtitle_mode === "script" && !config.transcript) {
    showToast("文本稿模式需要填写台词", true);
    $("#transcript").focus();
    return;
  }
  const button = $("#submitButton");
  button.disabled = true;
  button.querySelector("span").textContent = "正在上传素材";
  const form = new FormData();
  form.append("config", JSON.stringify(config));
  [...input.files].forEach((file) => form.append("videos", file));
  try {
    const job = await uploadJob(form, (percent) => {
      button.querySelector("span").textContent = `正在上传 ${percent}%`;
    });
    button.querySelector("span").textContent = "正在启动任务";
    activeJobId = job.id;
    localStorage.setItem("cutflow.activeJob", activeJobId);
    showToast("任务已创建，已切换到任务中心");
    switchView("tasks");
    renderJob(job);
    startPolling();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "开始自动剪辑";
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!activeJobId) return;
    try {
      const job = await api(`/api/jobs/${activeJobId}`);
      renderJob(job);
      if (["DELIVERED", "FAILED", "INTERRUPTED", "WAITING_MANUAL_EXPORT"].includes(job.state)) {
        clearInterval(pollTimer);
        pollTimer = null;
        loadHistory();
      }
    } catch {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 1200);
}

function renderJob(job) {
  if (!job || !job.id) return;
  $("#runEmpty").hidden = true;
  $("#runContent").hidden = false;
  $("#jobTitle").textContent = job.input_name || "自动剪辑任务";
  $("#jobMeta").textContent = `${job.id.slice(0, 8)} · ${new Date(job.created_at).toLocaleString("zh-CN")}`;
  const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
  $("#progressValue").textContent = Math.round(progress);
  $("#progressArc").style.strokeDashoffset = String(100 - progress);
  $("#currentStage").textContent = job.stage || job.state;
  $("#currentMessage").textContent = job.error_message || job.message || "处理中";
  const state = $("#jobState");
  state.textContent = STATE_LABELS[job.state] || job.state;
  state.className = `job-state ${stateClass(job.state)}`;
  renderTimeline(job);
  renderWarnings(job);
  renderActions(job);
  renderArtifacts(job.artifacts || []);
  renderManualExport(job);
  loadMaterials(job);
  $$(".history-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.jobId === job.id);
  });
}

function renderEmptyTask() {
  $("#runEmpty").hidden = false;
  $("#runContent").hidden = true;
  $("#jobTitle").textContent = "自动剪辑任务";
  $("#materialSection").hidden = true;
}

function renderTimeline(job) {
  const timeline = $("#timeline");
  const current = stageIndex(job.stage);
  const finished = job.state === "DELIVERED";
  const failed = ["FAILED", "INTERRUPTED"].includes(job.state);
  timeline.innerHTML = "";
  STAGES.forEach(([code, label], index) => {
    const item = document.createElement("li");
    if (finished || index < current) item.className = "done";
    if (job.state === "WAITING_MANUAL_EXPORT" && index <= current) item.className = "done";
    if (!finished && !failed && index === current && job.state === "RUNNING") item.className = "active";
    if (failed && index === current) item.className = "active";
    item.innerHTML = `<span></span><span>${label}</span><span class="stage-code">${String(index + 1).padStart(2, "0")}</span>`;
    timeline.appendChild(item);
  });
}

function renderWarnings(job) {
  const box = $("#warningBox");
  const warnings = job.warnings || [];
  box.hidden = !warnings.length;
  if (warnings.length) {
    box.innerHTML = `<strong>需要留意</strong>${warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("")}`;
  }
}

function renderActions(job) {
  const actions = $("#jobActions");
  const openButton = $("#openDraftButton");
  const resumeButton = $("#resumeButton");
  const deleteButton = $("#deleteJobButton");
  const running = ["QUEUED", "RUNNING"].includes(job.state);
  const hasDraft = (job.artifacts || []).some((item) => item.path.includes("draft_build.json"));
  openButton.hidden = !hasDraft;
  resumeButton.hidden = !["FAILED", "INTERRUPTED"].includes(job.state);
  deleteButton.hidden = running;
  actions.hidden = openButton.hidden && resumeButton.hidden && deleteButton.hidden;
}

function renderManualExport(job) {
  const block = $("#manualExport");
  block.hidden = job.state !== "WAITING_MANUAL_EXPORT";
  if (!block.hidden) {
    $("#manualHint").textContent = "草稿已发布。请在剪映首页定位并打开本任务草稿，检查预览后导出 MP4 再回传。";
  }
}

function renderArtifacts(artifacts) {
  const section = $("#artifactSection");
  const list = $("#artifactList");
  const useful = artifacts
    .filter((item) => !["asr_words.json", "draft_build.json"].includes(item.name))
    .sort((a, b) => artifactPriority(b) - artifactPriority(a));
  $("#artifactCount").textContent = `${useful.length} files`;
  section.hidden = !useful.length;
  list.innerHTML = "";
  useful.forEach((item) => {
    const link = document.createElement("a");
    link.className = "artifact-item";
    link.href = apiUrl(item.url);
    link.target = item.kind === "video" || item.kind === "image" ? "_blank" : "_self";
    link.innerHTML = `
      <span class="artifact-type">${escapeHtml((item.kind || "file").slice(0, 4))}</span>
      <span class="artifact-name">${escapeHtml(item.name)}</span>
      <span class="artifact-size">${humanBytes(item.size)}</span>
    `;
    list.appendChild(link);
  });
}

function artifactPriority(item) {
  const priorities = { "成片 MP4": 10, "交付自检报告": 9, "可编辑草稿包.zip": 8, "10/50/90% 抽帧复核": 7 };
  return priorities[item.name] || 1;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadHistory() {
  try {
    const payload = await api("/api/jobs?limit=30");
    const grid = $("#historyGrid");
    grid.innerHTML = "";
    const jobs = payload.jobs || [];
    $("#taskTotal").textContent = jobs.length;
    $("#taskRunning").textContent = jobs.filter((job) => ["QUEUED", "RUNNING"].includes(job.state)).length;
    $("#taskDelivered").textContent = jobs.filter((job) => job.state === "DELIVERED").length;
    if (!jobs.length) {
      grid.innerHTML = '<div class="history-empty">还没有剪辑任务。<br>从“新建剪辑”开始第一条创作。</div>';
      return;
    }
    jobs.forEach((job) => {
      const card = document.createElement("article");
      card.className = `history-card${job.id === activeJobId ? " selected" : ""}`;
      card.tabIndex = 0;
      card.dataset.jobId = job.id;
      card.innerHTML = `
        <div class="history-top">
          <span class="history-title">${escapeHtml(job.input_name || "自动剪辑任务")}</span>
          <span class="history-state ${stateClass(job.state)}">${escapeHtml(STATE_LABELS[job.state] || job.state)}</span>
        </div>
        <div class="history-progress"><span style="width:${Number(job.progress || 0)}%"></span></div>
        <div class="history-meta">
          <span>${escapeHtml(job.stage || "PENDING")}</span>
          <span>${new Date(job.created_at).toLocaleString("zh-CN")}</span>
        </div>
        <button class="card-delete" type="button" title="删除任务" aria-label="删除任务">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/></svg>
        </button>
      `;
      const select = () => {
        activeJobId = job.id;
        localStorage.setItem("cutflow.activeJob", job.id);
        renderJob(job);
        if (["QUEUED", "RUNNING"].includes(job.state)) startPolling();
        $$(".history-card").forEach((item) => item.classList.toggle("selected", item === card));
      };
      card.addEventListener("click", select);
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter") select();
      });
      card.querySelector(".card-delete").addEventListener("click", async (event) => {
        event.stopPropagation();
        await deleteJob(job.id);
      });
      grid.appendChild(card);
    });
  } catch (error) {
    $("#historyGrid").innerHTML = `<div class="history-empty">${escapeHtml(error.message)}</div>`;
  }
}

async function loadHealth() {
  try {
    health = await api("/api/health");
    setBackendAvailability(true);
    clearTimeout(healthRetryTimer);
    const pill = $("#systemPill");
    if (health.ready_for_pipeline) {
      pill.className = "system-pill ready";
      $("#systemStatus").textContent = `剪映 ${health.jianying.version || "已检测"} · 本地引擎就绪`;
    } else {
      pill.className = "system-pill error";
      $("#systemStatus").textContent = "基础依赖不完整";
    }
    const cards = [
      {
        label: "剪映专业版",
        value: health.jianying.installed ? health.jianying.version || "已安装" : "未检测",
        detail: health.jianying.installed ? `${health.jianying.running ? "正在运行" : "未运行"} · 草稿库${health.jianying.draft_root_exists ? "可用" : "缺失"}` : "未找到可执行文件",
        status: health.jianying.installed ? "ok" : "bad",
      },
      {
        label: "草稿后端",
        value: health.draft_backend.available ? "pyJianYingDraft" : "不可用",
        detail: health.draft_backend.available
          ? health.draft_backend.compatibility === "verified"
            ? "该版本已通过实开与导出验证"
            : "读写可用；待实开、预览和导出验收"
          : health.draft_backend.install_hint || health.draft_backend.error,
        status: health.draft_backend.available
          ? health.draft_backend.compatibility === "verified" ? "ok" : "warn"
          : "bad",
      },
      {
        label: "语音识别",
        value: health.asr.model_installed ? `Whisper ${health.asr.model}` : "未安装",
        detail: health.asr.model_installed
          ? `${health.asr.preferred_device === "cuda" ? "CUDA 加速" : "CPU int8"} · 模型已缓存`
          : "可先使用文本稿模式",
        status: health.asr.model_installed ? "ok" : "warn",
      },
      {
        label: "导出能力",
        value: health.jianying.auto_export_supported ? "自动导出" : "手动导出",
        detail: health.jianying.auto_export_supported ? "版本桥接需 UIA 实测" : "导出后回传继续 QC",
        status: health.jianying.auto_export_supported ? "ok" : "warn",
      },
      {
        label: "媒体工具",
        value: health.ffmpeg.available && health.ffprobe.available ? "FFmpeg 就绪" : "缺少 FFmpeg",
        detail: "画布、音频、解码与成品门禁",
        status: health.ffmpeg.available && health.ffprobe.available ? "ok" : "bad",
      },
      {
        label: "稳定保护",
        value: `CPU ${health.stability?.cpu_threads || 2} 线程`,
        detail: health.stability?.ali_paladin_driver_present
          ? "检测到 AliPaladin 文件筛选驱动；若仍蓝屏请更新或移除冲突驱动"
          : "Whisper 使用低负载 CPU 模式，后端以低优先级运行",
        status: health.stability?.ali_paladin_driver_present ? "warn" : "ok",
      },
    ];
    $("#systemGrid").innerHTML = cards.map((card) => `
      <article class="system-card">
        <span class="system-label"><i class="health-dot ${card.status}"></i>${escapeHtml(card.label)}</span>
        <strong>${escapeHtml(card.value)}</strong>
        <p>${escapeHtml(card.detail || "")}</p>
      </article>
    `).join("");
    modeChanged();
  } catch (error) {
    health = null;
    setBackendAvailability(false);
    $("#systemStatus").textContent = "本机后端未连接";
    $("#systemPill").className = "system-pill error";
    $("#systemGrid").innerHTML = `<div class="system-card loading">${escapeHtml(error.message)}<br><br>运行 F:\\AI漫剧自动剪辑工作台\\workbench\\start.ps1 后，本页会自动重连。</div>`;
    clearTimeout(healthRetryTimer);
    healthRetryTimer = setTimeout(loadHealth, 4000);
  }
}

async function loadFeatureStatus() {
  try {
    const [features, settings, access, jianyingAudio] = await Promise.all([
      api("/api/features"),
      api("/api/settings/smart-audio"),
      api("/api/access"),
      api("/api/jianying/audio-automation"),
    ]);
    featureStatus = features;
    const smart = featureStatus.smart_audio;
    const cards = [
      {
        title: "Qwen-Omni 画面理解",
        state: smart.qwen_configured ? "已配置" : "待配置",
        stateClass: smart.qwen_configured ? "ok" : "warn",
        detail: `${smart.qwen_model} · DashScope OpenAI 兼容接口`,
        foot: "先识别台词，再规划音乐与音效",
      },
      {
        title: "剪映素材索引",
        state: `${smart.whitelist_count} 个已验证`,
        stateClass: smart.whitelist_count ? "ok" : "warn",
        detail: `${smart.music_index_count} 首音乐 · ${smart.sfx_index_count} 个本地音效候选`,
        foot: "云端引用必须通过目标版本白名单",
      },
      {
        title: "剪映界面自动化",
        state: jianyingAudio.ready ? "可执行" : "需校准",
        stateClass: jianyingAudio.ready ? "ok" : "warn",
        detail: jianyingAudio.ready
          ? jianyingAudio.executor === "visual_calibrated"
            ? "11.6 视觉校准可用：搜索、拖入轨道并截图验证"
            : "音乐库、搜索、添加与时间轴控件已识别"
          : jianyingAudio.reason,
        foot: "无法定位控件时保留手动兜底",
      },
    ];
    $("#smartFeatureGrid").innerHTML = cards.map((card) => `
      <article class="smart-feature">
        <div class="feature-state"><span>${escapeHtml(card.title)}</span><span class="status-chip ${card.stateClass}">${escapeHtml(card.state)}</span></div>
        <h3>${escapeHtml(card.title)}</h3>
        <p>${escapeHtml(card.detail)}</p>
        <div class="feature-foot"><span>${escapeHtml(card.foot)}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg></div>
      </article>
    `).join("");
    $("#smartAudioHint").textContent = smart.qwen_configured
      ? `画面理解已就绪 · ${smart.qwen_model}`
      : "DASHSCOPE_API_KEY 未配置；启用后会降级并记录警告";
    $("#smartAudioState").textContent = smart.qwen_configured ? "已就绪" : "待配置";
    $("#smartAudioState").className = `status-chip ${smart.qwen_configured ? "ok" : "warn"}`;
    $("#qwenConfigState").textContent = smart.qwen_configured ? "已配置" : "待配置";
    $("#qwenConfigState").className = `status-chip ${smart.qwen_configured ? "ok" : "warn"}`;
    $("#dashscopeSaved").textContent = settings.dashscope.configured
      ? "API Key 已保存；输入新值可以替换"
      : "API Key 尚未保存";
    $("#dashscopeSaved").classList.toggle("configured", settings.dashscope.configured);
    $("#qwenModelInput").value = settings.dashscope.model || "qwen3.8-omni-flash";
    $("#dashscopeBaseUrl").value = settings.dashscope.base_url || "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const indexItems = $("#indexSummary").querySelectorAll("strong");
    if (indexItems.length === 3) {
      indexItems[0].textContent = smart.music_index_count;
      indexItems[1].textContent = smart.sfx_index_count;
      indexItems[2].textContent = smart.whitelist_count;
    }
    const hostLink = $("#hostAccessUrl");
    hostLink.href = access.public_url || access.host_url || access.local_url;
    hostLink.textContent = access.public_url || access.host_url || access.local_url;
    const lanAddresses = (access.lan_urls || []).join(" · ");
    $("#accessScope").textContent = lanAddresses
      ? `局域网：${lanAddresses}。${access.scope}`
      : access.scope;
  } catch (error) {
    $("#smartFeatureGrid").innerHTML = `<div class="smart-feature"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function saveSmartSettings(event) {
  event.preventDefault();
  const feedback = $("#configFeedback");
  feedback.textContent = "正在保存...";
  try {
    await api("/api/settings/smart-audio", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        dashscope_api_key: $("#dashscopeKey").value.trim(),
        qwen_model: $("#qwenModelInput").value.trim(),
        dashscope_base_url: $("#dashscopeBaseUrl").value.trim(),
      }),
    });
    $("#dashscopeKey").value = "";
    feedback.textContent = "配置已保存并立即生效。";
    await Promise.all([loadFeatureStatus(), loadHealth()]);
  } catch (error) {
    feedback.textContent = error.message;
    showToast(error.message, true);
  }
}

async function clearSmartKeys() {
  const ok = await confirmAction(
    "清除千问密钥？",
    "模型名和 Base URL 会保留，DashScope API Key 会从 Windows 用户环境变量中删除。",
    "清除密钥"
  );
  if (!ok) return;
  try {
    await api("/api/settings/smart-audio", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({clear_dashscope: true}),
    });
    $("#configFeedback").textContent = "密钥已清除。";
    await Promise.all([loadFeatureStatus(), loadHealth()]);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadMaterials(job) {
  const section = $("#materialSection");
  const list = $("#materialList");
  try {
    const payload = await api(`/api/jobs/${job.id}/materials`);
    const materials = payload.materials || [];
    section.hidden = !materials.length;
    $("#materialCount").textContent = `${materials.length} 个文件`;
    list.innerHTML = "";
    const locked = ["QUEUED", "RUNNING"].includes(job.state);
    materials.forEach((material) => {
      const item = document.createElement("div");
      item.className = "material-item";
      item.innerHTML = `
        <span class="material-type">VID</span>
        <span class="material-name" title="${escapeHtml(material.display_name)}">${escapeHtml(material.display_name)}</span>
        <span class="material-size">${humanBytes(material.size)}</span>
        <button class="material-delete" type="button" ${locked ? "disabled" : ""}>删除</button>
      `;
      item.querySelector(".material-delete").addEventListener("click", async () => {
        await deleteMaterial(job.id, material.name);
      });
      list.appendChild(item);
    });
  } catch {
    section.hidden = true;
  }
}

function confirmAction(title, message, confirmLabel = "确认删除") {
  const dialog = $("#confirmDialog");
  $("#confirmTitle").textContent = title;
  $("#confirmMessage").textContent = message;
  $("#confirmAccept").textContent = confirmLabel;
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

async function deleteJob(jobId) {
  const ok = await confirmAction(
    "删除整个任务？",
    "将永久删除这个任务的上传素材、中间文件、草稿和交付物，无法恢复。",
    "删除任务"
  );
  if (!ok) return;
  try {
    await api(`/api/jobs/${jobId}`, { method: "DELETE" });
    if (activeJobId === jobId) {
      activeJobId = null;
      localStorage.removeItem("cutflow.activeJob");
      clearInterval(pollTimer);
      pollTimer = null;
      renderEmptyTask();
    }
    showToast("任务已删除");
    loadHistory();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function deleteMaterial(jobId, materialName) {
  const ok = await confirmAction(
    "删除这个素材？",
    "素材会从任务目录永久删除，之后该任务无法再从原始素材续跑。已生成的草稿和成片不受影响。",
    "删除素材"
  );
  if (!ok) return;
  try {
    await api(`/api/jobs/${jobId}/materials/${encodeURIComponent(materialName)}`, { method: "DELETE" });
    showToast("素材已删除");
    const job = await api(`/api/jobs/${jobId}`);
    renderJob(job);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function openDraft() {
  if (!activeJobId) return;
  try {
    const result = await api(`/api/jobs/${activeJobId}/open-draft`, { method: "POST" });
    showToast(result.manual_export_hint || result.message || "已请求启动剪映", !result.ok);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function resumeJob() {
  if (!activeJobId) return;
  try {
    await api(`/api/jobs/${activeJobId}/resume`, { method: "POST" });
    showToast("任务已重新入队");
    startPolling();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function submitManual(event) {
  event.preventDefault();
  const input = $("#manualVideo");
  if (!activeJobId || !input.files.length) {
    showToast("请选择剪映导出的视频", true);
    return;
  }
  const form = new FormData();
  form.append("video", input.files[0]);
  try {
    await api(`/api/jobs/${activeJobId}/manual-export`, { method: "POST", body: form });
    showToast("成片已回传，开始执行 QC");
    startPolling();
  } catch (error) {
    showToast(error.message, true);
  }
}

function bindEvents() {
  $("#jobForm").addEventListener("submit", submitJob);
  $("#smartSettingsForm").addEventListener("submit", saveSmartSettings);
  $("#manualForm").addEventListener("submit", submitManual);
  $("#themeToggle").addEventListener("click", toggleTheme);
  $("#subtitleMode").addEventListener("change", modeChanged);
  $("#openDraftButton").addEventListener("click", openDraft);
  $("#resumeButton").addEventListener("click", resumeJob);
  $("#deleteJobButton").addEventListener("click", () => activeJobId && deleteJob(activeJobId));
  $("#clearSmartKeys").addEventListener("click", clearSmartKeys);
  $("#testQwenButton").addEventListener("click", async () => {
    const feedback = $("#configFeedback");
    feedback.textContent = "正在测试千问连接...";
    try {
      const result = await api("/api/settings/smart-audio/test", {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
      feedback.textContent = result.message;
      showToast(result.message, !result.ok);
    } catch (error) {
      feedback.textContent = error.message;
      showToast(error.message, true);
    }
  });
  $("#refreshJobs").addEventListener("click", loadHistory);
  $("#manualVideo").addEventListener("change", () => {
    $("#manualFileName").textContent = $("#manualVideo").files[0]?.name || "选择剪映导出的成片";
  });
  $("#modeHelp").addEventListener("click", () => {
    showToast("Whisper 适合无文本稿；文本稿适合台词已确定；原生识别仅作实验增强。");
  });
  $$(".reveal-secret").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.target);
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      button.textContent = reveal ? "隐藏" : "显示";
    });
  });
  $$(".rail-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  $$(".mobile-nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.mobileView));
  });
  $$("[data-view-link]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      switchView(link.dataset.viewLink);
    });
  });
  window.addEventListener("hashchange", () => {
    switchView(location.hash.replace("#", ""), false);
  });
}

async function boot() {
  const forcedTheme = new URLSearchParams(location.search).get("theme");
  applyTheme(forcedTheme === "dark" ? "dark" : forcedTheme === "light" ? "light" : document.documentElement.dataset.theme || "light");
  const requestedJob = new URLSearchParams(location.search).get("job");
  if (requestedJob) {
    activeJobId = requestedJob;
    localStorage.setItem("cutflow.activeJob", activeJobId);
  }
  bindDropzone();
  bindEvents();
  modeChanged();
  const requestedView = location.hash.replace("#", "");
  switchView(["create", "tasks", "system"].includes(requestedView) ? requestedView : "create", false);
  await Promise.all([loadHealth(), loadHistory(), loadFeatureStatus()]);
  if (activeJobId) {
    try {
      const job = await api(`/api/jobs/${activeJobId}`);
      renderJob(job);
      if (["QUEUED", "RUNNING"].includes(job.state)) startPolling();
    } catch {
      activeJobId = null;
      localStorage.removeItem("cutflow.activeJob");
      renderEmptyTask();
    }
  }
}

if (IS_LOCAL_APP) {
  boot();
} else {
  const gate = $("#launchGate");
  gate.hidden = false;
  document.querySelector("main").hidden = true;
  document.querySelector(".rail").hidden = true;
  document.querySelector(".topbar").hidden = true;
  const launchButton = gate.querySelector(".launch-button");
  launchButton.href = LOCAL_APP_URL;
  if (new URLSearchParams(location.search).get("launch") === "1") {
    setTimeout(() => location.replace(LOCAL_APP_URL), 900);
  }
}
