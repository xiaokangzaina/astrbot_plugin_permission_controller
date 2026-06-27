const SOUND_STATE_KEY = "permission-console-sound-state-v3";
const LEGACY_SOUND_STATE_KEY = "permission-console-sound-state-v2";
const LEGACY_BGM_SWITCH_KEY = "permission-controller-background-sound-enabled";
const SOUND_COOKIE_KEY = "permission_console_sound_state";
const DB_NAME = "permission-console-audio";
const DB_VERSION = 1;
const DB_STORE = "files";
const CUSTOM_AUDIO_KEY = "custom-background-audio";
const DEFAULT_TRACK_PATH = "assets/audio/rebirth-after-disaster.mp3";
const DEFAULT_AUDIO_ENDPOINT = "settings/audio/default";
const AUDIO_STATE_ENDPOINT = "settings/audio/state";
const CUSTOM_AUDIO_ENDPOINT = "settings/audio/custom";
const CUSTOM_AUDIO_RESET_ENDPOINT = "settings/audio/custom/reset";
const AUDIO_CACHE_VERSION = "permission_console_audio_20260627_v330";
const DEFAULT_TRACK_CANDIDATES = buildDefaultTrackCandidates();
const DEFAULT_TRACK_SRC = DEFAULT_TRACK_CANDIDATES[0] || DEFAULT_TRACK_PATH;
const DEFAULT_TRACK_NAME = "小k橘子 - 劫后余生.mp3";

const defaultState = {
  bgmEnabled: false,
  buttonEnabled: true,
  source: "default",
  trackName: DEFAULT_TRACK_NAME,
  volume: 0.76,
};

const state = {
  ...defaultState,
  audio: null,
  customUrl: "",
  defaultUrl: "",
  waitingForGesture: false,
  assetError: false,
  unlocked: false,
  lastPlayError: "",
  audioContext: null,
  defaultTrackIndex: 0,
  elements: {},
};

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function assetUrlFrom(baseUrl) {
  try {
    if (!baseUrl || String(baseUrl).startsWith("blob:")) return "";
    const base = new URL(baseUrl, document.baseURI);
    const target = new URL(DEFAULT_TRACK_PATH, base);
    base.searchParams.forEach((value, key) => {
      if (key !== "v" && !target.searchParams.has(key)) target.searchParams.set(key, value);
    });
    return target.href;
  } catch {
    return "";
  }
}

function defaultAudioAssetUrl() {
  const href = document.getElementById("defaultAudioAsset")?.href || "";
  return href && !href.startsWith("blob:") ? href : "";
}

