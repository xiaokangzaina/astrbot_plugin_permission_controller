import { createApi } from "./api.js";

const bridge = window.AstrBotPluginPage;
const root = document.documentElement;
const mediaQuery = typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;

const THEME_KEY = "permission-console-theme";
const REASONING_LABELS = {
  "": "默认",
  low: "低",
  medium: "中",
  high: "高",
};

const previewGroups = [
  {
    group_id: "1012112971",
    group_name: "ruoli",
    avatar: "",
    member_count: 461,
    source: "preview",
    group_enabled: true,
    reasoning_effort: "high",
    reasoning_label: "高",
    config_updated_at: Date.now(),
  },
  {
    group_id: "419045768",
    group_name: "Susfs4ksu交流群/NSFW",
    avatar: "",
    member_count: 1982,
    source: "preview",
    group_enabled: false,
    reasoning_effort: "",
    reasoning_label: "默认",
  },
  {
    group_id: "883640898",
    group_name: "Codex交流群",
    avatar: "",
    member_count: 200,
    source: "preview",
    group_enabled: true,
    reasoning_effort: "medium",
    reasoning_label: "中",
    config_updated_at: Date.now() - 80000,
  },
];

const previewPrivates = [
  {
    user_id: "10001",
    nickname: "测试好友",
    avatar: "",
    source: "preview",
    private_enabled: true,
    reasoning_effort: "low",
    reasoning_label: "低",
  },
  {
    user_id: "10002",
    nickname: "未配置好友",
    avatar: "",
    source: "preview",
    private_enabled: false,
    reasoning_effort: "",
    reasoning_label: "默认",
  },
];

let api = null;
let previewMode = false;
let groups = [];
let privateContacts = [];
let bootstrapConfig = {};
let selected = null;
let activeMode = "groups";
let themePreference = loadThemePreference();

