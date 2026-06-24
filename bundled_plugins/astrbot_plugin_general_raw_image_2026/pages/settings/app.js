const bridge = window.AstrBotPluginPage;
const PALETTE_KEY = "general_raw_image_palette_mode";
const APPEARANCE_KEY = "general_raw_image_appearance_mode";
const BACKGROUND_IMAGE_KEY = "general_raw_image_custom_background";
const BACKGROUND_MODE_KEY = "general_raw_image_background_mode";
const PALETTE_MODES = ["luxury", "bluewhite", "vivid", "void"];
const APPEARANCE_MODES = ["auto", "dark", "light"];
const PALETTE_LABELS = { luxury: "鎏金", bluewhite: "冰蓝", vivid: "霓虹", void: "暗涌" };
const APPEARANCE_LABELS = { auto: "自动", dark: "深色", light: "浅色" };
const TAB_META = {
  welcome: ["选择一个配置区，开始调校生图系统", "默认不会展开任何配置项。请从左侧选择生成任务流、供应商矩阵、权限额度或工具调用桥。"],
  generation: ["生成任务流", "配置模型、并发、默认比例、回复模板与开始绘图回复图片。"],
  providers: ["供应商矩阵", "配置一个或多个图像生成供应商；按供应商卡片管理模型、密钥、能力与重试策略。"],
  limits: ["权限与额度", "配置会话黑名单、白名单、频率限制、每日额度与参考图大小。"],
  tools: ["工具调用桥", "控制是否允许 LLM 调用生图工具。"],
  raw: ["原始配置", "高级用户可核对当前完整配置。"],
};
const state = { schema: {}, config: {}, activeTab: "welcome" };
const BOOT_MIN_MS = 4000;
const els = {
  boot: document.getElementById("bootSequence"),
  toast: document.getElementById("toastLayer"),
  saveAllBtn: document.getElementById("saveAllBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  providerCount: document.getElementById("providerCount"),
  imageCount: document.getElementById("imageCount"),
  currentModel: document.getElementById("currentModel"),
  startImageState: document.getElementById("startImageState"),
  limitState: document.getElementById("limitState"),
  panelTitle: document.getElementById("panelTitle"),
  panelHint: document.getElementById("panelHint"),
  cursorGlow: document.querySelector(".cursor-glow"),
};
const panels = Object.fromEntries([...document.querySelectorAll(".panel")].map(x => [x.id, x]));
let paletteMode = "luxury";
let appearanceMode = "auto";
let customBackgroundUrl = "";
let bootClosed = false;
let bootStartedAt = performance.now();
let bootCloseTimer = null;
let pointerFrame = 0;
let liquidFrame = 0;
let pendingPointerEvent = null;
let pendingLiquidEvent = null;

function showToast(message) {
  if (!els.toast) {
    console.warn(message);
    return;
  }
  els.toast.textContent = message;
  els.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove("show"), 2800);
}
function unwrap(response) {
  if (response && typeof response === "object" && Object.prototype.hasOwnProperty.call(response, "ok")) {
    if (!response.ok) throw new Error(response.message || response.error || "请求失败");
    return Object.prototype.hasOwnProperty.call(response, "data") ? response.data : response;
  }
  return response;
}
async function apiGet(endpoint, params) {
  if (!bridge?.apiGet) throw new Error("无法获取 AstrBotPluginPage.apiGet");
  return unwrap(await bridge.apiGet(endpoint, params));
}
async function apiPost(endpoint, body) {
  if (!bridge?.apiPost) throw new Error("无法获取 AstrBotPluginPage.apiPost");
  return unwrap(await bridge.apiPost(endpoint, body));
}
function escapeHtml(value) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, m => map[m]);
}
function cloneValue(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
function metaDefault(meta) {
  if (Object.prototype.hasOwnProperty.call(meta || {}, "default")) return cloneValue(meta.default);
  const type = meta?.type;
  if (type === "bool") return false;
  if (type === "int" || type === "float") return 0;
  if (type === "list" || type === "template_list") return [];
  if (type === "object") return {};
  return "";
}
function getByPath(path) { return path.reduce((obj, key) => obj?.[key], state.config); }
function setByPath(path, value) {
  let obj = state.config;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (!obj[key] || typeof obj[key] !== "object") obj[key] = typeof path[i + 1] === "number" ? [] : {};
    obj = obj[key];
  }
  obj[path.at(-1)] = value;
  updateMetrics();
  renderRaw();
}
function fieldId(path) { return "f_" + path.map(x => String(x).replace(/[^a-zA-Z0-9_-]/g, "_")).join("_"); }
function card(title, body, hint = "") {
  return `<section class="card pui-enter"><h3>${escapeHtml(title)}</h3>${hint ? `<p class="input-hint">${escapeHtml(hint)}</p>` : ""}${body}</section>`;
}
function fieldWrap(meta, inner, wide = false) {
  return `<div class="field pui-field ${wide ? "wide" : ""}"><div class="label">${escapeHtml(meta.description || "")}</div>${meta.hint ? `<div class="hint">${escapeHtml(meta.hint)}</div>` : ""}${inner}</div>`;
}
function bindInput(path, parse = x => x) {
  const el = document.getElementById(fieldId(path));
  if (!el) return;
  el.addEventListener("input", () => setByPath(path, parse(el.value)));
  el.addEventListener("change", () => setByPath(path, parse(el.value)));
}
function renderScalar(path, meta, value) {
  const id = fieldId(path);
  const type = meta.type || "string";
  if (type === "bool") {
    return fieldWrap(meta, `<label class="switch-row"><span class="switch"><input id="${id}" type="checkbox" ${value === true ? "checked" : ""}/><span class="switch-track"></span><span class="switch-thumb"></span></span><b>${value === true ? "已开启" : "关闭"}</b></label>`);
  }
  if (meta.options && Array.isArray(meta.options) && type !== "list") {
    return fieldWrap(meta, `<select id="${id}">${meta.options.map(o => `<option value="${escapeHtml(o)}" ${String(value) === String(o) ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}</select>`);
  }
  if (type === "text") return fieldWrap(meta, `<textarea id="${id}">${escapeHtml(value ?? "")}</textarea>`, true);
  const inputType = (type === "int" || type === "float") ? "number" : "text";
  const attrs = meta.slider ? ` min="${meta.slider.min}" max="${meta.slider.max}" step="${meta.slider.step}"` : "";
  return fieldWrap(meta, `<input id="${id}" type="${inputType}" value="${escapeHtml(value ?? "")}"${attrs}/>`);
}
function bindScalar(path, meta) {
  const el = document.getElementById(fieldId(path));
  if (!el) return;
  if (meta.type === "bool") {
    el.addEventListener("change", () => {
      setByPath(path, el.checked);
      const label = el.closest("label")?.querySelector("b");
      if (label) label.textContent = el.checked ? "已开启" : "关闭";
    });
    return;
  }
  const parse = meta.type === "int" ? v => Number.parseInt(v || "0", 10) : meta.type === "float" ? v => Number.parseFloat(v || "0") : v => v;
  bindInput(path, parse);
}
function renderList(path, meta, value) {
  const list = Array.isArray(value) ? value : [];
  if (Array.isArray(meta.options)) {
    return fieldWrap(meta, `<div class="chips">${meta.options.map(o => `<label class="chip"><input type="checkbox" data-list-check="${escapeHtml(fieldId(path))}" value="${escapeHtml(o)}" ${list.includes(o) ? "checked" : ""}/>${escapeHtml(o)}</label>`).join("")}</div>`, true);
  }
  return fieldWrap(meta, `<div class="list-editor" id="${fieldId(path)}">${list.map((v, i) => `<div class="list-row"><input value="${escapeHtml(v)}" data-index="${i}"/><button type="button" data-remove="${i}">删除</button></div>`).join("")}<button type="button" data-add>添加一项</button></div>`, true);
}
function bindList(path, meta) {
  if (Array.isArray(meta.options)) {
    document.querySelectorAll(`[data-list-check="${fieldId(path)}"]`).forEach(input => input.addEventListener("change", () => {
      const values = [...document.querySelectorAll(`[data-list-check="${fieldId(path)}"]:checked`)].map(item => item.value);
      setByPath(path, values);
    }));
    return;
  }
  const box = document.getElementById(fieldId(path));
  if (!box) return;
  const sync = () => setByPath(path, [...box.querySelectorAll("input[data-index]")].map(input => input.value).filter(Boolean));
  box.querySelectorAll("input[data-index]").forEach(input => input.addEventListener("input", sync));
  box.querySelectorAll("button[data-remove]").forEach(button => button.addEventListener("click", () => {
    const arr = [...(getByPath(path) || [])];
    arr.splice(Number(button.dataset.remove), 1);
    setByPath(path, arr);
    renderAll();
  }));
  box.querySelector("[data-add]")?.addEventListener("click", () => {
    const arr = [...(getByPath(path) || []), ""];
    setByPath(path, arr);
    renderAll();
  });
}
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}
function chooseImageFile() {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.hidden = true;
    document.body.appendChild(input);
    input.addEventListener("change", () => { const file = input.files?.[0] || null; input.remove(); resolve(file); }, { once: true });
    input.click();
  });
}
async function uploadImageOnly(file) {
  if (!file) return "";
  if (!String(file.type || "").startsWith("image/")) throw new Error("请选择图片文件");
  const data = await apiPost("settings-v2/image/upload", { filename: file.name, content_type: file.type, data: await readFile(file) });
  return data.path || "";
}
function renderImagePathField(path, meta, value) {
  const id = fieldId(path);
  const selected = Array.isArray(value)
    ? String(value.find(item => String(item || "").trim()) || "").trim()
    : String(value || "").trim();
  const label = selected ? selected.split(/[\\/]/).pop() || selected : "未选择图片";
  return fieldWrap(meta, `<div class="image-picker" id="${id}" data-value="${escapeHtml(selected)}"><div class="selected-file">${escapeHtml(label)}</div><div class="actions"><button type="button" class="primary" data-image-pick="${id}">${selected ? "重新选择图片" : "选择图片"}</button><button type="button" data-clear-image="${id}" ${selected ? "" : "disabled"}>清空</button></div></div>`, true);
}
function bindImagePathField(path) {
  const id = fieldId(path);
  const box = document.getElementById(id);
  if (!box) return;
  document.querySelector(`[data-image-pick="${id}"]`)?.addEventListener("click", async () => {
    try {
      const picked = await chooseImageFile();
      if (!picked) return;
      const imagePath = await uploadImageOnly(picked);
      setByPath(path, imagePath ? [imagePath] : []);
      renderAll();
      showToast("图片已选择，请保存全部配置");
    } catch (error) { showToast("选图失败：" + error.message); }
  });
  document.querySelector(`[data-clear-image="${id}"]`)?.addEventListener("click", () => { setByPath(path, []); renderAll(); });
}
function renderImagePathList(path, meta, value) {
  const list = Array.isArray(value) ? value : [];
  const id = fieldId(path);
  return fieldWrap(meta, `<div class="list-editor image-list" id="${id}">${list.map((v, i) => `<div class="list-row"><span class="selected-file">${escapeHtml(String(v || "").split(/[\\/]/).pop() || v)}</span><button type="button" data-replace="${i}">重选图片</button><button type="button" data-remove="${i}">删除</button></div>`).join("")}<button type="button" class="primary" data-pick-add>选择图片添加</button></div>`, true);
}
function bindImagePathList(path) {
  const box = document.getElementById(fieldId(path));
  if (!box) return;
  box.querySelectorAll("[data-remove]").forEach(button => button.addEventListener("click", () => {
    const arr = [...(getByPath(path) || [])];
    arr.splice(Number(button.dataset.remove), 1);
    setByPath(path, arr);
    renderAll();
  }));
  box.querySelectorAll("[data-replace]").forEach(button => button.addEventListener("click", async () => {
    try {
      const picked = await chooseImageFile();
      if (!picked) return;
      const imagePath = await uploadImageOnly(picked);
      const arr = [...(getByPath(path) || [])];
      arr[Number(button.dataset.replace)] = imagePath;
      setByPath(path, arr);
      renderAll();
      showToast("图片已重新选择，请保存全部配置");
    } catch (error) { showToast("选图失败：" + error.message); }
  }));
  box.querySelector("[data-pick-add]")?.addEventListener("click", async () => {
    try {
      const picked = await chooseImageFile();
      if (!picked) return;
      const imagePath = await uploadImageOnly(picked);
      setByPath(path, [...(getByPath(path) || []), imagePath]);
      renderAll();
      showToast("图片已添加到列表，请保存全部配置");
    } catch (error) { showToast("选图失败：" + error.message); }
  });
}
function isStartImagePath(basePath, key) { return basePath.length === 1 && basePath[0] === "generation" && key === "start_task_image_path"; }
function isStartImageList(basePath, key) { return basePath.length === 1 && basePath[0] === "generation" && key === "start_task_image_paths"; }
function renderObjectFields(container, basePath, schemaItems, data) {
  container.innerHTML += `<div class="form-grid">${Object.entries(schemaItems || {}).map(([key, meta]) => {
    const path = [...basePath, key];
    const value = data?.[key] ?? metaDefault(meta);
    if (isStartImagePath(basePath, key)) return renderImagePathField(path, meta, value);
    if (isStartImageList(basePath, key)) return renderImagePathList(path, meta, value);
    if (meta.type === "list") return renderList(path, meta, value);
    if (meta.type === "object") return fieldWrap(meta, `<div class="form-grid" id="${fieldId(path)}"></div>`, true);
    return renderScalar(path, meta, value);
  }).join("")}</div>`;
  Object.entries(schemaItems || {}).forEach(([key, meta]) => {
    const path = [...basePath, key];
    if (isStartImagePath(basePath, key)) bindImagePathField(path);
    else if (isStartImageList(basePath, key)) bindImagePathList(path);
    else if (meta.type === "list") bindList(path, meta);
    else if (meta.type === "object") renderObjectFields(document.getElementById(fieldId(path)), path, meta.items || {}, getByPath(path) || {});
    else bindScalar(path, meta);
  });
}
function templateDefaults(templateKey) {
  const tpl = state.schema.api_providers.templates[templateKey];
  const obj = { __template_key: templateKey };
  Object.entries(tpl.items || {}).forEach(([key, meta]) => { obj[key] = metaDefault(meta); });
  return obj;
}
function renderProviders() {
  const root = panels.providers;
  const meta = state.schema.api_providers;
  const providers = Array.isArray(state.config.api_providers) ? state.config.api_providers : [];
  root.innerHTML = card(meta.description, `<div class="path-head"><p>${escapeHtml(meta.hint || "")}</p><div class="path-actions"><select id="templateSelect" class="input-field">${Object.entries(meta.templates || {}).map(([key, tpl]) => `<option value="${escapeHtml(key)}">${escapeHtml(tpl.name || key)}</option>`).join("")}</select><button id="addProvider" class="btn btn-primary compact" type="button">新增供应商</button></div></div><div id="providerList"></div>`);
  const list = document.getElementById("providerList");
  providers.forEach((provider, index) => {
    const key = provider.__template_key || Object.keys(meta.templates || {})[0];
    const tpl = meta.templates[key] || {};
    const item = document.createElement("div");
    item.className = "provider-card pui-enter";
    item.innerHTML = `<div class="provider-top"><div class="provider-title"><span class="template-badge">${escapeHtml(tpl.name || key)}</span><b>${escapeHtml(provider.name || "未命名供应商")}</b></div><div class="provider-actions"><button data-dup="${index}" type="button">复制</button><button data-del="${index}" class="danger" type="button">删除</button></div></div>`;
    list.appendChild(item);
    renderObjectFields(item, ["api_providers", index], tpl.items || {}, provider);
  });
  document.getElementById("addProvider")?.addEventListener("click", () => {
    const key = document.getElementById("templateSelect").value;
    state.config.api_providers = [...(state.config.api_providers || []), templateDefaults(key)];
    renderAll();
  });
  root.querySelectorAll("[data-del]").forEach(button => button.addEventListener("click", () => { state.config.api_providers.splice(Number(button.dataset.del), 1); renderAll(); }));
  root.querySelectorAll("[data-dup]").forEach(button => button.addEventListener("click", () => { const index = Number(button.dataset.dup); state.config.api_providers.splice(index + 1, 0, cloneValue(state.config.api_providers[index])); renderAll(); }));
}
function renderSection(id, titleKey, configKey) {
  const root = panels[id];
  const meta = state.schema[titleKey];
  root.innerHTML = card(meta.description, `<div class="section-stack" id="${id}Fields"></div>`, meta.hint);
  renderObjectFields(document.getElementById(`${id}Fields`), [configKey], meta.items || {}, state.config[configKey] || {});
}
function renderTools() {
  const root = panels.tools;
  const meta = state.schema.enable_llm_tool;
  root.innerHTML = card(meta.description, `<div class="form-grid">${renderList(["enable_llm_tool"], meta, state.config.enable_llm_tool || [])}</div>`, meta.hint);
  bindList(["enable_llm_tool"], meta);
}
function renderWelcome() {
  const root = panels.welcome;
  if (!root) return;
  root.innerHTML = `
    <section class="welcome-stage pui-enter">
      <div class="welcome-orb" aria-hidden="true"></div>
      <div class="welcome-badge">GENERAL RAW IMAGE 2026</div>
      <h2>选一个配置区，开始调校生图系统</h2>
      <p>默认进入设置页时不会打开任何配置项。当前主题、明暗模式和配色会自动作用到这个开始页面。</p>
    </section>`;
}
function renderRaw() {
  if (!panels.raw) return;
  panels.raw.innerHTML = card("原始 JSON", `<pre class="raw-json">${escapeHtml(JSON.stringify(state.config, null, 2))}</pre>`, "高级用户可复制核对当前配置。");
}
function refreshPanelMotion() {
  const activePanel = panels[state.activeTab];
  if (!activePanel) return;
  activePanel.querySelectorAll(".pui-enter, .pui-field, .provider-card").forEach((node, index) => {
    node.style.setProperty("--enter-index", String(Math.min(index, 18)));
    node.classList.remove("is-visible");
  });
  requestAnimationFrame(() => {
    activePanel.querySelectorAll(".pui-enter, .pui-field, .provider-card").forEach(node => node.classList.add("is-visible"));
  });
}
function updateMetrics() {
  const imageList = state.config.generation?.start_task_image_paths || [];
  const singleImage = state.config.generation?.start_task_image_path;
  const totalImages = (singleImage ? 1 : 0) + (Array.isArray(imageList) ? imageList.length : 0);
  els.providerCount.textContent = (state.config.api_providers || []).length;
  els.imageCount.textContent = totalImages;
  els.currentModel.textContent = state.config.generation?.model || "未设置";
  els.startImageState.textContent = totalImages ? `${totalImages} 张` : "未设置";
  els.limitState.textContent = state.config.user_limits?.enable_usage_limits ? "已启用" : "未启用";
}
function renderAll() {
  renderWelcome();
  renderProviders();
  renderSection("generation", "generation", "generation");
  renderSection("limits", "user_limits", "user_limits");
  renderTools();
  renderRaw();
  updateMetrics();
  switchTab(state.activeTab);
  refreshPanelMotion();
}
function switchTab(tab) {
  state.activeTab = tab;
  document.body.dataset.activeTab = tab;
  document.querySelectorAll(".group-item[data-tab]").forEach(item => item.classList.toggle("active", item.dataset.tab === tab));
  Object.entries(panels).forEach(([id, panel]) => { panel.style.display = id === tab ? "block" : "none"; panel.classList.toggle("active", id === tab); });
  const [title, hint] = TAB_META[tab] || TAB_META.welcome;
  els.panelTitle.textContent = title;
  els.panelHint.textContent = hint;
  refreshPanelMotion();
}
function applyPalette(mode = "luxury") {
  paletteMode = PALETTE_MODES.includes(mode) ? mode : "luxury";
  document.documentElement.dataset.palette = paletteMode;
  document.getElementById("paletteModeLabel").textContent = PALETTE_LABELS[paletteMode] || "鎏金";
}
async function saveUiState(patch) {
  try {
    const data = await apiPost("settings-v2/ui-state", patch);
    return data.state || patch;
  } catch (error) {
    showToast("界面状态保存失败：" + error.message);
    return patch;
  }
}
async function loadUiState() {
  try {
    const data = await apiGet("settings-v2/ui-state");
    const ui = data.state || {};
    applyPalette(ui.palette_mode || "luxury");
    applyAppearance(ui.appearance_mode || "auto");
    applyCustomBackground(ui.custom_background_url || "", ui.background_mode || "preset");
  } catch (error) {
    console.warn("loadUiState failed", error);
    applyPalette("luxury");
    applyAppearance("auto");
    applyCustomBackground("", "preset");
  }
}
function resolveAppearance(mode) {
  if (mode === "light" || mode === "dark") return mode;
  return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
}
function applyAppearance(mode = "auto") {
  appearanceMode = APPEARANCE_MODES.includes(mode) ? mode : "auto";
  document.documentElement.dataset.appearance = appearanceMode;
  document.documentElement.dataset.theme = resolveAppearance(appearanceMode);
  document.getElementById("appearanceModeLabel").textContent = APPEARANCE_LABELS[appearanceMode] || "自动";
}
async function cyclePalette() {
  const i = PALETTE_MODES.indexOf(paletteMode);
  applyPalette(PALETTE_MODES[(i + 1) % PALETTE_MODES.length]);
  await saveUiState({ palette_mode: paletteMode });
}
async function cycleAppearance() {
  const i = APPEARANCE_MODES.indexOf(appearanceMode);
  applyAppearance(APPEARANCE_MODES[(i + 1) % APPEARANCE_MODES.length]);
  await saveUiState({ appearance_mode: appearanceMode });
}
function setBackgroundModeLabel() {
  const label = document.getElementById("backgroundModeLabel");
  if (!label) return;
  const hasCustom = Boolean(customBackgroundUrl);
  const isCustom = document.documentElement.dataset.backgroundMode === "custom";
  label.textContent = isCustom ? "上传" : (hasCustom ? "自定义" : "上传");
}
function applyCustomBackground(url = "", mode = "preset") {
  customBackgroundUrl = url || "";
  const useCustom = mode === "custom" && Boolean(customBackgroundUrl);
  if (useCustom) {
    document.documentElement.dataset.backgroundMode = "custom";
    const cssUrl = String(customBackgroundUrl).startsWith("data:")
      ? `url(${customBackgroundUrl})`
      : `url("${customBackgroundUrl}")`;
    document.documentElement.style.setProperty("--custom-bg-image", cssUrl);
  } else {
    document.documentElement.dataset.backgroundMode = "preset";
    document.documentElement.style.removeProperty("--custom-bg-image");
  }
  setBackgroundModeLabel();
}
async function handleBackgroundButton() {
  const currentMode = document.documentElement.dataset.backgroundMode || "preset";
  if (currentMode === "preset" && customBackgroundUrl) {
    applyCustomBackground(customBackgroundUrl, "custom");
    await saveUiState({ background_mode: "custom", custom_background_url: customBackgroundUrl });
    showToast("已切换到自定义背景");
    return;
  }
  document.getElementById("customBackgroundInput")?.click();
}
async function handleBackgroundUpload(event) {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = "";
  if (!file) return;
  try {
    const data = await apiPost("settings-v2/background/upload", {
      filename: file.name,
      content_type: file.type,
      data: await readFile(file),
    });
    const ui = data.state || {};
    applyCustomBackground(data.url || ui.custom_background_url || "", "custom");
    showToast("背景已上传并切换到自定义模式");
  } catch (error) {
    showToast("背景上传失败：" + error.message);
  }
}
async function load() {
  const data = await apiGet("settings-v2/bootstrap");
  state.schema = data.schema || {};
  state.config = data.config || {};
  state.config.generation ||= {};
  state.config.user_limits ||= {};
  state.config.api_providers ||= [];
  renderAll();
  showToast("配置已加载");
  requestCloseBoot();
}
async function saveAll() {
  els.saveAllBtn.disabled = true;
  try {
    const data = await apiPost("settings-v2/config", { config: state.config });
    state.config = data.config || state.config;
    renderAll();
    showToast("全部配置已保存");
  } catch (error) {
    showToast("保存失败：" + error.message);
  } finally {
    els.saveAllBtn.disabled = false;
  }
}
function boot() {
  bootStartedAt = performance.now();
  loadUiState();
  bindPointerGlow();
  bindLiquidHover();
  bootCloseTimer = window.setTimeout(closeBoot, BOOT_MIN_MS);
  document.querySelectorAll(".group-item[data-tab]").forEach(item => item.addEventListener("click", () => switchTab(item.dataset.tab)));
  document.querySelectorAll(".contact-section-head").forEach(btn => btn.addEventListener("click", () => btn.closest(".contact-section")?.classList.toggle("collapsed")));
  document.getElementById("paletteToggleBtn")?.addEventListener("click", cyclePalette);
  document.getElementById("appearanceToggleBtn")?.addEventListener("click", cycleAppearance);
  document.getElementById("customBackgroundBtn")?.addEventListener("click", handleBackgroundButton);
  document.getElementById("customBackgroundInput")?.addEventListener("change", handleBackgroundUpload);
  document.getElementById("presetBackgroundBtn")?.addEventListener("click", async () => { applyCustomBackground(customBackgroundUrl, "preset"); await saveUiState({ background_mode: "preset", custom_background_url: customBackgroundUrl }); showToast("已切换到预设配色背景"); });
  els.reloadBtn?.addEventListener("click", () => load().catch(error => showToast(error.message)));
  els.saveAllBtn?.addEventListener("click", saveAll);
  switchTab(state.activeTab);
  window.setTimeout(() => document.body.classList.add("boot-warmed"), 240);
  load().catch(error => {
    requestCloseBoot();
    showToast("加载失败：" + error.message);
  });
}
function requestCloseBoot() {
  const elapsed = performance.now() - bootStartedAt;
  const delay = Math.max(0, BOOT_MIN_MS - elapsed);
  window.clearTimeout(bootCloseTimer);
  bootCloseTimer = window.setTimeout(closeBoot, delay);
}
function closeBoot() {
  if (bootClosed) return;
  bootClosed = true;
  document.body.classList.add("app-ready");
  window.setTimeout(() => els.boot?.remove(), 900);
}
function bindPointerGlow() {
  const update = event => {
    if (!els.cursorGlow) return;
    els.cursorGlow.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0) translate3d(-50%, -50%, 0)`;
  };
  window.addEventListener("pointermove", event => {
    pendingPointerEvent = event;
    if (pointerFrame) return;
    pointerFrame = window.requestAnimationFrame(() => {
      pointerFrame = 0;
      if (pendingPointerEvent) update(pendingPointerEvent);
    });
  }, { passive: true });
}
function bindLiquidHover() {
  const selector = ".brand-card, .group-item, .dock-button, .hero-card, .stat-grid div, .toast, .confirm-box";
  const glow = document.createElement("span");
  glow.className = "glass-follow-layer";
  let activeTarget = null;
  const hide = () => glow.classList.remove("is-live");
  const update = event => {
    const target = event.target?.closest?.(selector);
    if (!target) {
      hide();
      return;
    }
    if (activeTarget !== target) {
      activeTarget = target;
      target.appendChild(glow);
    }
    const rect = target.getBoundingClientRect();
    glow.style.transform = `translate3d(${event.clientX - rect.left}px, ${event.clientY - rect.top}px, 0) translate3d(-50%, -50%, 0)`;
    glow.classList.add("is-live");
  };
  window.addEventListener("pointermove", event => {
    pendingLiquidEvent = event;
    if (liquidFrame) return;
    liquidFrame = window.requestAnimationFrame(() => {
      liquidFrame = 0;
      if (pendingLiquidEvent) update(pendingLiquidEvent);
    });
  }, { passive: true });
  window.addEventListener("pointerleave", hide, { passive: true });
  window.addEventListener("blur", hide);
}
boot();
