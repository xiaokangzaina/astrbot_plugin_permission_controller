import { createApi } from "./api.js";
import {
  collectFormData,
  renderSchemaFields,
} from "./form-renderer.js";
import {
  renderGroupCards,
  renderGroupDetailHeader,
} from "./group-view.js";

const bridge = window.AstrBotPluginPage;
const root = document.documentElement;
const themeMediaQuery =
  typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
const THEME_STORAGE_KEY = "qqadmin-page-theme-mode";
const DEFAULT_GROUP_ID = "__default__";
const COLLAPSED_GROUP_OBJECT_PATHS = new Set(["perms"]);
const FOLLOW_DEFAULT_KEY = "follow_default";

let api = null;
let bootstrapData = null;
let currentGroup = null;
let allGroups = [];
let detachContextHandler = null;
let detachSystemThemeHandler = null;
let themePreference = loadThemePreference();

const els = {
  groupForm: document.getElementById("groupForm"),
  groupList: document.getElementById("groupList"),
  groupSearchInput: document.getElementById("groupSearchInput"),
  currentGroupName: document.getElementById("currentGroupName"),
  groupListCount: document.getElementById("groupListCount"),
  toastLayer: document.getElementById("toastLayer"),
  toggleThemeBtn: document.getElementById("toggleThemeBtn"),
  refreshGroupsBtn: document.getElementById("refreshGroupsBtn"),
  saveGroupBtn: document.getElementById("saveGroupBtn"),
  resetGroupBtn: document.getElementById("resetGroupBtn"),
  totalGroups: document.getElementById("totalGroups"),
  totalFields: document.getElementById("totalFields"),
  currentGroupBadge: document.getElementById("currentGroupBadge"),
  heroGroupCount: document.getElementById("heroGroupCount"),
  heroFieldCount: document.getElementById("heroFieldCount"),
  heroCurrentMode: document.getElementById("heroCurrentMode"),
  bootSequence: document.getElementById("bootSequence"),
  cursorGlow: document.querySelector(".cursor-glow"),
  emptyState: document.getElementById("emptyState"),
  configPanel: document.getElementById("configPanel"),
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
    if (isValidThemePreference(stored)) {
      return stored;
    }
  } catch {}
  return loadThemePreferenceFromCookie() || "auto";
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

function getThemeButtonLabel() {
  if (themePreference === "dark") {
    return "深色";
  }
  if (themePreference === "light") {
    return "浅色";
  }
  return "自动";
}

function updateThemeButton() {
  if (!els.toggleThemeBtn) {
    return;
  }
  const label = getThemeButtonLabel();
  const labelNode = els.toggleThemeBtn.querySelector("b");
  if (labelNode) {
    labelNode.textContent = label;
  } else {
    els.toggleThemeBtn.textContent = `主题：${label}`;
  }
}

function getBridgeThemeMode(context) {
  if (context?.theme === "dark" || context?.theme === "light") {
    return context.theme;
  }
  return null;
}

function getSystemThemeMode() {
  return themeMediaQuery?.matches ? "dark" : "light";
}

function resolveThemeMode(context) {
  if (themePreference === "dark" || themePreference === "light") {
    return themePreference;
  }

  const bridgeThemeMode = getBridgeThemeMode(context);
  if (bridgeThemeMode) {
    return bridgeThemeMode;
  }

  return getSystemThemeMode();
}

function applyThemeMode(themeMode) {
  root.dataset.theme = themeMode;
  root.style.colorScheme = themeMode;
}

function syncThemeFromContext(context) {
  applyThemeMode(resolveThemeMode(context));
  updateThemeButton();
}

function cycleThemePreference() {
  if (themePreference === "auto") {
    themePreference = "dark";
  } else if (themePreference === "dark") {
    themePreference = "light";
  } else {
    themePreference = "auto";
  }
  saveThemePreference();
  saveThemePreferenceToBackend();
  syncThemeFromContext(bridge?.getContext?.());
}

