const SOUND_STATE_KEY = "permission-console-sound-state-v2";
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
  volume: 0.62,
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

function loadState() {
  let payload = null;
  try {
    payload = JSON.parse(window.localStorage.getItem(SOUND_STATE_KEY) || "null");
  } catch {}
  if (!payload) {
    try {
      payload = JSON.parse(readCookie(SOUND_COOKIE_KEY) || "null");
    } catch {}
  }
  if (!payload || typeof payload !== "object") return;
  state.bgmEnabled = Boolean(payload.bgmEnabled);
  state.buttonEnabled = payload.buttonEnabled !== false;
  state.source = payload.source === "custom" ? "custom" : "default";
  state.trackName = String(payload.trackName || DEFAULT_TRACK_NAME);
  state.volume = clamp(payload.volume ?? defaultState.volume, 0, 1);
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
  } catch {}
  writeCookie(SOUND_COOKIE_KEY, payload);
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
    osc.type = "triangle";
    osc.frequency.setValueAtTime(560, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.06);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.20, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.15);
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

function updateUi(message = "") {
  const els = state.elements;
  const isPlaying = Boolean(state.audio && !state.audio.paused && state.bgmEnabled);
  document.body.classList.toggle("sound-bgm-on", state.bgmEnabled);
  if (els.card) els.card.classList.toggle("is-playing", isPlaying);
  if (els.bgmToggle) {
    els.bgmToggle.classList.toggle("is-on", state.bgmEnabled);
    els.bgmToggle.setAttribute("aria-pressed", String(state.bgmEnabled));
    els.bgmToggle.title = state.bgmEnabled ? "关闭背景音乐" : "开启背景音乐";
  }
  if (els.bgmText) els.bgmText.textContent = state.bgmEnabled ? "BGM 开" : "BGM 关";
  if (els.buttonToggle) {
    els.buttonToggle.classList.toggle("is-on", state.buttonEnabled);
    els.buttonToggle.setAttribute("aria-pressed", String(state.buttonEnabled));
    els.buttonToggle.title = state.buttonEnabled ? "关闭按钮音效" : "开启按钮音效";
  }
  if (els.buttonText) els.buttonText.textContent = state.buttonEnabled ? "按钮音效开" : "按钮音效关";
  if (els.buttonStatus) els.buttonStatus.textContent = state.buttonEnabled ? "按钮音效开启" : "按钮音效关闭";
  if (els.name) els.name.textContent = state.trackName || DEFAULT_TRACK_NAME;
  if (els.status) {
    els.status.textContent =
      message ||
      (state.assetError
        ? "音频加载失败"
        : state.bgmEnabled
          ? state.waitingForGesture
            ? "已保存，点击页面后播放"
            : isPlaying
              ? "正在播放，已同步"
              : "已保存，等待播放"
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
  if (file.size > 24 * 1024 * 1024) {
    updateUi("音频文件不能超过 24MB");
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
    bgmToggle: document.getElementById("backgroundMusicToggle"),
    bgmText: document.getElementById("backgroundMusicText"),
    buttonToggle: document.getElementById("buttonSoundToggle"),
    buttonText: document.getElementById("buttonSoundText"),
    buttonStatus: document.getElementById("buttonSoundStatus"),
    name: document.getElementById("bgmNameLabel"),
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
  updateUi();
  if (state.bgmEnabled) {
    state.waitingForGesture = true;
    playBgm().catch(() => updateUi());
  }
  window.PermissionConsoleSound = {
    playClick: toneClick,
    getState: () => ({ ...state, audio: undefined, audioContext: undefined }),
  };
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initSoundModule().catch(() => updateUi("音效模块初始化失败")), { once: true });
} else {
  initSoundModule().catch(() => updateUi("音效模块初始化失败"));
}
