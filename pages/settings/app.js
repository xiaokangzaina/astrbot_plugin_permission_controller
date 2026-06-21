import { createApi } from "./api.js";

const bridge = window.AstrBotPluginPage;
const root = document.documentElement;
const themeMediaQuery =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
const THEME_STORAGE_KEY = "permission-controller-theme-mode";
const GROUP_TOUCH_STORAGE_KEY = "permission-controller-group-touch-times";

let api = null;
let groups = [];
let privateContacts = [];
let currentGroup = null;
let currentPrivateContact = null;
const contactSectionCollapsed = { groups: true, privates: true };
let themePreference = loadThemePreference();
const REASONING_OPTIONS = [
  ["", "默认"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["ultra", "超高"],
];

const els = {
  groupList: document.getElementById("groupList"),
  groupForm: document.getElementById("groupForm"),
  groupSearchInput: document.getElementById("groupSearchInput"),
  currentGroupTitle: document.getElementById("currentGroupTitle"),
  currentGroupMeta: document.getElementById("currentGroupMeta"),
  toastLayer: document.getElementById("toastLayer"),
  toggleThemeBtn: document.getElementById("toggleThemeBtn"),
  refreshGroupsBtn: document.getElementById("refreshGroupsBtn"),
  resetGroupBtn: document.getElementById("resetGroupBtn"),
  saveGroupBtn: document.getElementById("saveGroupBtn"),
  groupCountLabel: document.getElementById("groupCountLabel"),
  privateCountLabel: document.getElementById("privateCountLabel"),
  currentTimeLabel: document.getElementById("currentTimeLabel"),
  currentDateLabel: document.getElementById("currentDateLabel"),
  systemVersionLabel: document.getElementById("systemVersionLabel"),
  pythonVersionLabel: document.getElementById("pythonVersionLabel"),
  weatherLabel: document.getElementById("weatherLabel"),
  weatherMetaLabel: document.getElementById("weatherMetaLabel"),
};

function isValidThemePreference(value) {
  return value === "light" || value === "dark" || value === "auto";
}

function loadThemePreferenceFromCookie() {
  try {
    const cookies = document.cookie ? document.cookie.split(";") : [];
    const prefix = `${THEME_STORAGE_KEY}=`;
    const matched = cookies
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix));
    if (!matched) return null;
    const value = decodeURIComponent(matched.slice(prefix.length));
    return isValidThemePreference(value) ? value : null;
  } catch {}
  return null;
}

function saveThemePreferenceToCookie(value) {
  try {
    document.cookie = `${THEME_STORAGE_KEY}=${encodeURIComponent(value)}; max-age=31536000; path=/; SameSite=Lax`;
  } catch {}
}

function loadThemePreference() {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isValidThemePreference(stored)) return stored;
  } catch {}
  return loadThemePreferenceFromCookie() || "auto";
}

function loadGroupTouchTimes() {
  try {
    const raw = window.localStorage.getItem(GROUP_TOUCH_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {}
  return {};
}

function saveGroupTouchTimes(times) {
  try {
    window.localStorage.setItem(GROUP_TOUCH_STORAGE_KEY, JSON.stringify(times));
  } catch {}
}

function touchGroupConfig(groupId) {
  const target = String(groupId || "").trim();
  if (!target) return;
  const times = loadGroupTouchTimes();
  times[target] = Date.now();
  saveGroupTouchTimes(times);
}

function groupTouchTime(group) {
  const backendTime = Number(group?.config_updated_at || 0);
  if (backendTime) return backendTime;
  const times = loadGroupTouchTimes();
  return Number(times[String(group?.group_id || "")] || 0);
}

function sortGroupsByRecentConfig(groupList) {
  return [...groupList].sort((a, b) => {
    const recentDiff = groupTouchTime(b) - groupTouchTime(a);
    if (recentDiff) return recentDiff;
    return String(a.group_name || a.group_id || "").localeCompare(
      String(b.group_name || b.group_id || ""),
      "zh-Hans-CN",
    );
  });
}

function saveThemePreference() {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
  } catch {}
  saveThemePreferenceToCookie(themePreference);
}

function setThemePreference(value) {
  if (!isValidThemePreference(value)) {
    return false;
  }
  themePreference = value;
  saveThemePreference();
  return true;
}

async function loadThemePreferenceFromBackend() {
  if (!api) {
    return;
  }
  try {
    const result = await api.safeGet("/settings/theme");
    const value = result?.theme || result;
    const hasPersistedBackendTheme = result?.persisted === true;
    if (hasPersistedBackendTheme || themePreference === "auto") {
      setThemePreference(value);
    } else {
      saveThemePreferenceToBackend();
    }
  } catch {}
}

function saveThemePreferenceToBackend() {
  if (!api) {
    return;
  }
  api.safePost("/settings/theme", { theme: themePreference }).catch(() => {});
}

function themeButtonLabel() {
  if (themePreference === "dark") return "主题：深色";
  if (themePreference === "light") return "主题：浅色";
  return "主题：自动";
}

function updateClock() {
  const now = new Date();
  if (els.currentTimeLabel) {
    els.currentTimeLabel.textContent = now.toLocaleTimeString("zh-CN", { hour12: false });
  }
  if (els.currentDateLabel) {
    els.currentDateLabel.textContent = now.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
    });
  }
}