function buildDefaultTrackCandidates() {
  const scriptUrl = Array.from(document.scripts)
    .map((script) => script.src || "")
    .reverse()
    .find((src) => /(^|\/)sound\.js(?:[?#]|$)/.test(src));
  return [
    defaultAudioAssetUrl(),
    assetUrlFrom(import.meta.url),
    assetUrlFrom(scriptUrl),
    assetUrlFrom(document.baseURI),
    assetUrlFrom(window.location.href),
  ].filter((url, index, list) => url && list.indexOf(url) === index);
}

function defaultTrackCandidateSrc() {
  return DEFAULT_TRACK_CANDIDATES[state.defaultTrackIndex] || DEFAULT_TRACK_SRC;
}

function defaultTrackSrc() {
  return state.defaultUrl || defaultTrackCandidateSrc();
}

function withAudioCacheBust(url) {
  try {
    const target = new URL(url, document.baseURI);
    target.searchParams.set("v", AUDIO_CACHE_VERSION);
    return target.href;
  } catch {
    return url;
  }
}

function playableAudioBlob(blob, contentType = "") {
  const mime = String(contentType || blob?.type || "").toLowerCase();
  if (blob instanceof Blob && mime.startsWith("audio/")) return blob;
  return new Blob([blob], { type: "audio/mpeg" });
}

function bridgeData(response) {
  if (
    response &&
    typeof response === "object" &&
    Object.prototype.hasOwnProperty.call(response, "ok")
  ) {
    if (!response.ok) throw new Error(response.message || "默认音频接口读取失败");
    return Object.prototype.hasOwnProperty.call(response, "data") ? response.data : response;
  }
  return response;
}

function bridgeApiGet(endpoint) {
  const apiGet = window.AstrBotPluginPage?.apiGet?.bind(window.AstrBotPluginPage);
  if (!apiGet) throw new Error("插件页面接口不可用");
  return apiGet(endpoint);
}

function bridgeApiPost(endpoint, payload) {
  const apiPost = window.AstrBotPluginPage?.apiPost?.bind(window.AstrBotPluginPage);
  if (!apiPost) throw new Error("插件页面接口不可用");
  return apiPost(endpoint, payload);
}

function base64ToBlob(content, mime = "audio/mpeg") {
  const binary = window.atob(String(content || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime || "audio/mpeg" });
}

async function fetchDefaultTrackBlobFromUrl(url) {
  const response = await withTimeout(
    fetch(withAudioCacheBust(url), { cache: "reload", credentials: "same-origin" }),
    3500,
    "默认音频读取超时",
  );
  if (!response.ok) throw new Error(`默认音频读取失败 ${response.status}`);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const blob = await withTimeout(response.blob(), 3500, "默认音频解析超时");
  if (blob.size < 1024 || contentType.includes("text/html") || contentType.includes("application/json")) {
    throw new Error("默认音频路径返回的不是音频文件");
  }
  return playableAudioBlob(blob, contentType);
}

async function fetchDefaultTrackBlobFromBridge() {
  const apiGet = window.AstrBotPluginPage?.apiGet?.bind(window.AstrBotPluginPage);
  if (!apiGet) throw new Error("插件音频接口不可用");
  const data = bridgeData(
    await withTimeout(apiGet(DEFAULT_AUDIO_ENDPOINT), 5000, "默认音频接口读取超时"),
  );
  if (!data || typeof data.content !== "string" || data.content.length < 1024) {
    throw new Error("默认音频接口返回为空");
  }
  return base64ToBlob(data.content, data.mime || "audio/mpeg");
}

function fileToBase64Content(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.onerror = () => reject(reader.error || new Error("读取音频文件失败"));
    reader.readAsDataURL(file);
  });
}

async function fetchCustomTrackBlobFromBridge() {
  const apiGet = window.AstrBotPluginPage?.apiGet?.bind(window.AstrBotPluginPage);
  if (!apiGet) throw new Error("自定义音频接口不可用");
  const data = bridgeData(
    await withTimeout(apiGet(CUSTOM_AUDIO_ENDPOINT), 5000, "自定义音频接口读取超时"),
  );
  if (!data?.exists || typeof data.content !== "string" || data.content.length < 16) {
    throw new Error("未找到已上传的自定义背景音");
  }
  return {
    blob: base64ToBlob(data.content, data.mime || "audio/mpeg"),
    fileName: String(data.fileName || ""),
  };
}

async function saveCustomTrackToBridge(file) {
  const apiPost = window.AstrBotPluginPage?.apiPost?.bind(window.AstrBotPluginPage);
  if (!apiPost) throw new Error("自定义音频上传接口不可用");
  const content = await fileToBase64Content(file);
  return bridgeData(
    await withTimeout(
      apiPost(CUSTOM_AUDIO_ENDPOINT, {
        fileName: file.name || "custom-background-audio",
        mime: file.type || "audio/mpeg",
        content,
      }),
      12000,
      "自定义音频上传超时",
    ),
  );
}

async function deleteCustomTrackFromBridge() {
  const apiPost = window.AstrBotPluginPage?.apiPost?.bind(window.AstrBotPluginPage);
  if (!apiPost) return null;
  return bridgeData(
    await withTimeout(apiPost(CUSTOM_AUDIO_RESET_ENDPOINT, {}), 3000, "自定义音频重置超时"),
  );
}

async function saveCustomAudioFile(file) {
  try {
    const saved = await saveCustomTrackToBridge(file);
    return { backend: true, fileName: saved?.fileName || file.name || "自定义背景音" };
  } catch (backendError) {
    try {
      await idbPut(CUSTOM_AUDIO_KEY, file);
      return { backend: false, fileName: file.name || "自定义背景音" };
    } catch {
      throw new Error(
        "自定义背景音保存失败：当前插件设置环境禁止 IndexedDB，请重载插件后再上传。",
      );
    }
  }
}

function withTimeout(promise, timeoutMs, message) {
  let timer = 0;
  return Promise.race([
    promise.finally(() => window.clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]);
}

function readCookie(name) {
  try {
    const prefix = `${name}=`;
    const item = (document.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix));
    return item ? decodeURIComponent(item.slice(prefix.length)) : "";
  } catch {
    return "";
  }
}

function writeCookie(name, value) {
  try {
    document.cookie = `${name}=${encodeURIComponent(value)}; max-age=31536000; path=/; SameSite=Lax`;
  } catch {}
}

function readStoredJson(key) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function readLegacyBgmSwitch() {
  let stored = "";
  try {
    stored = window.localStorage.getItem(LEGACY_BGM_SWITCH_KEY) || "";
  } catch {}
  if (!stored) {
    const cookieValue = readCookie(LEGACY_BGM_SWITCH_KEY);
    stored = cookieValue || "";
  }
  return stored === "on" ? true : stored === "off" ? false : null;
}

function loadState() {
  const payload =
    readStoredJson(SOUND_STATE_KEY) ||
    readStoredJson(LEGACY_SOUND_STATE_KEY) ||
    readStoredJsonFromCookie();
  if (payload && typeof payload === "object") {
    state.bgmEnabled = Boolean(payload.bgmEnabled);
    state.buttonEnabled = payload.buttonEnabled !== false;
    state.source = payload.source === "custom" ? "custom" : "default";
    state.trackName = String(payload.trackName || DEFAULT_TRACK_NAME);
    state.volume = clamp(payload.volume ?? defaultState.volume, 0, 1);
  } else {
    const legacySwitch = readLegacyBgmSwitch();
    if (legacySwitch !== null) state.bgmEnabled = legacySwitch;
  }
}

function readStoredJsonFromCookie() {
  try {
    return JSON.parse(readCookie(SOUND_COOKIE_KEY) || "null");
  } catch {
    return null;
  }
}

function persistState() {
  const payload = JSON.stringify({
    bgmEnabled: state.bgmEnabled,
    buttonEnabled: state.buttonEnabled,
    source: state.source,
    trackName: state.trackName,
    volume: state.volume,
  });
  try {
    window.localStorage.setItem(SOUND_STATE_KEY, payload);
    window.localStorage.setItem(LEGACY_BGM_SWITCH_KEY, state.bgmEnabled ? "on" : "off");
  } catch {}
  writeCookie(SOUND_COOKIE_KEY, payload);
  writeCookie(LEGACY_BGM_SWITCH_KEY, state.bgmEnabled ? "on" : "off");
}

function audioStatePayload() {
  return {
    bgmEnabled: state.bgmEnabled,
    buttonEnabled: state.buttonEnabled,
    source: state.source,
    trackName: state.trackName || DEFAULT_TRACK_NAME,
    volume: state.volume,
  };
}

function hasLocalAudioPreference() {
  return (
    state.bgmEnabled !== defaultState.bgmEnabled ||
    state.buttonEnabled !== defaultState.buttonEnabled ||
    state.source !== defaultState.source ||
    state.volume !== defaultState.volume ||
    Boolean(state.trackName && state.trackName !== DEFAULT_TRACK_NAME)
  );
}

function applyAudioStatePayload(payload) {
  if (!payload || typeof payload !== "object") return;
  state.bgmEnabled = Boolean(payload.bgmEnabled);
  state.buttonEnabled = payload.buttonEnabled !== false;
  state.source = payload.source === "custom" ? "custom" : "default";
  state.trackName = String(payload.trackName || DEFAULT_TRACK_NAME);
  state.volume = clamp(payload.volume ?? defaultState.volume, 0, 1);
}

async function persistStateToBackend() {
  if (!window.AstrBotPluginPage?.apiPost) return null;
  try {
    return bridgeData(
      await withTimeout(
        bridgeApiPost(AUDIO_STATE_ENDPOINT, audioStatePayload()),
        2500,
        "音频状态保存超时",
      ),
    );
  } catch {
    return null;
  }
}

async function loadStateFromBackend() {
  if (!window.AstrBotPluginPage?.apiGet) return false;
  try {
    const payload = bridgeData(
      await withTimeout(
        bridgeApiGet(AUDIO_STATE_ENDPOINT),
        2500,
        "音频状态读取超时",
      ),
    );
    if (payload?.persisted) {
      applyAudioStatePayload(payload);
      persistState();
      return true;
    }
    if (hasLocalAudioPreference()) await persistStateToBackend();
  } catch {}
  return false;
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("当前浏览器不支持本地音频保存"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("打开音频存储失败"));
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("读取音频失败"));
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("保存音频失败"));
    };
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error("删除音频失败"));
    };
  });
}