const els = {
  themeText: document.getElementById("themeText"),
  toggleThemeBtn: document.getElementById("toggleThemeBtn"),
  refreshGroupsBtn: document.getElementById("refreshGroupsBtn"),
  resetGroupBtn: document.getElementById("resetGroupBtn"),
  saveGroupBtn: document.getElementById("saveGroupBtn"),
  groupTabBtn: document.getElementById("groupTabBtn"),
  privateTabBtn: document.getElementById("privateTabBtn"),
  search: document.getElementById("groupSearchInput"),
  listTitle: document.getElementById("listTitle"),
  listCount: document.getElementById("listCount"),
  targetCount: document.getElementById("targetCountLabel"),
  groupList: document.getElementById("groupList"),
  groupCount: document.getElementById("groupCountLabel"),
  privateCount: document.getElementById("privateCountLabel"),
  pulse: document.getElementById("permissionPulseLabel"),
  bridge: document.getElementById("bridgeStateLabel"),
  time: document.getElementById("currentTimeLabel"),
  runtimeClock: document.getElementById("runtimeClockLabel"),
  date: document.getElementById("currentDateLabel"),
  system: document.getElementById("systemVersionLabel"),
  python: document.getElementById("pythonVersionLabel"),
  weather: document.getElementById("weatherLabel"),
  weatherMeta: document.getElementById("weatherMetaLabel"),
  title: document.getElementById("currentGroupTitle"),
  meta: document.getElementById("currentGroupMeta"),
  metrics: document.getElementById("metricGrid"),
  form: document.getElementById("groupForm"),
  summary: document.getElementById("selectedSummary"),
  toastLayer: document.getElementById("toastLayer"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loadThemePreference() {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    if (["auto", "light", "dark"].includes(value)) return value;
  } catch {}
  return "auto";
}

function saveThemePreference() {
  try {
    window.localStorage.setItem(THEME_KEY, themePreference);
  } catch {}
  if (api) api.safePost("settings/theme", { theme: themePreference }).catch(() => {});
}

function effectiveTheme() {
  if (themePreference === "auto") return mediaQuery?.matches ? "dark" : "light";
  return themePreference;
}

function themeLabel() {
  if (themePreference === "dark") return "深色";
  if (themePreference === "light") return "浅色";
  return "自动";
}

function applyTheme() {
  root.setAttribute("data-theme", effectiveTheme());
  if (els.themeText) els.themeText.textContent = themeLabel();
}

async function loadThemeFromBackend() {
  if (!api) return;
  try {
    const data = await api.safeGet("settings/theme");
    if (["auto", "light", "dark"].includes(data?.theme)) {
      themePreference = data.theme;
    }
  } catch {}
}

function cycleTheme() {
  themePreference = themePreference === "auto" ? "light" : themePreference === "light" ? "dark" : "auto";
  applyTheme();
  saveThemePreference();
}

function toast(message, type = "success") {
  if (!els.toastLayer) return;
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  els.toastLayer.appendChild(node);
  window.setTimeout(() => node.remove(), 2800);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function listToTextarea(value) {
  return normalizeList(value).join("\n");
}

function parseReasoningMap(value) {
  const result = {};
  for (const item of normalizeList(value)) {
    const [rawTarget, rawEffort = ""] = item.split(/[=:：]/);
    const target = String(rawTarget || "").trim();
    const effort = normalizeReasoning(rawEffort);
    if (target && effort) result[target] = effort;
  }
  return result;
}

function normalizeReasoning(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["low", "l", "低"].includes(text)) return "low";
  if (["medium", "mid", "m", "中"].includes(text)) return "medium";
  if (["high", "h", "高", "超高", "最高"].includes(text)) return "high";
  return "";
}

function reasoningLabel(value) {
  return REASONING_LABELS[normalizeReasoning(value)] || "默认";
}

function groupName(item) {
  const id = String(item?.group_id || item?.id || "");
  return String(item?.group_name || item?.name || (id ? `群 ${id}` : "未知群聊"));
}

function privateName(item) {
  const id = String(item?.user_id || item?.id || "");
  return String(item?.remark || item?.nickname || item?.name || (id ? `好友 ${id}` : "未知好友"));
}

function avatarUrl(item, type) {
  if (item?.avatar) return item.avatar;
  const id = String(type === "groups" ? item?.group_id : item?.user_id || "");
  if (!id) return "./assets/brand-avatar.png";
  return type === "groups"
    ? `https://p.qlogo.cn/gh/${id}/${id}/640`
    : `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`;
}

function isGroupConfigured(item) {
  return Boolean(
    item?.group_enabled ||
      normalizeReasoning(item?.reasoning_effort) ||
      Number(item?.config_updated_at || 0) > 0 ||
      item?.source === "configured",
  );
}

function isPrivateConfigured(item) {
  return Boolean(item?.private_enabled || normalizeReasoning(item?.reasoning_effort));
}

function configuredCount() {
  return groups.filter(isGroupConfigured).length + privateContacts.filter(isPrivateConfigured).length;
}

function setButtonState(canEdit) {
  if (els.saveGroupBtn) els.saveGroupBtn.disabled = !canEdit;
  if (els.resetGroupBtn) els.resetGroupBtn.disabled = !canEdit;
}

function renderMetrics(items = []) {
  const payload = items.length
    ? items
    : [
        { label: "群聊", value: String(groups.length), meta: "已同步对象" },
        { label: "私聊", value: String(privateContacts.length), meta: "已同步好友" },
        { label: "已配置", value: String(configuredCount()), meta: "绿色高亮" , kind: "ok" },
        { label: "思考强度", value: selected ? reasoningLabel(selected.payload?.config?.reasoning_effort || selected.payload?.reasoning_effort) : "默认", meta: "当前对象" },
      ];
  els.metrics.innerHTML = payload
    .map(
      (item) => `
        <article class="metric-card ${item.kind || ""}">
          <span>${escapeHtml(item.label)}</span>
          <strong>${escapeHtml(item.value)}</strong>
          <em>${escapeHtml(item.meta)}</em>
        </article>
      `,
    )
    .join("");
}

function updateCounts() {
  if (els.groupCount) els.groupCount.textContent = String(groups.length);
  if (els.privateCount) els.privateCount.textContent = String(privateContacts.length);
  if (els.targetCount) els.targetCount.textContent = String(activeMode === "groups" ? groups.length : privateContacts.length);
  if (els.pulse) els.pulse.textContent = `+${configuredCount()} 项`;
  renderMetrics();
}

function makeAvatar(item, type) {
  const img = document.createElement("img");
  img.className = "avatar";
  img.src = avatarUrl(item, type);
  img.alt = "";
  img.loading = "lazy";
  img.onerror = () => {
    img.onerror = null;
    img.src = "./assets/brand-avatar.png";
  };
  return img;
}

function filteredObjects() {
  const query = String(els.search?.value || "").trim().toLowerCase();
  const source = activeMode === "groups" ? groups : privateContacts;
  return source.filter((item) => {
    if (!query) return true;
    const id = String(activeMode === "groups" ? item.group_id : item.user_id || "");
    const name = activeMode === "groups" ? groupName(item) : privateName(item);
    return `${id} ${name}`.toLowerCase().includes(query);
  });
}

function renderObjectList() {
  const list = filteredObjects();
  if (els.listTitle) els.listTitle.textContent = activeMode === "groups" ? "群聊对象" : "私聊对象";
  if (els.listCount) els.listCount.textContent = String(list.length);
  if (els.targetCount) els.targetCount.textContent = String(activeMode === "groups" ? groups.length : privateContacts.length);
  els.groupTabBtn?.classList.toggle("active", activeMode === "groups");
  els.privateTabBtn?.classList.toggle("active", activeMode === "privates");
  els.groupTabBtn?.setAttribute("aria-selected", activeMode === "groups" ? "true" : "false");
  els.privateTabBtn?.setAttribute("aria-selected", activeMode === "privates" ? "true" : "false");

  if (!list.length) {
    els.groupList.className = "object-list empty-state";
    els.groupList.textContent = activeMode === "groups" ? "没有匹配的群聊对象" : "没有匹配的私聊对象";
    return;
  }
  els.groupList.className = "object-list";
  els.groupList.textContent = "";
  for (const item of list) {
    const id = String(activeMode === "groups" ? item.group_id : item.user_id);
    const name = activeMode === "groups" ? groupName(item) : privateName(item);
    const configured = activeMode === "groups" ? isGroupConfigured(item) : isPrivateConfigured(item);
    const active = selected?.type === activeMode && selected?.id === id;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `object-item ${active ? "active" : ""} ${configured ? "is-configured" : ""}`;
    button.appendChild(makeAvatar(item, activeMode));
    const body = document.createElement("span");
    body.className = "object-body";
    const titleRow = document.createElement("span");
    titleRow.className = "object-title-row";
    titleRow.innerHTML = `<strong class="object-title">${escapeHtml(name)}</strong>`;
    const meta = document.createElement("span");
    meta.className = "object-meta";
    const size = activeMode === "groups" && item.member_count ? ` · ${item.member_count} 人` : "";
    meta.textContent = activeMode === "groups" ? `群号 ${id}${size}` : `QQ ${id}`;
    const status = document.createElement("span");
    status.className = "status-row";
    const modeText = activeMode === "groups"
      ? item.group_enabled ? "整群放行" : "默认策略"
      : item.private_enabled ? "私聊放行" : "默认策略";
    status.innerHTML = `
      <span class="status-pill ${configured ? "configured" : ""}">${configured ? "已配置" : "默认"}</span>
      <span class="status-pill">${escapeHtml(modeText)}</span>
      <span class="status-pill">思考 ${escapeHtml(reasoningLabel(item.reasoning_effort))}</span>
    `;
    body.append(titleRow, meta, status);
    button.appendChild(body);
    button.addEventListener("click", () => selectObject(activeMode, id));
    els.groupList.appendChild(button);
  }
}

function setMode(mode) {
  activeMode = mode === "privates" ? "privates" : "groups";
  selected = null;
  setButtonState(false);
  renderObjectList();
  renderWelcome();
}

function setSelectedSummary(title, lines) {
  if (!els.summary) return;
  els.summary.innerHTML = `
    <strong>${escapeHtml(title)}</strong>
    ${lines.map((line) => `<span>${escapeHtml(line)}</span>`).join("")}
  `;
}

function renderWelcome() {
  if (els.title) els.title.textContent = "请选择配置对象";
  if (els.meta) els.meta.textContent = "从左侧选择群聊或私聊对象后开始配置。";
  els.form.className = "form-stage empty-state";
  els.form.innerHTML = `
    <div class="welcome-panel">
      <span>Permission Console</span>
      <h3>选择一个对象，开始配置权限策略</h3>
      <p>已配置对象会在左侧以绿色高亮显示；默认配置或无配置对象保持普通样式。</p>
    </div>
  `;
  setSelectedSummary("未选择", ["等待选择配置对象"]);
  renderMetrics();
}

function makeToggle(id, title, hint, enabled) {
  return `
    <button class="toggle-card ${enabled ? "is-on" : ""}" id="${id}" type="button" data-enabled="${enabled ? "true" : "false"}" aria-pressed="${enabled ? "true" : "false"}">
      <span><strong>${escapeHtml(title)}</strong><span>${escapeHtml(hint)}</span></span>
      <i class="switch" aria-hidden="true"></i>
    </button>
  `;
}

function bindToggleCards(scope = document) {
  scope.querySelectorAll(".toggle-card").forEach((button) => {
    button.addEventListener("click", () => {
      const enabled = button.dataset.enabled !== "true";
      button.dataset.enabled = enabled ? "true" : "false";
      button.setAttribute("aria-pressed", String(enabled));
      button.classList.toggle("is-on", enabled);
    });
  });
}

function reasoningSelect(id, value) {
  const current = normalizeReasoning(value);
  return `
    <select id="${id}">
      ${Object.entries(REASONING_LABELS).map(([key, label]) => `<option value="${key}" ${key === current ? "selected" : ""}>${label}</option>`).join("")}
    </select>
  `;
}

function renderGroupForm(payload) {
  const info = payload.group_info || {};
  const config = payload.config || {};
  const id = String(info.group_id || selected?.id || "");
  const listInfo = groups.find((item) => String(item.group_id) === id) || {};
  const name = groupName({ ...listInfo, ...info });
  selected = { type: "groups", id, payload: { ...payload, reasoning_effort: config.reasoning_effort } };
  if (els.title) els.title.textContent = name;
  if (els.meta) els.meta.textContent = `群号 ${id} · ${config.group_enabled ? "整群放行已开启" : "默认策略"}`;
  setSelectedSummary(name, [
    `群号 ${id}`,
    `整群放行：${config.group_enabled ? "开启" : "关闭"}`,
    `思考强度：${reasoningLabel(config.reasoning_effort)}`,
  ]);
  els.form.className = "form-stage";
  els.form.innerHTML = `
    <div class="form-stack">
      <section class="form-card">
        <h3>群聊调用权限</h3>
        <p>只影响当前群聊对象。保存后该群会在左侧以绿色高亮显示。</p>
        <div class="field-grid">
          <div class="field full">
            ${makeToggle("groupEnabledInput", "开启整群放行", "允许该群整体调用机器人", Boolean(config.group_enabled))}
          </div>
          <label class="field">
            <span>允许用户 QQ</span>
            <textarea id="allowedUsersInput" placeholder="每行一个 QQ 号">${escapeHtml(listToTextarea(config.allowed_users))}</textarea>
          </label>
          <label class="field">
            <span>拒绝用户 QQ</span>
            <textarea id="deniedUsersInput" placeholder="每行一个 QQ 号">${escapeHtml(listToTextarea(config.denied_users))}</textarea>
          </label>
        </div>
      </section>
      <section class="form-card">
        <h3>思考强度</h3>
        <p>给当前群或群成员覆盖 reasoning_effort。</p>
        <div class="field-grid">
          <label class="field">
            <span>群默认强度</span>
            ${reasoningSelect("groupReasoningEffortInput", config.reasoning_effort)}
          </label>
          <label class="field full">
            <span>成员强度规则</span>
            <textarea id="reasoningUserRulesInput" placeholder="格式：用户QQ=high">${escapeHtml(listToTextarea(config.reasoning_user_rules))}</textarea>
          </label>
        </div>
      </section>
    </div>
  `;
  bindToggleCards(els.form);
  setButtonState(true);
  renderMetrics([
    { label: "对象", value: "群聊", meta: `群号 ${id}` },
    { label: "整群", value: config.group_enabled ? "开启" : "关闭", meta: "调用权限", kind: config.group_enabled ? "ok" : "" },
    { label: "允许", value: String(normalizeList(config.allowed_users).length), meta: "用户规则" },
    { label: "思考", value: reasoningLabel(config.reasoning_effort), meta: "群默认强度" },
  ]);
  renderObjectList();
}

function renderPrivateForm(payload) {
  const info = payload.contact_info || {};
  const config = payload.config || {};
  const id = String(info.user_id || selected?.id || "");
  const listInfo = privateContacts.find((item) => String(item.user_id) === id) || {};
  const name = privateName({ ...listInfo, ...info });
  selected = { type: "privates", id, payload: { ...payload, reasoning_effort: config.reasoning_effort } };
  if (els.title) els.title.textContent = name;
  if (els.meta) els.meta.textContent = `QQ ${id} · ${config.private_enabled ? "私聊权限已开启" : "默认策略"}`;
  setSelectedSummary(name, [
    `QQ ${id}`,
    `私聊权限：${config.private_enabled ? "开启" : "关闭"}`,
    `思考强度：${reasoningLabel(config.reasoning_effort)}`,
  ]);
  els.form.className = "form-stage";
  els.form.innerHTML = `
    <div class="form-stack">
      <section class="form-card">
        <h3>私聊调用权限</h3>
        <p>只影响当前好友，不会授予管理员权限。</p>
        <div class="field-grid">
          <div class="field full">
            ${makeToggle("privateEnabledInput", "开启私聊调用", "允许该好友私聊机器人", Boolean(config.private_enabled))}
          </div>
          <label class="field">
            <span>私聊思考强度</span>
            ${reasoningSelect("privateReasoningEffortInput", config.reasoning_effort)}
          </label>
        </div>
      </section>
    </div>
  `;
  bindToggleCards(els.form);
  setButtonState(true);
  renderMetrics([
    { label: "对象", value: "私聊", meta: `QQ ${id}` },
    { label: "权限", value: config.private_enabled ? "开启" : "关闭", meta: "私聊调用", kind: config.private_enabled ? "ok" : "" },
    { label: "思考", value: reasoningLabel(config.reasoning_effort), meta: "好友覆盖" },
    { label: "状态", value: config.private_enabled || config.reasoning_effort ? "已配置" : "默认", meta: "左侧标记", kind: config.private_enabled || config.reasoning_effort ? "ok" : "" },
  ]);
  renderObjectList();
}

function previewGroupPayload(group) {
  const id = String(group.group_id);
  return {
    group_info: group,
    config: {
      group_enabled: Boolean(group.group_enabled),
      allowed_users: group.group_enabled ? ["123456"] : [],
      denied_users: [],
      reasoning_effort: normalizeReasoning(group.reasoning_effort),
      reasoning_user_rules: [],
    },
  };
}

function previewPrivatePayload(contact) {
  return {
    contact_info: contact,
    config: {
      private_enabled: Boolean(contact.private_enabled),
      reasoning_effort: normalizeReasoning(contact.reasoning_effort),
    },
  };
}

async function selectObject(type, id) {
  activeMode = type;
  setButtonState(false);
  renderObjectList();
  if (previewMode || !api) {
    if (type === "groups") {
      renderGroupForm(previewGroupPayload(groups.find((item) => String(item.group_id) === id) || groups[0]));
    } else {
      renderPrivateForm(previewPrivatePayload(privateContacts.find((item) => String(item.user_id) === id) || privateContacts[0]));
    }
    return;
  }
  try {
    if (type === "groups") {
      renderGroupForm(await api.safeGet("settings/group", { group_id: id }));
    } else {
      renderPrivateForm(await api.safeGet("settings/private", { user_id: id }));
    }
  } catch (err) {
    toast(`加载对象失败：${err.message}`, "error");
    renderWelcome();
  }
}

function collectGroupForm() {
  return {
    group_enabled: document.getElementById("groupEnabledInput")?.dataset.enabled === "true",
    allowed_users: normalizeList(document.getElementById("allowedUsersInput")?.value),
    denied_users: normalizeList(document.getElementById("deniedUsersInput")?.value),
    reasoning_effort: normalizeReasoning(document.getElementById("groupReasoningEffortInput")?.value),
    reasoning_user_rules: normalizeList(document.getElementById("reasoningUserRulesInput")?.value),
  };
}

function collectPrivateForm() {
  return {
    private_enabled: document.getElementById("privateEnabledInput")?.dataset.enabled === "true",
    reasoning_effort: normalizeReasoning(document.getElementById("privateReasoningEffortInput")?.value),
  };
}

function mergeGroupListState(groupId, config) {
  const index = groups.findIndex((item) => String(item.group_id) === String(groupId));
  if (index < 0) return;
  groups[index] = {
    ...groups[index],
    group_enabled: Boolean(config.group_enabled),
    reasoning_effort: normalizeReasoning(config.reasoning_effort),
    reasoning_label: reasoningLabel(config.reasoning_effort),
    config_updated_at: Date.now(),
    source: groups[index].source || "configured",
  };
}

function mergePrivateListState(userId, config) {
  const index = privateContacts.findIndex((item) => String(item.user_id) === String(userId));
  if (index < 0) return;
  privateContacts[index] = {
    ...privateContacts[index],
    private_enabled: Boolean(config.private_enabled),
    reasoning_effort: normalizeReasoning(config.reasoning_effort),
    reasoning_label: reasoningLabel(config.reasoning_effort),
  };
}

async function saveCurrentConfig() {
  if (!selected) {
    toast("请先选择配置对象", "error");
    return;
  }
  if (previewMode || !api) {
    toast("预览模式不会写入真实配置");
    return;
  }
  els.saveGroupBtn.disabled = true;
  try {
    if (selected.type === "groups") {
      const config = collectGroupForm();
      const data = await api.safePost("settings/group", { group_id: selected.id, config });
      mergeGroupListState(selected.id, data.config || config);
      renderGroupForm(data);
      toast("群配置已保存");
    } else {
      const config = collectPrivateForm();
      const data = await api.safePost("settings/private", { user_id: selected.id, config });
      mergePrivateListState(selected.id, data.config || config);
      renderPrivateForm(data);
      toast("私聊配置已保存");
    }
    updateCounts();
  } catch (err) {
    toast(`保存失败：${err.message}`, "error");
  } finally {
    els.saveGroupBtn.disabled = false;
  }
}

async function resetCurrentConfig() {
  if (!selected) {
    toast("请先选择配置对象", "error");
    return;
  }
  const ok = window.confirm(selected.type === "groups" ? "确定清空该群配置？" : "确定关闭该好友私聊权限？");
  if (!ok) return;
  if (previewMode || !api) {
    toast("预览模式不会写入真实配置");
    return;
  }
  els.resetGroupBtn.disabled = true;
  try {
    if (selected.type === "groups") {
      const data = await api.safePost("settings/group/reset", { group_id: selected.id });
      mergeGroupListState(selected.id, data.config || {});
      renderGroupForm(data);
      toast("群配置已清空");
    } else {
      const data = await api.safePost("settings/private/reset", { user_id: selected.id });
      mergePrivateListState(selected.id, data.config || {});
      renderPrivateForm(data);
      toast("私聊权限已关闭");
    }
    updateCounts();
  } catch (err) {
    toast(`重置失败：${err.message}`, "error");
  } finally {
    els.resetGroupBtn.disabled = false;
  }
}

function privateContactsFromConfig(config) {
  const enabled = new Set(normalizeList(config?.private_chat_users));
  const reasoning = parseReasoningMap(config?.reasoning_private_users);
  return [...new Set([...enabled, ...Object.keys(reasoning)])].map((userId) => ({
    user_id: userId,
    nickname: `好友 ${userId}`,
    source: "configured",
    private_enabled: enabled.has(userId),
    reasoning_effort: reasoning[userId] || "",
    reasoning_label: reasoningLabel(reasoning[userId]),
  }));
}

async function refreshPrivateContacts(fallbackConfig = bootstrapConfig) {
  if (!api) {
    privateContacts = previewPrivates.map((item) => ({ ...item }));
    return;
  }
  try {
    const data = await api.safePost("settings/private/refresh", {});
    privateContacts = Array.isArray(data) ? data : [];
  } catch {
    privateContacts = privateContactsFromConfig(fallbackConfig);
  }
}

async function refreshObjects({ silent = false } = {}) {
  if (previewMode || !api) {
    groups = previewGroups.map((item) => ({ ...item }));
    privateContacts = previewPrivates.map((item) => ({ ...item }));
    updateCounts();
    renderObjectList();
    if (!silent) toast("预览数据已刷新");
    return;
  }
  try {
    const [nextGroups] = await Promise.all([
      api.safePost("settings/groups/refresh", {}),
      refreshPrivateContacts(),
    ]);
    groups = Array.isArray(nextGroups) ? nextGroups : [];
    updateCounts();
    renderObjectList();
    if (!silent) toast("群聊和私聊列表已同步");
  } catch (err) {
    if (!silent) toast(`同步失败：${err.message}`, "error");
  }
}

function applySystemInfo(system = {}) {
  if (els.system) {
    els.system.textContent = [system.platform, system.platform_release].filter(Boolean).join(" ") || "未知系统";
  }
  if (els.python) {
    els.python.textContent = `Python ${system.python || "--"} · AstrBot ${system.astrbot || "--"}`;
  }
}

async function loadBootstrap() {
  if (!api) return;
  const data = await api.safeGet("settings/bootstrap");
  bootstrapConfig = data.config || {};
  groups = Array.isArray(data.groups) ? data.groups : [];
  await refreshPrivateContacts(bootstrapConfig);
  applySystemInfo(data.system || {});
  updateCounts();
  renderObjectList();
}

function weatherCodeText(code) {
  const value = Number(code);
  if ([0].includes(value)) return "晴";
  if ([1, 2, 3].includes(value)) return "多云";
  if ([45, 48].includes(value)) return "雾";
  if ([51, 53, 55, 56, 57].includes(value)) return "毛毛雨";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return "雨";
  if ([71, 73, 75, 77, 85, 86].includes(value)) return "雪";
  if ([95, 96, 99].includes(value)) return "雷雨";
  return "天气";
}

function renderWeather(data, metaText) {
  const temperature = Number(data?.temperature);
  if (els.weather) {
    els.weather.textContent = Number.isFinite(temperature)
      ? `${weatherCodeText(data.weather_code)} ${Math.round(temperature)}°C`
      : "天气已获取";
  }
  if (els.weatherMeta) {
    els.weatherMeta.textContent = metaText || data?.place || data?.time || "已更新";
  }
}

function setWeatherError(label, meta) {
  if (els.weather) els.weather.textContent = label;
  if (els.weatherMeta) els.weatherMeta.textContent = meta;
}

function getBrowserPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("浏览器不支持定位"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: false,
      timeout: 7000,
      maximumAge: 10 * 60 * 1000,
    });
  });
}

