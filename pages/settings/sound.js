const BGM_STORAGE_KEY = "permission-controller-background-sound-enabled";
const BGM_TRACK_SRC = "./assets/audio/rebirth-after-disaster.mp3";
const BGM_TRACK_NAME = "小k橘子 - 劫后余生";
const BGM_VOLUME = 0.42;

const state = {
  enabled: loadSwitchPreference(BGM_STORAGE_KEY, false),
  unlocked: false,
  waitingForGesture: false,
  assetError: false,
  audio: null,
  toggleButton: null,
  stateText: null,
  trackLabel: null,
};

function loadSwitchPreference(key, fallback = false) {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "on" || stored === "off") return stored === "on";
  } catch {}
  try {
    const prefix = `${key}=`;
    const matched = (document.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix));
    if (matched) return decodeURIComponent(matched.slice(prefix.length)) === "on";
  } catch {}
  return fallback;
}

function saveSwitchPreference(key, value) {
  try {
    window.localStorage.setItem(key, value ? "on" : "off");
  } catch {}
  try {
    document.cookie = `${key}=${encodeURIComponent(value ? "on" : "off")}; max-age=31536000; path=/; SameSite=Lax`;
  } catch {}
}

function ambientTrack() {
  if (state.audio) return state.audio;
  const audio = new Audio(BGM_TRACK_SRC);
  audio.loop = true;
  audio.preload = "auto";
  audio.volume = BGM_VOLUME;
  audio.addEventListener("error", () => {
    state.assetError = true;
    state.waitingForGesture = false;
    updateBgmUi("音乐加载失败");
  });
  state.audio = audio;
  return audio;
}

function updateBgmUi(statusText = "") {
  const active = state.enabled && !state.assetError;
  const waiting = active && state.waitingForGesture;
  const title = state.assetError
    ? "默认背景音乐加载失败"
    : active
      ? "关闭背景音乐"
      : "开启背景音乐";
  if (state.toggleButton) {
    state.toggleButton.classList.toggle("is-on", active);
    state.toggleButton.classList.toggle("is-waiting", waiting);
    state.toggleButton.setAttribute("aria-pressed", String(active));
    state.toggleButton.setAttribute("aria-label", title);
    state.toggleButton.title = title;
  }
  if (state.stateText) {
    state.stateText.textContent = state.assetError ? "异常" : active ? "BGM开" : "BGM关";
  }
  if (state.trackLabel) {
    state.trackLabel.textContent =
      statusText || `${BGM_TRACK_NAME} · ${waiting ? "点击页面后播放" : active ? "默认播放曲目" : "默认曲目"}`;
  }
  document.body.dataset.bgmEnabled = active ? "true" : "false";
}

async function startAmbient() {
  if (!state.enabled || state.assetError) return;
  const audio = ambientTrack();
  try {
    await audio.play();
    state.waitingForGesture = false;
  } catch {
    state.waitingForGesture = true;
  } finally {
    updateBgmUi();
  }
}

function stopAmbient() {
  if (state.audio) {
    state.audio.pause();
    state.audio.currentTime = 0;
  }
  state.waitingForGesture = false;
  updateBgmUi();
}

async function toggleBgm() {
  state.unlocked = true;
  if (state.enabled) {
    state.enabled = false;
    saveSwitchPreference(BGM_STORAGE_KEY, false);
    stopAmbient();
    return;
  }
  state.enabled = true;
  saveSwitchPreference(BGM_STORAGE_KEY, true);
  await startAmbient();
}

function unlockFromGesture() {
  state.unlocked = true;
  if (state.enabled && state.waitingForGesture) {
    startAmbient().catch(() => {});
  }
}

function bindLifecycle() {
  window.addEventListener("pointerdown", unlockFromGesture, { capture: true });
  window.addEventListener("keydown", unlockFromGesture, { capture: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (state.audio && !state.audio.paused) state.audio.pause();
      return;
    }
    if (state.enabled && state.unlocked) startAmbient().catch(() => {});
  });
}

function initBgmModule() {
  state.toggleButton = document.getElementById("bgmToggleBtn");
  state.stateText = document.getElementById("bgmStateText");
  state.trackLabel = document.getElementById("bgmTrackLabel");
  if (!state.toggleButton) return;

  state.toggleButton.addEventListener("click", () => {
    toggleBgm().catch(() => {
      state.waitingForGesture = true;
      updateBgmUi("点击页面后播放");
    });
  });
  bindLifecycle();
  if (state.enabled) {
    state.waitingForGesture = true;
    startAmbient().catch(() => {});
  }
  updateBgmUi();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initBgmModule, { once: true });
} else {
  initBgmModule();
}