function applySystemInfo(system = {}) {
  const platformText = [system.platform, system.platform_release].filter(Boolean).join(" ") || "未知系统";
  if (els.systemVersionLabel) els.systemVersionLabel.textContent = platformText;
  if (els.pythonVersionLabel) {
    els.pythonVersionLabel.textContent = `Python ${system.python || "--"} · AstrBot ${system.astrbot || "未知"}`;
  }
}

function weatherCodeText(code) {
  const map = {
    0: "晴", 1: "多云", 2: "多云", 3: "阴",
    45: "雾", 48: "雾凇",
    51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    71: "小雪", 73: "中雪", 75: "大雪",
    80: "阵雨", 81: "阵雨", 82: "强阵雨",
    95: "雷暴", 96: "雷暴冰雹", 99: "强雷暴冰雹",
  };
  return map[Number(code)] || "天气";
}

async function fetchWeather(latitude, longitude) {
  const data = await api.safeGet("settings/weather", { latitude, longitude });
  if (typeof data.temperature !== "number") throw new Error("天气数据为空");
  if (els.weatherLabel) els.weatherLabel.textContent = `${weatherCodeText(data.weather_code)} ${Math.round(data.temperature)}℃`;
  if (els.weatherMetaLabel) els.weatherMetaLabel.textContent = data.time ? `更新时间：${data.time}` : "已通过浏览器定位获取";
}

function loadLocationWeather() {
  if (!els.weatherLabel || !els.weatherMetaLabel) return;
  if (!navigator.geolocation) {
    els.weatherLabel.textContent = "定位不可用";
    els.weatherMetaLabel.textContent = "浏览器不支持定位";
    return;
  }
  els.weatherLabel.textContent = "定位中";
  els.weatherMetaLabel.textContent = "等待定位授权";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      fetchWeather(position.coords.latitude, position.coords.longitude).catch((err) => {
        els.weatherLabel.textContent = "天气获取失败";
        els.weatherMetaLabel.textContent = err.message || "请稍后重试";
      });
    },
    () => {
      els.weatherLabel.textContent = "未开启定位";
      els.weatherMetaLabel.textContent = "开启浏览器定位后显示天气";
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 },
  );
}

function applyTheme() {
  let effective = themePreference;
  if (effective === "auto") {
    effective = themeMediaQuery && themeMediaQuery.matches ? "dark" : "light";
  }
  root.setAttribute("data-theme", effective);
  if (els.toggleThemeBtn) els.toggleThemeBtn.textContent = themeButtonLabel();
}

function cycleTheme() {
  themePreference =
    themePreference === "auto" ? "light" : themePreference === "light" ? "dark" : "auto";
  saveThemePreference();
  saveThemePreferenceToBackend();
  applyTheme();
}

function toast(message, kind = "info") {
  if (!els.toastLayer) return;
  const node = document.createElement("div");
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  els.toastLayer.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(() => {
    node.classList.remove("show");
    setTimeout(() => node.remove(), 240);
  }, 2600);
}