async function loadWeatherByIp(reason = "") {
  if (!api) {
    renderWeather({ temperature: 26, weather_code: 1 }, "预览模式");
    return;
  }
  try {
    const data = await api.safeGet("settings/weather/ip");
    renderWeather(data, data.place ? `IP 定位 · ${data.place}` : "IP 定位");
  } catch (err) {
    setWeatherError("天气获取失败", reason || err.message || "定位和 IP 天气均不可用");
  }
}

async function loadLocationWeather() {
  setWeatherError("定位中", "等待浏览器授权");
  try {
    const position = await getBrowserPosition();
    const latitude = Number(position?.coords?.latitude);
    const longitude = Number(position?.coords?.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("浏览器返回了无效坐标");
    }
    const data = await api.safeGet("settings/weather", { latitude, longitude });
    renderWeather(data, "浏览器定位已授权");
  } catch (err) {
    await loadWeatherByIp(err.message);
  }
}

function updateClock() {
  const now = new Date();
  const time = now.toLocaleTimeString("zh-CN", { hour12: false });
  const date = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  if (els.time) els.time.textContent = time;
  if (els.runtimeClock) els.runtimeClock.textContent = time;
  if (els.date) els.date.textContent = date;
}

function activatePreviewMode() {
  previewMode = true;
  api = null;
  if (els.bridge) els.bridge.textContent = "静态预览模式";
  groups = previewGroups.map((item) => ({ ...item }));
  privateContacts = previewPrivates.map((item) => ({ ...item }));
  applySystemInfo({ platform: "Windows", platform_release: "11", python: "3.x", astrbot: "预览" });
  updateCounts();
  renderObjectList();
  renderWelcome();
  loadWeatherByIp();
}