function revokeCustomUrl() {
  if (state.customUrl) URL.revokeObjectURL(state.customUrl);
  state.customUrl = "";
}

function revokeDefaultUrl() {
  if (state.defaultUrl) URL.revokeObjectURL(state.defaultUrl);
  state.defaultUrl = "";
}

async function resolveDefaultTrackSrc() {
  if (state.defaultUrl) return state.defaultUrl;
  const candidates = DEFAULT_TRACK_CANDIDATES.length ? DEFAULT_TRACK_CANDIDATES : [DEFAULT_TRACK_SRC];
  const startIndex = clamp(state.defaultTrackIndex, 0, Math.max(0, candidates.length - 1));
  for (let index = startIndex; index < candidates.length; index += 1) {
    const url = candidates[index];
    try {
      const playableBlob = await fetchDefaultTrackBlobFromUrl(url);
      revokeDefaultUrl();
      state.defaultUrl = URL.createObjectURL(playableBlob);
      state.defaultTrackIndex = index;
      state.lastPlayError = "";
      return state.defaultUrl;
    } catch (err) {
      state.lastPlayError = err?.message || "默认音频读取失败";
    }
  }
  try {
    const playableBlob = await fetchDefaultTrackBlobFromBridge();
    revokeDefaultUrl();
    state.defaultUrl = URL.createObjectURL(playableBlob);
    state.defaultTrackIndex = 0;
    state.lastPlayError = "";
    return state.defaultUrl;
  } catch (err) {
    const message = err?.message || "默认音频读取失败";
    state.lastPlayError = /路由|route|404/i.test(message)
      ? "默认音频接口未注册，静态音源读取失败"
      : message;
  }
  throw new Error(state.lastPlayError || "默认音频读取失败");
}