function normalizeListText(value) {
  return String(value || "")
    .split(/[\n,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function reasoningLabel(value) {
  const normalized = String(value || "").trim();
  return REASONING_OPTIONS.find(([key]) => key === normalized)?.[1] || "默认";
}

function createReasoningSelect(id, value) {
  const select = document.createElement("select");
  select.id = id;
  select.className = "reasoning-select";
  const current = String(value || "").trim();
  REASONING_OPTIONS.forEach(([optionValue, label]) => {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = label;
    option.selected = optionValue === current;
    select.appendChild(option);
  });
  return select;
}

function privateContactsFromConfig(config) {
  const enabledUsers = new Set(normalizeListText(config?.private_chat_users || ""));
  const reasoningMap = new Map();
  normalizeListText(config?.reasoning_private_users || "").forEach((item) => {
    const [userId, effort = ""] = item.split(/[=：:]/, 2).map((part) => part.trim());
    if (userId) reasoningMap.set(userId, effort);
  });
  const userIds = new Set([...enabledUsers, ...reasoningMap.keys()]);
  return [...userIds].map((userId) => ({
    user_id: userId,
    nickname: `好友 ${userId}`,
    remark: "",
    avatar: `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=640`,
    source: "configured",
    private_enabled: enabledUsers.has(userId),
    reasoning_effort: reasoningMap.get(userId) || "",
  }));
}

async function refreshPrivateContacts(options = {}) {
  try {
    privateContacts = await api.safePost("settings/private/refresh", {});
  } catch (err) {
    if (!options.fallbackConfig) throw err;
    privateContacts = privateContactsFromConfig(options.fallbackConfig);
  }
}

function updateContactCounters() {
  if (els.groupCountLabel) els.groupCountLabel.textContent = String(groups.length || 0);
  if (els.privateCountLabel) els.privateCountLabel.textContent = String(privateContacts.length || 0);
}

function createEmptyNode(text) {
  const node = document.createElement("div");
  node.className = "group-empty";
  node.textContent = text;
  return node;
}

function makeSection(key, title, count, body, collapsed = true) {
  const section = document.createElement("section");
  const isCollapsed = contactSectionCollapsed[key] ?? collapsed;
  section.className = `contact-section${isCollapsed ? " collapsed" : ""}`;
  const head = document.createElement("button");
  head.type = "button";
  head.className = "contact-section-head";
  head.innerHTML = `<span>${title}</span><b>${count}</b>`;
  const content = document.createElement("div");
  content.className = "contact-section-body";
  content.appendChild(body);
  head.addEventListener("click", () => {
    section.classList.toggle("collapsed");
    contactSectionCollapsed[key] = section.classList.contains("collapsed");
  });
  section.append(head, content);
  return section;
}

async function selectPrivateContact(contact) {
  const userId = String(contact?.user_id || "").trim();
  if (!userId) return;
  try {
    const data = await api.safeGet("settings/private", { user_id: userId });
    renderPrivateContactForm({ ...data, contact_info: { ...(data.contact_info || {}), ...contact } });
  } catch (err) {
    toast("加载私聊配置失败：" + err.message, "error");
  }
}

function renderPrivateContactForm(payload) {
  const info = payload.contact_info || {};
  const config = payload.config || {};
  currentPrivateContact = { ...info, config };
  currentGroup = null;
  els.groupForm.closest(".group-config-panel")?.classList.remove("is-welcome-mode");
  els.currentGroupTitle.textContent = info.nickname || info.remark || `好友 ${info.user_id || ""}`;
  els.currentGroupMeta.textContent = info.user_id ? `QQ：${info.user_id}` : "私聊好友配置";
  els.groupForm.innerHTML = "";
  els.groupForm.classList.remove("empty-state");
  if (els.resetGroupBtn) els.resetGroupBtn.textContent = "关闭私聊权限";
  if (els.saveGroupBtn) els.saveGroupBtn.textContent = "保存私聊配置";

  const overview = document.createElement("div");
  overview.className = "policy-overview";
  overview.innerHTML = `
    <div class="metric-card ${config.private_enabled ? "is-on" : "is-off"}">
      <span class="metric-label">私聊权限</span>
      <strong>${config.private_enabled ? "已开启" : "未开启"}</strong>
      <em>${config.private_enabled ? "该好友可私聊调用机器人" : "该好友私聊会被拦截"}</em>
    </div>
    <div class="metric-card">
      <span class="metric-label">思考强度</span>
      <strong>${reasoningLabel(config.reasoning_effort)}</strong>
      <em>${config.reasoning_effort ? "本好友私聊单独生效" : "保持模型默认"}</em>
    </div>
  `;

  const accessCard = document.createElement("section");
  accessCard.className = "group-card policy-card";
  accessCard.innerHTML = `
    <div class="group-card-head">
      <div>
        <span class="section-index">01</span>
        <h3>私聊权限</h3>
        <p class="group-card-hint">控制该好友是否可以在私聊中调用机器人。</p>
      </div>
    </div>
    <button class="field field-bool feature-toggle-card ${config.private_enabled ? "is-selected" : ""}" id="privateEnabledPanel" type="button" aria-pressed="${config.private_enabled ? "true" : "false"}">
      <input id="privateEnabledInput" type="hidden" value="${config.private_enabled ? "true" : "false"}" />
      <div>
        <div class="field-label">开启私聊权限</div>
        <div class="field-hint">点击切换。选中后该好友可通过私聊调用机器人。</div>
      </div>
      <span class="policy-state-badge">${config.private_enabled ? "已开启" : "未开启"}</span>
    </button>
  `;
  const privateEnabledPanel = accessCard.querySelector("#privateEnabledPanel");
  const privateEnabledInput = accessCard.querySelector("#privateEnabledInput");
  const policyStateBadge = accessCard.querySelector(".policy-state-badge");
  privateEnabledPanel?.addEventListener("click", () => {
    const nextEnabled = privateEnabledInput.value !== "true";
    privateEnabledInput.value = nextEnabled ? "true" : "false";
    privateEnabledPanel.classList.toggle("is-selected", nextEnabled);
    privateEnabledPanel.setAttribute("aria-pressed", nextEnabled ? "true" : "false");
    if (policyStateBadge) policyStateBadge.textContent = nextEnabled ? "已开启" : "未开启";
  });

  const reasoningCard = document.createElement("section");
  reasoningCard.className = "group-card policy-card reasoning-card";
  reasoningCard.innerHTML = `
    <div class="group-card-head">
      <div>
        <span class="section-index">02</span>
        <h3>私聊思考强度</h3>
        <p class="group-card-hint">只影响该好友私聊机器人时的本次模型请求。</p>
      </div>
    </div>
    <div class="field field-select">
      <div class="field-label">思考强度</div>
      <div class="field-hint">默认表示不注入 reasoning_effort，保持模型服务商原始设置。</div>
    </div>
  `;
  reasoningCard.querySelector(".field-select")?.appendChild(
    createReasoningSelect("privateReasoningEffortInput", config.reasoning_effort),
  );

  els.groupForm.append(overview, accessCard, reasoningCard);
  renderGroupList();
}

function renderGroupList() {
  const keyword = String(els.groupSearchInput?.value || "").trim().toLowerCase();
  const visibleGroups = sortGroupsByRecentConfig(groups).filter((group) => {
    const text = `${group.group_name || ""} ${group.group_id || ""}`.toLowerCase();
    return !keyword || text.includes(keyword);
  });
  const visiblePrivates = privateContacts.filter((contact) => {
    const text = `${contact.nickname || ""} ${contact.remark || ""} ${contact.user_id || ""}`.toLowerCase();
    return !keyword || text.includes(keyword);
  });

  updateContactCounters();
  els.groupList.innerHTML = "";
  els.groupList.classList.remove("empty-state");

  const groupBody = document.createElement("div");
  if (!visibleGroups.length) {
    groupBody.appendChild(createEmptyNode("未找到群聊。"));
  } else {
    visibleGroups.forEach((group) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "group-item";
      if (String(currentGroup?.group_info?.group_id || "") === String(group.group_id)) {
        card.classList.add("active");
      }
      card.addEventListener("click", () => loadGroupConfig(group.group_id));

      const avatar = document.createElement("img");
      avatar.className = "group-avatar";
      avatar.src = group.avatar || "";
      avatar.alt = group.group_name || group.group_id;
      avatar.onerror = () => { avatar.style.display = "none"; };

      const body = document.createElement("span");
      body.className = "group-item-body";
      const name = document.createElement("span");
      name.className = "group-name";
      name.textContent = group.group_name || `群 ${group.group_id}`;
      const meta = document.createElement("span");
      meta.className = "group-meta";
      const reasoningText = group.reasoning_effort ? ` · 思考：${reasoningLabel(group.reasoning_effort)}` : "";
      meta.textContent = `策略：${group.group_enabled ? "整群放行" : "群组细化"}${reasoningText}`;
      body.append(name, meta);
      card.append(avatar, body);
      groupBody.appendChild(card);
    });
  }

  const privateBody = document.createElement("div");
  if (!visiblePrivates.length) {
    privateBody.appendChild(createEmptyNode("未获取到好友列表。"));
  } else {
    visiblePrivates.forEach((contact) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "group-item private-item";
      if (currentPrivateContact?.user_id === contact.user_id) card.classList.add("active");
      card.addEventListener("click", () => selectPrivateContact(contact).catch((err) => toast(err.message, "error")));
      const avatar = document.createElement("img");
      avatar.className = "group-avatar";
      avatar.src = contact.avatar || "";
      avatar.alt = contact.nickname || contact.user_id;
      avatar.onerror = () => { avatar.style.display = "none"; };
      const body = document.createElement("span");
      body.className = "group-item-body";
      const name = document.createElement("span");
      name.className = "group-name";
      name.textContent = contact.nickname || contact.remark || `好友 ${contact.user_id}`;
      const meta = document.createElement("span");
      meta.className = "group-meta";
      const reasoningText = contact.reasoning_effort ? ` · 思考：${reasoningLabel(contact.reasoning_effort)}` : "";
      meta.textContent = `策略：${contact.private_enabled ? "私聊放行" : "私聊关闭"}${reasoningText}`;
      body.append(name, meta);
      card.append(avatar, body);
      privateBody.appendChild(card);
    });
  }

  els.groupList.append(
    makeSection("groups", "群聊", groups.length, groupBody, true),
    makeSection("privates", "私聊", privateContacts.length, privateBody, true),
  );
}

function renderGroupForm(payload) {
  currentGroup = payload;
  currentPrivateContact = null;
  const info = payload.group_info || {};
  const config = payload.config || {};
  const allowedUsers = Array.isArray(config.allowed_users) ? config.allowed_users : [];
  const deniedUsers = Array.isArray(config.denied_users) ? config.denied_users : [];
  const reasoningUserRules = Array.isArray(config.reasoning_user_rules) ? config.reasoning_user_rules : [];
  els.groupForm.closest(".group-config-panel")?.classList.remove("is-welcome-mode");
  els.currentGroupTitle.textContent = info.group_name || "未命名群聊";
  els.currentGroupMeta.textContent = info.group_name ? "群聊配置" : "请选择左侧群聊";

  els.groupForm.innerHTML = "";
  els.groupForm.classList.remove("empty-state");
  if (els.resetGroupBtn) els.resetGroupBtn.textContent = "清空该群配置";
  if (els.saveGroupBtn) els.saveGroupBtn.textContent = "保存群聊配置";

  const overview = document.createElement("div");
  overview.className = "policy-overview";
  overview.innerHTML = `
    <div class="metric-card ${config.group_enabled ? "is-on" : "is-off"}">
      <span class="metric-label">访问模式</span>
      <strong>${config.group_enabled ? "整群放行" : "精准授权"}</strong>
      <em>${config.group_enabled ? "群内成员默认可调用" : "仅白名单用户可调用"}</em>
    </div>
    <div class="metric-card">
      <span class="metric-label">允许用户</span>
      <strong>${allowedUsers.length}</strong>
      <em>白名单条目</em>
    </div>
    <div class="metric-card danger">
      <span class="metric-label">拒绝用户</span>
      <strong>${deniedUsers.length}</strong>
      <em>黑名单条目</em>
    </div>
    <div class="metric-card">
      <span class="metric-label">思考强度</span>
      <strong>${reasoningLabel(config.reasoning_effort)}</strong>
      <em>${reasoningUserRules.length ? `${reasoningUserRules.length} 条成员覆盖` : "群默认规则"}</em>
    </div>
  `;

  const accessCard = document.createElement("section");
  accessCard.className = "group-card policy-card";
  accessCard.innerHTML = `
    <div class="group-card-head">
      <div>
        <span class="section-index">01</span>
        <h3>访问策略</h3>
        <p class="group-card-hint">决定该群是整体开放，还是只允许指定成员调用机器人。</p>
      </div>
    </div>
    <button class="field field-bool feature-toggle-card ${config.group_enabled ? "is-selected" : ""}" id="groupEnabledPanel" type="button" aria-pressed="${config.group_enabled ? "true" : "false"}">
      <input id="groupEnabledInput" type="hidden" value="${config.group_enabled ? "true" : "false"}" />
      <div>
        <div class="field-label">整群放行</div>
        <div class="field-hint">点击切换。选中后该群所有成员都可调用机器人；未选中则仅允许用户可调用。</div>
      </div>
      <span class="policy-state-badge">${config.group_enabled ? "已开启" : "未开启"}</span>
    </button>
  `;

  const groupEnabledPanel = accessCard.querySelector("#groupEnabledPanel");
  const groupEnabledInput = accessCard.querySelector("#groupEnabledInput");
  const policyStateBadge = accessCard.querySelector(".policy-state-badge");
  groupEnabledPanel?.addEventListener("click", () => {
    const nextEnabled = groupEnabledInput.value !== "true";
    groupEnabledInput.value = nextEnabled ? "true" : "false";
    groupEnabledPanel.classList.toggle("is-selected", nextEnabled);
    groupEnabledPanel.setAttribute("aria-pressed", nextEnabled ? "true" : "false");
    if (policyStateBadge) policyStateBadge.textContent = nextEnabled ? "已开启" : "未开启";
  });

  const allowCard = document.createElement("section");
  allowCard.className = "group-card policy-card allow-card";
  allowCard.innerHTML = `
    <div class="group-card-head split-head">
      <div>
        <span class="section-index">02</span>
        <h3>本群允许用户</h3>
        <p class="group-card-hint">每行一个 QQ 号。保存后会自动写入“用户QQ-群号”放行规则。</p>
      </div>
      <span class="count-badge">${allowedUsers.length} 人</span>
    </div>
    <div class="field list-field">
      <div class="field-label">白名单列表</div>
      <textarea id="allowedUsersInput" rows="5" spellcheck="false" placeholder="例如：\n123456789\n987654321"></textarea>
    </div>
  `;
  allowCard.querySelector("textarea").value = allowedUsers.join("\n");

  const denyCard = document.createElement("section");
  denyCard.className = "group-card policy-card deny-card";
  denyCard.innerHTML = `
    <div class="group-card-head split-head">
      <div>
        <span class="section-index">03</span>
        <h3>本群拒绝用户</h3>
        <p class="group-card-hint">每行一个 QQ 号。命中后该用户在本群无法调用机器人。</p>
      </div>
      <span class="count-badge danger">${deniedUsers.length} 人</span>
    </div>
    <div class="field list-field">
      <div class="field-label">黑名单列表</div>
      <textarea id="deniedUsersInput" rows="5" spellcheck="false" placeholder="例如：\n123456789\n987654321"></textarea>
    </div>
  `;
  denyCard.querySelector("textarea").value = deniedUsers.join("\n");

  const listPair = document.createElement("div");
  listPair.className = "list-card-pair";
  listPair.append(allowCard, denyCard);

  const reasoningCard = document.createElement("section");
  reasoningCard.className = "group-card policy-card reasoning-card";
  reasoningCard.innerHTML = `
    <div class="group-card-head split-head">
      <div>
        <span class="section-index">04</span>
        <h3>模型思考强度</h3>
        <p class="group-card-hint">群默认强度适用于该群，成员覆盖规则优先级更高。</p>
      </div>
      <span class="count-badge">${reasoningUserRules.length} 条覆盖</span>
    </div>
    <div class="reasoning-grid">
      <div class="field field-select">
        <div class="field-label">本群默认强度</div>
        <div class="field-hint">默认表示不注入 reasoning_effort，保持模型服务商原始设置。</div>
      </div>
      <div class="field list-field">
        <div class="field-label">成员覆盖规则</div>
        <textarea id="reasoningUsersInput" rows="5" spellcheck="false" placeholder="例如：\n123456789=超高\n987654321=低"></textarea>
      </div>
    </div>
  `;
  reasoningCard.querySelector(".field-select")?.appendChild(
    createReasoningSelect("groupReasoningEffortInput", config.reasoning_effort),
  );
  reasoningCard.querySelector("textarea").value = reasoningUserRules.join("\n");

  const ruleCard = document.createElement("section");
  ruleCard.className = "group-card rule-card";
  ruleCard.innerHTML = `
    <div class="group-card-head">
      <span class="section-index">05</span>
      <h3>判定优先级</h3>
      <p class="group-card-hint">规则从上到下匹配，拒绝名单优先级最高。</p>
    </div>
    <div class="rule-flow">
      <div><b>1</b><span>拒绝用户命中</span><em>直接禁止调用</em></div>
      <div><b>2</b><span>整群放行开启</span><em>群成员默认允许</em></div>
      <div><b>3</b><span>允许用户命中</span><em>指定成员允许</em></div>
      <div><b>4</b><span>未命中规则</span><em>保持拦截</em></div>
    </div>
  `;

  els.groupForm.appendChild(overview);
  els.groupForm.appendChild(accessCard);
  els.groupForm.appendChild(listPair);
  els.groupForm.appendChild(reasoningCard);
  els.groupForm.appendChild(ruleCard);
  renderGroupList();
}

function collectGroupForm() {
  return {
    group_enabled: document.getElementById("groupEnabledInput")?.value === "true",
    allowed_users: normalizeListText(document.getElementById("allowedUsersInput")?.value),
    denied_users: normalizeListText(document.getElementById("deniedUsersInput")?.value),
    reasoning_effort: document.getElementById("groupReasoningEffortInput")?.value || "",
    reasoning_user_rules: normalizeListText(document.getElementById("reasoningUsersInput")?.value),
  };
}

function collectPrivateContactForm() {
  return {
    private_enabled: document.getElementById("privateEnabledInput")?.value === "true",
    reasoning_effort: document.getElementById("privateReasoningEffortInput")?.value || "",
  };
}

function renderWelcomePanel() {
  currentGroup = null;
  currentPrivateContact = null;
  els.groupForm.closest(".group-config-panel")?.classList.add("is-welcome-mode");
  els.currentGroupTitle.textContent = "请选择配置对象";
  els.currentGroupMeta.textContent = "从左侧选择群聊或私聊好友开始配置";
  if (els.resetGroupBtn) els.resetGroupBtn.textContent = "清空配置";
  if (els.saveGroupBtn) els.saveGroupBtn.textContent = "保存配置";
  els.groupForm.classList.remove("empty-state");
  els.groupForm.innerHTML = `
    <div class="welcome-panel">
      <span class="welcome-badge">Permission Center</span>
      <h2>选一个群或好友，开始调校权限</h2>
      <p>群聊可配置整群放行、允许用户和拒绝用户；私聊好友可单独开启或关闭私聊权限。</p>
    </div>
  `;
  renderGroupList();
}

async function loadBootstrap() {
  els.groupList.classList.add("empty-state");
  els.groupList.textContent = "群聊/私聊列表同步中…";
  renderWelcomePanel();
  try {
    const data = await api.safeGet("settings/bootstrap");
    applySystemInfo(data.system || {});
    await Promise.all([
      refreshGroups({ silent: true }),
      refreshPrivateContacts({ fallbackConfig: data.config || {} }),
    ]);
  } catch (err) {
    const data = await api.safeGet("settings/bootstrap");
    applySystemInfo(data.system || {});
    groups = data.groups || [];
    privateContacts = privateContactsFromConfig(data.config || {});
    renderGroupList();
    toast("同步群列表失败，已使用缓存配置：" + err.message, "error");
  }
  renderWelcomePanel();
}

async function refreshGroups(options = {}) {
  const [nextGroups] = await Promise.all([
    api.safePost("settings/groups/refresh", {}),
    refreshPrivateContacts({ fallbackConfig: options.fallbackConfig || null }).catch((err) => {
      if (!options.silent) toast("好友列表同步失败：" + err.message, "error");
    }),
  ]);
  groups = nextGroups;
  renderGroupList();
  if (!options.silent) toast("群聊/好友列表已同步", "success");
}

async function loadGroupConfig(groupId) {
  const target = String(groupId || "").trim();
  if (!target) return;
  const data = await api.safeGet("settings/group", { group_id: target });
  const listInfo = groups.find((group) => String(group.group_id) === target);
  if (listInfo) {
    data.group_info = { ...(data.group_info || {}), ...listInfo };
  }
  renderGroupForm(data);
}

async function saveGroupConfig() {
  const privateUserId = String(currentPrivateContact?.user_id || "").trim();
  if (privateUserId) {
    els.saveGroupBtn.disabled = true;
    try {
      const data = await api.safePost("settings/private", {
        user_id: privateUserId,
        config: collectPrivateContactForm(),
      });
      const currentInfo = currentPrivateContact || {};
      renderPrivateContactForm({ ...data, contact_info: { ...(data.contact_info || {}), ...currentInfo } });
      await refreshGroups({ silent: true });
      toast("私聊配置已保存", "success");
    } catch (err) {
      toast("保存失败：" + err.message, "error");
    } finally {
      els.saveGroupBtn.disabled = false;
    }
    return;
  }

  const groupId = String(currentGroup?.group_info?.group_id || "").trim();
  if (!groupId) {
    toast("请先选择群聊", "error");
    return;
  }
  els.saveGroupBtn.disabled = true;
  try {
    const data = await api.safePost("settings/group", {
      group_id: groupId,
      config: collectGroupForm(),
    });
    renderGroupForm(data);
    touchGroupConfig(groupId);
    await refreshGroups({ silent: true });
    toast("群配置已保存", "success");
  } catch (err) {
    toast("保存失败：" + err.message, "error");
  } finally {
    els.saveGroupBtn.disabled = false;
  }
}

async function resetGroupConfig() {
  const privateUserId = String(currentPrivateContact?.user_id || "").trim();
  if (privateUserId) {
    if (!window.confirm("确定关闭该好友的私聊权限吗？")) return;
    els.resetGroupBtn.disabled = true;
    try {
      const data = await api.safePost("settings/private/reset", { user_id: privateUserId });
      const currentInfo = currentPrivateContact || {};
      renderPrivateContactForm({ ...data, contact_info: { ...(data.contact_info || {}), ...currentInfo } });
      await refreshGroups({ silent: true });
      toast("私聊配置已重置", "success");
    } catch (err) {
      toast("重置失败：" + err.message, "error");
    } finally {
      els.resetGroupBtn.disabled = false;
    }
    return;
  }

  const groupId = String(currentGroup?.group_info?.group_id || "").trim();
  if (!groupId) {
    toast("请先选择群聊", "error");
    return;
  }
  if (!window.confirm("确定清空该群的整群放行、允许用户和不允许调用用户吗？")) return;
  els.resetGroupBtn.disabled = true;
  try {
    const data = await api.safePost("settings/group/reset", { group_id: groupId });
    renderGroupForm(data);
    touchGroupConfig(groupId);
    await refreshGroups({ silent: true });
    toast("群配置已重置", "success");
  } catch (err) {
    toast("重置失败：" + err.message, "error");
  } finally {
    els.resetGroupBtn.disabled = false;
  }
}

function bindEvents() {
  els.toggleThemeBtn?.addEventListener("click", cycleTheme);
  els.refreshGroupsBtn?.addEventListener("click", () => refreshGroups().catch((err) => toast(err.message, "error")));
  els.saveGroupBtn?.addEventListener("click", saveGroupConfig);
  els.resetGroupBtn?.addEventListener("click", resetGroupConfig);
  els.groupSearchInput?.addEventListener("input", renderGroupList);
  if (themeMediaQuery) {
    const handler = () => {
      if (themePreference === "auto") applyTheme();
    };
    if (themeMediaQuery.addEventListener) {
      themeMediaQuery.addEventListener("change", handler);
    } else if (themeMediaQuery.addListener) {
      themeMediaQuery.addListener(handler);
    }
  }
}

function init() {
  applyTheme();
  bindEvents();
  updateClock();
  window.setInterval(updateClock, 1000);
  if (!bridge) {
    els.groupForm.textContent = "无法获取 AstrBot 页面桥接（window.AstrBotPluginPage）。";
    els.groupForm.classList.add("empty-state");
    return;
  }
  try {
    api = createApi(bridge);
    loadLocationWeather();
  } catch (err) {
    els.groupForm.textContent = "初始化失败：" + err.message;
    return;
  }
  loadThemePreferenceFromBackend()
    .then(() => applyTheme())
    .finally(() => {
      loadBootstrap().catch((err) => {
        els.groupForm.textContent = "加载失败：" + err.message;
        els.groupForm.classList.add("empty-state");
        toast("加载失败：" + err.message, "error");
      });
    });
}

init();