function bindEvents() {
  els.toggleThemeBtn?.addEventListener("click", cycleTheme);
  els.refreshGroupsBtn?.addEventListener("click", () => refreshObjects().catch((err) => toast(err.message, "error")));
  els.search?.addEventListener("input", renderObjectList);
  els.groupTabBtn?.addEventListener("click", () => setMode("groups"));
  els.privateTabBtn?.addEventListener("click", () => setMode("privates"));
  els.saveGroupBtn?.addEventListener("click", saveCurrentConfig);
  els.resetGroupBtn?.addEventListener("click", resetCurrentConfig);
  if (mediaQuery) {
    const handler = () => {
      if (themePreference === "auto") applyTheme();
    };
    if (mediaQuery.addEventListener) mediaQuery.addEventListener("change", handler);
    else mediaQuery.addListener?.(handler);
  }
}

async function init() {
  applyTheme();
  bindEvents();
  updateClock();
  window.setInterval(updateClock, 1000);
  renderWelcome();
  if (!bridge) {
    activatePreviewMode();
    return;
  }
  try {
    api = createApi(bridge);
    if (els.bridge) els.bridge.textContent = "AstrBot 页面桥接";
    await loadThemeFromBackend();
    applyTheme();
    await loadBootstrap();
    loadLocationWeather();
  } catch (err) {
    toast(`加载失败：${err.message}`, "error");
    activatePreviewMode();
  }
}

init();