async function resolveTrackSrc() {
  if (state.source !== "custom") return resolveDefaultTrackSrc();
  try {
    const custom = await fetchCustomTrackBlobFromBridge();
    revokeCustomUrl();
    state.customUrl = URL.createObjectURL(custom.blob);
    if (custom.fileName) state.trackName = custom.fileName;
    state.lastPlayError = "";
    return state.customUrl;
  } catch (err) {
    state.lastPlayError = err?.message || "自定义音频接口读取失败";
  }
  let blob = null;
  try {
    blob = await withTimeout(idbGet(CUSTOM_AUDIO_KEY), 1800, "读取自定义音频超时");
  } catch {
    blob = null;
  }
  if (!blob) {
    state.source = "default";
    state.trackName = DEFAULT_TRACK_NAME;
    state.assetError = false;
    state.defaultTrackIndex = 0;
    persistState();
    await persistStateToBackend();
    return resolveDefaultTrackSrc();
  }
  revokeCustomUrl();
  state.customUrl = URL.createObjectURL(blob);
  return state.customUrl;
}

function createAudio(src) {
  const audio = new Audio(src);
  audio.loop = true;
  audio.preload = "auto";
  audio.volume = state.volume;
  audio.className = "visually-hidden";
  audio.dataset.src = src;
  audio.setAttribute("aria-hidden", "true");
  audio.setAttribute("data-permission-console-audio", "background");
  document.body.appendChild(audio);
  audio.addEventListener("canplay", () => {
    state.assetError = false;
    updateUi();
  });
  audio.addEventListener("playing", () => {
    state.waitingForGesture = false;
    state.assetError = false;
    updateUi();
  });
  audio.addEventListener("pause", () => updateUi());
  audio.addEventListener("error", () => {
    if (state.source === "custom") {
      state.waitingForGesture = false;
      resetTrack().catch(() => {
        state.assetError = true;
        updateUi("自定义音频加载失败，请重新上传");
      });
      updateUi("自定义音频加载失败，已恢复默认");
      return;
    }
    if (state.defaultTrackIndex < DEFAULT_TRACK_CANDIDATES.length - 1) {
      state.defaultTrackIndex += 1;
      state.assetError = false;
      state.waitingForGesture = true;
      revokeDefaultUrl();
      if (state.audio === audio) state.audio = null;
      audio.remove();
      updateUi("默认音频路径切换中");
      playBgm().catch(() => updateUi("音频加载失败，等待点击后重试"));
      return;
    }
    state.assetError = true;
    state.waitingForGesture = false;
    updateUi("音频加载失败，已停止播放");
  });
  audio.load();
  return audio;
}

