const SOUND_STATE_KEY = "permission-console-sound-state-v3";
const LEGACY_SOUND_STATE_KEY = "permission-console-sound-state-v2";
const LEGACY_BGM_SWITCH_KEY = "permission-controller-background-sound-enabled";
const SOUND_COOKIE_KEY = "permission_console_sound_state";
const DB_NAME = "permission-console-audio";
const DB_VERSION = 1;
const DB_STORE = "files";
const CUSTOM_AUDIO_KEY = "custom-background-audio";
const DEFAULT_TRACK_SRC = "./assets/audio/rebirth-after-disaster.mp3";
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
  waitingForGesture: false,
  assetError: false,
  unlocked: false,
  audioContext: null,
  elements: {},
};

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
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

async function resolveTrackSrc() {
  if (state.source !== "custom") return DEFAULT_TRACK_SRC;
  const blob = await idbGet(CUSTOM_AUDIO_KEY);
  if (!blob) {
    state.source = "default";
    state.trackName = DEFAULT_TRACK_NAME;
    persistState();
    return DEFAULT_TRACK_SRC;
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
  audio.addEventListener("playing", () => {
    state.waitingForGesture = false;
    state.assetError = false;
    updateUi();
  });
  audio.addEventListener("pause", updateUi);
  audio.addEventListener("error", () => {
    state.assetError = true;
    state.waitingForGesture = false;
    updateUi("音频加载失败，已停止播放");
  });
  return audio;
}

async function ensureAudio() {
  const src = await resolveTrackSrc();
  if (state.audio && state.audio.dataset.src === src) return state.audio;
  if (state.audio) state.audio.pause();
  state.audio = createAudio(src);
  state.audio.dataset.src = src;
  return state.audio;
}

async function playBgm() {
  if (!state.bgmEnabled || state.assetError) return;
  const audio = await ensureAudio();
  audio.volume = state.volume;
  try {
    await audio.play();
    state.waitingForGesture = false;
  } catch {
    state.waitingForGesture = true;
  }
  updateUi();
}

function stopBgm() {
  if (state.audio) {
    state.audio.pause();
    state.audio.currentTime = 0;
  }
  state.waitingForGesture = false;
  updateUi();
}

async function setBgmEnabled(enabled) {
  state.bgmEnabled = Boolean(enabled);
  state.unlocked = true;
  state.assetError = false;
  persistState();
  if (state.bgmEnabled) await playBgm();
  else stopBgm();
}

function setButtonEnabled(enabled) {
  state.buttonEnabled = Boolean(enabled);
  persistState();
  updateUi();
}

function toneClick() {
  if (!state.buttonEnabled) return;
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    if (!state.audioContext) state.audioContext = new Context();
    const ctx = state.audioContext;
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(760, now + 0.055);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.28, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
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
  nodes.filter(Boolean).forEach((node) => {
    node.textContent = value;
  });
}

function updateUi(message = "") {
  const els = state.elements;
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
      message ||
      (state.assetError
        ? "音频加载失败"
        : state.bgmEnabled
          ? state.waitingForGesture
            ? "已保存，点击页面后播放"
            : isPlaying
              ? "正在播放，已保存"
              : "已开启，等待播放"
          : "已关闭，已保存");
  }
  if (els.volume) els.volume.value = String(Math.round(state.volume * 100));
  if (els.bgmVisual) els.bgmVisual.classList.toggle("is-active", isPlaying || state.waitingForGesture);
  if (els.buttonVisual) els.buttonVisual.classList.toggle("is-enabled", state.buttonEnabled);
}

async function handleUpload(file) {
  if (!file) return;
  if (!file.type.startsWith("audio/")) {
    updateUi("请选择音频文件");
    return;
  }
  if (file.size > 32 * 1024 * 1024) {
    updateUi("音频文件不能超过 32MB");
    return;
  }
  await idbPut(CUSTOM_AUDIO_KEY, file);
  state.source = "custom";
  state.trackName = file.name || "自定义背景音";
  state.assetError = false;
  persistState();
  if (state.audio) {
    state.audio.pause();
    state.audio = null;
  }
  updateUi("自定义背景音已保存");
  if (state.bgmEnabled) await playBgm();
}

async function resetTrack() {
  await idbDelete(CUSTOM_AUDIO_KEY).catch(() => {});
  revokeCustomUrl();
  state.source = "default";
  state.trackName = DEFAULT_TRACK_NAME;
  state.assetError = false;
  if (state.audio) {
    state.audio.pause();
    state.audio = null;
  }
  persistState();
  updateUi("已恢复默认背景音");
  if (state.bgmEnabled) await playBgm();
}

function bindGlobalButtonSound() {
  document.addEventListener(
    "click",
    (event) => {
      const button = event.target?.closest?.("button");
      if (!button || button.disabled) return;
      toneClick();
    },
    true,
  );
}

function unlockFromGesture() {
  state.unlocked = true;
  if (state.bgmEnabled && state.waitingForGesture) playBgm().catch(() => {});
}

function bindLifecycle() {
  window.addEventListener("pointerdown", unlockFromGesture, { capture: true });
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
  els.buttonToggle?.addEventListener("click", () => setButtonEnabled(!state.buttonEnabled));
  els.upload?.addEventListener("click", () => els.input?.click());
  els.input?.addEventListener("change", () => {
    handleUpload(els.input.files?.[0]).catch((err) => updateUi(err.message || "上传失败"));
    els.input.value = "";
  });
  els.reset?.addEventListener("click", () => resetTrack().catch((err) => updateUi(err.message || "恢复失败")));
  els.volume?.addEventListener("input", () => {
    state.volume = clamp(Number(els.volume.value) / 100, 0, 1);
    if (state.audio) state.audio.volume = state.volume;
    persistState();
    updateUi();
  });
}

async function restoreCustomNameIfNeeded() {
  if (state.source !== "custom") return;
  try {
    const blob = await idbGet(CUSTOM_AUDIO_KEY);
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

async function initSoundModule() {
  loadState();
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
    reset: document.getElementById("resetAudioBtn"),
    volume: document.getElementById("bgmVolumeInput"),
    bgmVisual: document.getElementById("soundVisualBgm"),
    buttonVisual: document.getElementById("soundVisualButton"),
  };
  bindControls();
  bindGlobalButtonSound();
  bindLifecycle();
  await restoreCustomNameIfNeeded();
  persistState();
  updateUi();
  if (state.bgmEnabled) {
    state.waitingForGesture = true;
    playBgm().catch(() => updateUi());
  }
  window.PermissionConsoleSound = {
    playClick: toneClick,
    getState: () => ({
      bgmEnabled: state.bgmEnabled,
      buttonEnabled: state.buttonEnabled,
      source: state.source,
      trackName: state.trackName,
      volume: state.volume,
      waitingForGesture: state.waitingForGesture,
    }),
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initSoundModule().catch(() => updateUi("音效模块初始化失败")), { once: true });
} else {
  initSoundModule().catch(() => updateUi("音效模块初始化失败"));
}