function bindSystemTheme() {
  if (!themeMediaQuery) {
    return;
  }

  const handleThemeChange = () => {
    if (themePreference === "auto") {
      applyThemeMode(resolveThemeMode(bridge?.getContext?.()));
    }
  };

  if (typeof themeMediaQuery.addEventListener === "function") {
    themeMediaQuery.addEventListener("change", handleThemeChange);
    detachSystemThemeHandler = () => {
      themeMediaQuery.removeEventListener("change", handleThemeChange);
    };
    return;
  }

  if (typeof themeMediaQuery.addListener === "function") {
    themeMediaQuery.addListener(handleThemeChange);
    detachSystemThemeHandler = () => {
      themeMediaQuery.removeListener(handleThemeChange);
    };
  }
}

function showToast(message, type = "success") {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  els.toastLayer.appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

function getDefaultGroupConfigValues() {
  const groups = Array.isArray(bootstrapData?.groups) ? bootstrapData.groups : [];
  const defaultGroup = groups.find((group) => group.group_id === DEFAULT_GROUP_ID);
  if (defaultGroup?.config) {
    return defaultGroup.config;
  }
  if (currentGroup?.group_id === DEFAULT_GROUP_ID) {
    return currentGroup?.config || {};
  }
  return {};
}

function buildGroupFormValues(groupPayload) {
  const defaultValues = getDefaultGroupConfigValues();
  const currentValues = groupPayload?.config || {};
  const followDefault = Boolean(currentValues[FOLLOW_DEFAULT_KEY]);
  const mergedValues = followDefault && !groupPayload?.is_default_group
    ? {
        ...defaultValues,
        [FOLLOW_DEFAULT_KEY]: true,
      }
    : currentValues;
  return mergedValues;
}

function isGroupFieldDisabled(path) {
  if (!currentGroup || currentGroup.is_default_group) {
    return false;
  }
  if (!Boolean(currentGroup.config?.[FOLLOW_DEFAULT_KEY])) {
    return false;
  }
  return path !== FOLLOW_DEFAULT_KEY;
}

function buildGroupFormSchema(groupPayload) {
  const schema = bootstrapData.schema.group || {};
  if (!groupPayload?.is_default_group || !schema.group_admin_enabled) {
    return schema;
  }
  return {
    ...schema,
    group_admin_enabled: {
      ...schema.group_admin_enabled,
      description: "新群默认启用群管",
      hint: "这是默认群模板里的开关，用来决定新群或跟随默认配置的群是否默认启用 QQ 群管；不会单独控制某个已独立配置的群。",
    },
  };
}

function countSchemaFields(schema) {
  if (!schema || typeof schema !== "object") {
    return 0;
  }
  return Object.values(schema).reduce((total, value) => {
    if (value && typeof value === "object" && value.type === "object" && value.properties) {
      return total + countSchemaFields(value.properties);
    }
    return total + 1;
  }, 0);
}

function updateShellStats() {
  const normalGroups = allGroups.filter((group) => !group.is_default_group).length;
  const groupCount = String(normalGroups || allGroups.length || 0);
  const fieldCount = String(countSchemaFields(bootstrapData?.schema?.group || {}));
  if (els.totalGroups) {
    els.totalGroups.textContent = groupCount;
  }
  if (els.heroGroupCount) {
    els.heroGroupCount.textContent = groupCount;
  }
  if (els.totalFields) {
    els.totalFields.textContent = fieldCount;
  }
  if (els.heroFieldCount) {
    els.heroFieldCount.textContent = fieldCount;
  }
  let badge = "未选";
  if (currentGroup?.is_default_group) {
    badge = "默认";
  } else if (currentGroup?.config?.[FOLLOW_DEFAULT_KEY]) {
    badge = "跟随";
  } else if (currentGroup) {
    badge = "独立";
  }
  if (els.currentGroupBadge) {
    els.currentGroupBadge.textContent = badge;
  }
  if (els.heroCurrentMode) {
    els.heroCurrentMode.textContent = currentGroup?.is_default_group
      ? "默认模板"
      : currentGroup
        ? badge
        : "未选择";
  }
}

function syncChromeMotion() {
  const boot = els.bootSequence;
  if (boot && !boot.dataset.closed) {
    window.setTimeout(() => {
      boot.dataset.closed = "true";
      boot.classList.add("is-hidden");
    }, 900);
  }
  if (els.cursorGlow && !els.cursorGlow.dataset.bound) {
    els.cursorGlow.dataset.bound = "true";
    let pointerFrame = 0;
    let pendingPointerEvent = null;
    window.addEventListener("pointermove", (event) => {
      pendingPointerEvent = event;
      if (pointerFrame) {
        return;
      }
      pointerFrame = window.requestAnimationFrame(() => {
        pointerFrame = 0;
        if (!pendingPointerEvent) {
          return;
        }
        els.cursorGlow.style.transform = `translate3d(${pendingPointerEvent.clientX}px, ${pendingPointerEvent.clientY}px, 0) translate3d(-50%, -50%, 0)`;
      });
    }, { passive: true });
  }
}

function setConfigPanelVisible(visible) {
  if (els.emptyState) {
    els.emptyState.style.display = visible ? "none" : "grid";
  }
  if (els.configPanel) {
    els.configPanel.style.display = visible ? "block" : "none";
  }
}

function updateGroupActionState() {
  const isDefaultGroup = Boolean(currentGroup?.is_default_group);
  const isFollowingDefault = Boolean(currentGroup?.config?.[FOLLOW_DEFAULT_KEY]);

  els.resetGroupBtn.disabled = isDefaultGroup || isFollowingDefault;
  els.resetGroupBtn.textContent = isDefaultGroup
    ? "默认群不支持重置"
    : isFollowingDefault
      ? "当前正在跟随默认配置"
      : "恢复当前项默认值";
  els.saveGroupBtn.textContent = isDefaultGroup
    ? "保存默认群模板"
    : "保存当前项配置";
}

function normalizeGroups(groups) {
  return Array.isArray(groups) ? groups : [];
}

function applyGroupList(groups) {
  allGroups = normalizeGroups(groups);
  bootstrapData.groups = allGroups;
  updateShellStats();
  filterAndRenderGroups();
}

function filterGroups() {
  const keyword = String(els.groupSearchInput.value || "")
    .trim()
    .toLowerCase();
  if (!keyword) {
    return allGroups;
  }
  return allGroups.filter((group) => {
    const groupId = String(group.group_id || "").toLowerCase();
    const groupName = String(group.group_name || "").toLowerCase();
    return groupId.includes(keyword) || groupName.includes(keyword);
  });
}

function filterAndRenderGroups() {
  const groups = filterGroups();
  els.groupListCount.textContent = `${groups.length} 个群`;
  renderGroupCards({
    root: els.groupList,
    groups,
    currentGroupId: currentGroup?.group_id || "",
    onSelect: async (groupId) => {
      try {
        await switchGroup(groupId);
      } catch (error) {
        showToast(error.message, "error");
      }
    },
  });
}

function renderGroupForm(groupPayload) {
  currentGroup = groupPayload;
  setConfigPanelVisible(true);

  renderGroupDetailHeader(els, groupPayload);
  renderSchemaFields(
    els.groupForm,
    buildGroupFormSchema(groupPayload),
    buildGroupFormValues(groupPayload),
    {
      singleColumn: false,
      collapsedObjectPaths: COLLAPSED_GROUP_OBJECT_PATHS,
      hiddenFields: groupPayload?.is_default_group ? [FOLLOW_DEFAULT_KEY] : [],
      isFieldDisabled: isGroupFieldDisabled,
    }
  );
  bindFollowDefaultToggle();
  updateGroupActionState();
  updateShellStats();
  filterAndRenderGroups();
}

async function loadBootstrapData() {
  const data = await api.safeGet("settings/bootstrap");
  bootstrapData = data;
  applyGroupList(data.groups || []);
}

async function refreshGroups() {
  const groups = await api.safePost("settings/groups/refresh", {});
  applyGroupList(groups || []);
}

async function loadGroupConfig(groupId, force = false) {
  const target = String(groupId || currentGroup?.group_id || DEFAULT_GROUP_ID).trim();
  if (!target) {
    showToast("先从左侧选择一个群", "error");
    return;
  }

  const data = await api.safeGet("settings/group", {
    group_id: target,
    force: force ? "1" : "0",
  });
  renderGroupForm(data);
}

function bindFollowDefaultToggle() {
  const followDefaultInput = els.groupForm.querySelector(
    `[data-path="${FOLLOW_DEFAULT_KEY}"]`
  );
  if (!followDefaultInput) {
    return;
  }

  followDefaultInput.addEventListener("change", () => {
    if (!currentGroup?.config) {
      return;
    }
    currentGroup.config[FOLLOW_DEFAULT_KEY] = Boolean(followDefaultInput.checked);
    renderGroupForm(currentGroup);
  });
}

function getCurrentGroupFormPayload() {
  const payload = collectFormData(els.groupForm);
  if (currentGroup?.is_default_group) {
    delete payload[FOLLOW_DEFAULT_KEY];
  }
  return payload;
}

async function persistGroupConfig(groupId, options = {}) {
  const {
    refreshList = true,
    rerenderCurrent = true,
    successMessage = "",
  } = options;
  const target = String(groupId || currentGroup?.group_id || "").trim();
  if (!target) {
    showToast("先加载群配置再保存", "error");
    return null;
  }
  const payload = getCurrentGroupFormPayload();
  const data = await api.safePost("settings/group", {
    group_id: target,
    config: payload,
  });
  if (rerenderCurrent) {
    renderGroupForm(data);
  }
  if (refreshList) {
    await refreshGroups();
  }
  if (successMessage) {
    showToast(successMessage);
  }
  return data;
}

async function switchGroup(groupId) {
  const target = String(groupId || "").trim();
  if (!target) {
    return;
  }

  await loadGroupConfig(target);
}

async function saveGroupConfig() {
  const target = String(currentGroup?.group_id || "").trim();
  const data = await persistGroupConfig(target, {
    successMessage: `群 ${target} 配置已保存`,
  });
  return data;
}

async function resetGroupConfig() {
  const target = String(currentGroup?.group_id || "").trim();
  if (!target) {
    showToast("先加载群配置再重置", "error");
    return;
  }
  const data = await api.safePost("settings/group/reset", { group_id: target });
  renderGroupForm(data);
  await refreshGroups();
  showToast(`群 ${target} 已恢复默认群配置`);
}

function bindEvents() {
  els.toggleThemeBtn.addEventListener("click", () => {
    cycleThemePreference();
  });

  els.refreshGroupsBtn.addEventListener("click", async () => {
    try {
      await refreshGroups();
      if (currentGroup?.group_id) {
        await loadGroupConfig(currentGroup.group_id);
      }
      showToast("群列表已同步");
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  els.saveGroupBtn.addEventListener("click", async () => {
    try {
      await saveGroupConfig();
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  els.resetGroupBtn.addEventListener("click", async () => {
    try {
      if (currentGroup?.is_default_group) {
        showToast("默认群模板不支持重置", "error");
        return;
      }
      if (currentGroup?.config?.[FOLLOW_DEFAULT_KEY]) {
        showToast("当前群正在跟随默认配置，无需重置", "error");
        return;
      }
      await resetGroupConfig();
    } catch (error) {
      showToast(error.message, "error");
    }
  });

  els.groupSearchInput.addEventListener("input", () => {
    filterAndRenderGroups();
  });
}

async function init() {
  syncChromeMotion();
  bindSystemTheme();
  updateThemeButton();
  applyThemeMode(resolveThemeMode(null));
  setConfigPanelVisible(false);

  if (!bridge) {
    return;
  }

  try {
    api = createApi(bridge);
    await loadThemePreferenceFromBackend();
    syncThemeFromContext(bridge?.getContext?.());
  } catch (error) {
    return;
  }

  try {
    if (typeof bridge.ready === "function") {
      const context = await Promise.race([
        bridge.ready(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Bridge ready timeout")), 5000)
        ),
      ]);
      syncThemeFromContext(context);
    }

    if (typeof bridge.onContext === "function") {
      detachContextHandler = bridge.onContext((context) => {
        syncThemeFromContext(context);
      });
    } else {
      syncThemeFromContext(bridge.getContext?.());
    }

    bindEvents();
    await loadBootstrapData();
    await loadGroupConfig(DEFAULT_GROUP_ID);
  } catch (error) {
    const message = error?.message || "页面初始化失败";
    showToast(message, "error");
  }
}

window.addEventListener("beforeunload", () => {
  detachContextHandler?.();
  detachSystemThemeHandler?.();
});

init();