async function ensureAudio() {
  const src = await resolveTrackSrc();
  if (state.audio && state.audio.dataset.src === src) return state.audio;
  if (state.audio) {
    state.audio.pause();
    state.audio.remove();
  }
  state.audio = createAudio(src);
  return state.audio;
}

function getReusableAudio() {
  if (!state.audio) return null;
  const expectedSrc = state.source === "default" ? defaultTrackSrc() : state.customUrl;
  if (!expectedSrc || state.audio.dataset.src !== expectedSrc) return null;
  return state.audio;
}

async function playBgm() {
  if (!state.bgmEnabled || state.assetError) return;
  const audio = getReusableAudio() || await ensureAudio();
  audio.volume = state.volume;
  if (typeof audio.play !== "function") {
    state.waitingForGesture = true;
    state.lastPlayError = "当前环境不支持音频播放";
    updateUi();
    return;
  }
  try {
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.then === "function") await playPromise;
    state.waitingForGesture = false;
    state.lastPlayError = "";
  } catch (err) {
    state.waitingForGesture = true;
    state.lastPlayError =
      err?.name === "NotAllowedError"
        ? "已保存，点击页面或 BGM 按钮播放"
        : err?.message || "音频播放失败，点击后重试";
  }
  updateUi();
}

function stopBgm() {
  if (state.audio) {
    state.audio.pause();
    state.audio.currentTime = 0;
  }
  state.waitingForGesture = false;
  state.lastPlayError = "";
  updateUi();
}

async function setBgmEnabled(enabled) {
  state.bgmEnabled = Boolean(enabled);
  state.unlocked = true;
  state.assetError = false;
  persistState();
  await persistStateToBackend();
  if (state.bgmEnabled) await playBgm();
  else stopBgm();
}

async function setButtonEnabled(enabled) {
  state.buttonEnabled = Boolean(enabled);
  persistState();
  await persistStateToBackend();
  updateUi();
}

const BUTTON_SOUND_PRESETS = {
  click: [
    { type: "sine", from: 520, to: 760, delay: 0, duration: 0.16, peak: 0.22 },
  ],
  save: [
    { type: "triangle", from: 660, to: 880, delay: 0, duration: 0.13, peak: 0.18 },
    { type: "sine", from: 990, to: 1320, delay: 0.075, duration: 0.18, peak: 0.14 },
  ],
  reset: [
    { type: "sine", from: 390, to: 260, delay: 0, duration: 0.18, peak: 0.18 },
  ],
  toggle: [
    { type: "triangle", from: 470, to: 620, delay: 0, duration: 0.12, peak: 0.16 },
  ],
  upload: [
    { type: "sine", from: 590, to: 900, delay: 0, duration: 0.14, peak: 0.17 },
    { type: "triangle", from: 900, to: 1120, delay: 0.055, duration: 0.12, peak: 0.10 },
  ],
  sync: [
    { type: "sine", from: 480, to: 640, delay: 0, duration: 0.10, peak: 0.13 },
    { type: "sine", from: 640, to: 520, delay: 0.075, duration: 0.10, peak: 0.11 },
  ],
};

function buttonSoundKind(button) {
  const declared = button?.dataset?.sound;
  if (declared && BUTTON_SOUND_PRESETS[declared]) return declared;
  switch (button?.id) {
    case "saveGroupBtn":
      return "save";
    case "resetGroupBtn":
    case "resetAudioBtn":
      return "reset";
    case "uploadAudioTopBtn":
    case "uploadAudioBtn":
      return "upload";
    case "refreshGroupsBtn":
      return "sync";
    case "buttonSoundToggle":
    case "backgroundMusicToggle":
    case "toggleThemeBtn":
      return "toggle";
    default:
      return "click";
  }
}

function playToneStep(ctx, step, baseTime) {
  const start = baseTime + step.delay;
  const end = start + step.duration;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = step.type;
  osc.frequency.setValueAtTime(step.from, start);
  osc.frequency.exponentialRampToValueAtTime(step.to, start + Math.min(step.duration * 0.55, 0.08));
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(step.peak, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(start);
  osc.stop(end + 0.02);
}

function toneClick(kind = "click") {
  if (!state.buttonEnabled) return;
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    if (!state.audioContext) state.audioContext = new Context();
    const ctx = state.audioContext;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const preset = BUTTON_SOUND_PRESETS[kind] || BUTTON_SOUND_PRESETS.click;
    const now = ctx.currentTime + 0.002;
    preset.forEach((step) => playToneStep(ctx, step, now));
    pulseButtonVisual();
  } catch {}
}

function pulseButtonVisual() {
  const node = state.elements.buttonVisual;
  if (!node) return;
  node.classList.add("is-active");
  window.clearTimeout(pulseButtonVisual.timer);
  pulseButtonVisual.timer = window.setTimeout(() => node.classList.remove("is-active"), 520);
}

function setText(nodes, value) {
  const list = Array.isArray(nodes) ? nodes : [nodes];
  list.filter(Boolean).forEach((node) => {
    node.textContent = value;
  });
}

function updateUi(message = "") {
  const els = state.elements;
  const statusMessage = typeof message === "string" && message !== "[object Event]" ? message : "";
  const isPlaying = Boolean(state.audio && !state.audio.paused && state.bgmEnabled);
  document.body.classList.toggle("sound-bgm-on", state.bgmEnabled);
  if (els.card) els.card.classList.toggle("is-playing", isPlaying);
  if (els.led) els.led.textContent = isPlaying ? "播放中" : state.bgmEnabled ? "已开启" : "待机";
  if (els.bgmToggle) {
    els.bgmToggle.classList.toggle("is-on", state.bgmEnabled);
    els.bgmToggle.setAttribute("aria-pressed", String(state.bgmEnabled));
    els.bgmToggle.title = state.bgmEnabled ? "关闭背景音乐" : "开启背景音乐";
    els.bgmToggle.setAttribute("aria-label", els.bgmToggle.title);
  }
  setText(els.bgmText, state.bgmEnabled ? "BGM开" : "BGM关");
  if (els.buttonToggle) {
    els.buttonToggle.classList.toggle("is-on", state.buttonEnabled);
    els.buttonToggle.setAttribute("aria-pressed", String(state.buttonEnabled));
    els.buttonToggle.title = state.buttonEnabled ? "关闭按钮音效" : "开启按钮音效";
    els.buttonToggle.setAttribute("aria-label", els.buttonToggle.title);
  }
  setText(els.buttonText, state.buttonEnabled ? "音效开" : "音效关");
  if (els.buttonStatus) {
    els.buttonStatus.textContent = state.buttonEnabled ? "按钮音效开启" : "按钮音效关闭";
  }
  setText(els.trackName, state.trackName || DEFAULT_TRACK_NAME);
  if (els.trackLabel) {
    els.trackLabel.textContent = `${state.trackName || DEFAULT_TRACK_NAME} · ${
      state.source === "custom" ? "自定义背景音" : "默认曲目"
    }`;
  }
  if (els.status) {
    els.status.textContent =
      statusMessage ||
      (state.assetError
        ? "音频加载失败"
        : state.bgmEnabled
          ? state.waitingForGesture
            ? state.lastPlayError || "已保存，点击页面后播放"
            : isPlaying
              ? "正在播放，已保存"
              : "已开启，等待播放"
          : "背景音乐关闭 · 已保存");
  }
  if (els.volume) els.volume.value = String(Math.round(state.volume * 100));
  if (els.bgmVisual) els.bgmVisual.classList.toggle("is-active", isPlaying || state.waitingForGesture);
  if (els.buttonVisual) els.buttonVisual.classList.toggle("is-enabled", state.buttonEnabled);
}

function isLikelyAudioFile(file) {
  if (!file) return false;
  if (String(file.type || "").startsWith("audio/")) return true;
  return /\.(aac|flac|m4a|mp3|oga|ogg|opus|wav|weba|webm)$/i.test(String(file.name || ""));
}

async function handleUpload(file) {
  if (!file) return;
  if (!isLikelyAudioFile(file)) {
    updateUi("请选择音频文件");
    return;
  }
  if (file.size > 32 * 1024 * 1024) {
    updateUi("音频文件不能超过 32MB");
    return;
  }
  const saved = await saveCustomAudioFile(file);
  state.source = "custom";
  state.trackName = saved.fileName || file.name || "自定义背景音";
  state.assetError = false;
  persistState();
  await persistStateToBackend();
  if (state.audio) {
    state.audio.pause();
    state.audio.remove();
    state.audio = null;
  }
  updateUi(saved.backend ? "自定义背景音已保存到插件" : "自定义背景音已保存到浏览器");
  if (state.bgmEnabled) await playBgm();
}

async function resetTrack() {
  await deleteCustomTrackFromBridge().catch(() => {});
  await idbDelete(CUSTOM_AUDIO_KEY).catch(() => {});
  revokeCustomUrl();
  state.source = "default";
  state.trackName = DEFAULT_TRACK_NAME;
  state.assetError = false;
  state.defaultTrackIndex = 0;
  if (state.audio) {
    state.audio.pause();
    state.audio.remove();
    state.audio = null;
  }
  persistState();
  await persistStateToBackend();
  updateUi("已恢复默认背景音");
  if (state.bgmEnabled) await playBgm();
}

function bindGlobalButtonSound() {
  document.addEventListener(
    "click",
    (event) => {
      const button = event.target?.closest?.("button");
      if (!button || button.disabled) return;
      toneClick(buttonSoundKind(button));
    },
    true,
  );
}

function unlockFromGesture() {
  state.unlocked = true;
  if (!state.bgmEnabled || !state.waitingForGesture || state.assetError) return;
  const audio = getReusableAudio();
  if (audio) {
    audio.volume = state.volume;
    if (typeof audio.play !== "function") {
      state.lastPlayError = "当前环境不支持音频播放";
      updateUi();
      return;
    }
    const playPromise = audio.play();
    Promise.resolve(playPromise)
      .then(() => {
        state.waitingForGesture = false;
        state.assetError = false;
        state.lastPlayError = "";
        updateUi();
      })
      .catch((err) => {
        state.lastPlayError =
          err?.name === "NotAllowedError"
            ? "已保存，点击页面或 BGM 按钮播放"
            : err?.message || "音频播放失败，点击后重试";
        updateUi();
      });
    return;
  }
  playBgm().catch(() => {});
}

function bindLifecycle() {
  window.addEventListener("pointerdown", unlockFromGesture, { capture: true });
  window.addEventListener("pointerup", unlockFromGesture, { capture: true });
  window.addEventListener("click", unlockFromGesture, { capture: true });
  window.addEventListener("keydown", unlockFromGesture, { capture: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.audio && !state.audio.paused) state.audio.pause();
      return;
    }
    if (state.bgmEnabled && state.unlocked) playBgm().catch(() => {});
  });
}

function bindControls() {
  const els = state.elements;
  els.bgmToggle?.addEventListener("click", () => {
    setBgmEnabled(!state.bgmEnabled).catch((err) => updateUi(err.message || "背景音乐切换失败"));
  });
  els.buttonToggle?.addEventListener("click", () => {
    setButtonEnabled(!state.buttonEnabled).catch((err) => updateUi(err.message || "按钮音效切换失败"));
  });
  els.upload?.addEventListener("click", () => els.input?.click());
  els.uploadTop?.addEventListener("click", () => els.input?.click());
  els.input?.addEventListener("change", () => {
    handleUpload(els.input.files?.[0]).catch((err) => updateUi(err.message || "上传失败"));
    els.input.value = "";
  });
  els.reset?.addEventListener("click", () => resetTrack().catch((err) => updateUi(err.message || "恢复失败")));
  els.volume?.addEventListener("input", () => {
    state.volume = clamp(Number(els.volume.value) / 100, 0, 1);
    if (state.audio) state.audio.volume = state.volume;
    persistState();
    persistStateToBackend().catch(() => {});
    updateUi();
  });
}

async function restoreCustomNameIfNeeded() {
  if (state.source !== "custom") return;
  try {
    const custom = await fetchCustomTrackBlobFromBridge();
    if (custom.fileName) {
      state.trackName = custom.fileName;
      persistState();
      return;
    }
  } catch {}
  try {
    const blob = await withTimeout(idbGet(CUSTOM_AUDIO_KEY), 1800, "读取自定义音频超时");
    if (!blob) {
      state.source = "default";
      state.trackName = DEFAULT_TRACK_NAME;
      persistState();
    }
  } catch {
    state.source = "default";
    state.trackName = DEFAULT_TRACK_NAME;
    persistState();
  }
}

function getPublicState() {
  const audio = state.audio;
  return {
    bgmEnabled: state.bgmEnabled,
    buttonEnabled: state.buttonEnabled,
    source: state.source,
    trackName: state.trackName,
    volume: state.volume,
    waitingForGesture: state.waitingForGesture,
    assetError: state.assetError,
    audioSrc: audio?.currentSrc || audio?.src || defaultTrackSrc(),
    audioPaused: audio ? audio.paused : true,
    audioReadyState: audio ? audio.readyState : 0,
    defaultTrackIndex: state.defaultTrackIndex,
  };
}

function installPublicApi() {
  window.PermissionConsoleSound = {
    playClick: toneClick,
    getState: getPublicState,
    playBgm: () => setBgmEnabled(true),
    stopBgm: () => setBgmEnabled(false),
  };
}

function reportInitError(error) {
  console.error("[PermissionConsoleSound] 初始化失败", error);
  installPublicApi();
  updateUi("音效模块初始化失败");
}

async function initSoundModule() {
  loadState();
  await loadStateFromBackend();
  state.elements = {
    card: document.getElementById("soundCard"),
    led: document.getElementById("soundLed"),
    bgmToggle: document.getElementById("backgroundMusicToggle") || document.getElementById("bgmToggleBtn"),
    bgmText: [
      document.getElementById("backgroundMusicText"),
      document.getElementById("bgmStateText"),
    ],
    buttonToggle: document.getElementById("buttonSoundToggle"),
    buttonText: [document.getElementById("buttonSoundText")],
    buttonStatus: document.getElementById("buttonSoundStatus"),
    trackName: [document.getElementById("bgmNameLabel")],
    trackLabel: document.getElementById("bgmTrackLabel"),
    status: document.getElementById("bgmStatusText"),
    input: document.getElementById("audioUploadInput"),
    upload: document.getElementById("uploadAudioBtn"),
    uploadTop: document.getElementById("uploadAudioTopBtn"),
    reset: document.getElementById("resetAudioBtn"),
    volume: document.getElementById("bgmVolumeInput"),
    bgmVisual: document.getElementById("soundVisualBgm"),
    buttonVisual: document.getElementById("soundVisualButton"),
  };
  installPublicApi();
  bindControls();
  bindGlobalButtonSound();
  bindLifecycle();
  updateUi();
  if (state.source === "default") {
    ensureAudio().then(updateUi).catch(() => {});
  }
  await restoreCustomNameIfNeeded();
  persistState();
  await persistStateToBackend();
  updateUi();
  if (state.bgmEnabled) {
    state.waitingForGesture = true;
    playBgm().catch(() => updateUi());
  }
  installPublicApi();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initSoundModule().catch(reportInitError), { once: true });
} else {
  initSoundModule().catch(reportInitError);
}
