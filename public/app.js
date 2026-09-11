/**
 * app.js — RBI Proxy client application
 *
 * Responsibilities:
 *   1. Authentication: send token via WebSocket query param
 *   2. Frame rendering: decode base64 JPEG → draw on <canvas>
 *   3. Input capture: intercept mouse/keyboard events on the canvas
 *      and send them to the backend as JSON messages
 *   4. Navigation controls: URL bar, Back/Forward/Reload buttons
 *
 * ── How user input is translated into browser events ──────────
 *
 *   Canvas mousedown  →  compute (x, y) relative to canvas
 *                     →  scale to match remote viewport resolution
 *                     →  send { type:'click', x, y } via WebSocket
 *                     →  server calls page.mouse.click(x, y)
 *
 *   Document keydown  →  capture event.key (e.g. "a", "Enter")
 *                     →  send { type:'keydown', key } via WebSocket
 *                     →  server calls page.keyboard.down(key)
 *
 *   Canvas wheel      →  read event.deltaX, event.deltaY
 *                     →  send { type:'scroll', dX, dY } via WebSocket
 *                     →  server calls page.mouse.wheel(...)
 */

"use strict";

// ── DOM references ────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const loginOverlay     = $("login-overlay");
const loginForm        = $("login-form");
const tokenInput       = $("token-input");
const loginError       = $("login-error");
const connectBtn       = $("connect-btn");

const appEl            = $("app");
const urlInput         = $("url-input");
const btnBack          = $("btn-back");
const btnFwd           = $("btn-fwd");
const btnReload        = $("btn-reload");
const btnGo            = $("btn-go");
const btnCircuit       = $("btn-circuit");
const btnToggleJs      = $("btn-toggle-js");
const btnBurn          = $("btn-burn");
const killswitchBanner = $("killswitch-banner");
const qualitySelect    = $("quality-select");
const deviceSelect     = $("device-select");
const btnKeyboard      = $("btn-keyboard");
const virtualKeyboardBridge = $("virtual-keyboard-bridge");
const lockIcon         = $("lock-icon");

const canvas           = $("viewport");
const ctx              = canvas.getContext("2d");
const placeholder      = $("viewport-placeholder");
const statusIndicator  = $("status-indicator");
const statusText       = statusIndicator.querySelector(".status-text");

const pageTitle        = $("page-title");
const viewportSize     = $("viewport-size");
const toastContainer   = $("toast-container");

// ── State ─────────────────────────────────────────────────────

let ws = null;                   // WebSocket connection
let remoteViewport = { width: 1280, height: 800 };
let isNavigating = false;
let frameReceived = false;
let currentToken = null;

// ── Open Public Connection ────────────────────────────────────

let reconnectTimer = null;

// Auto-connect instantly on page load
(function autoConnect() {
  connect();
})();

if (loginForm) {
  loginForm.addEventListener("submit", (e) => {
    e.preventDefault();
    connect();
  });
}

/**
 * Establish a direct WebSocket connection with zero token barriers.
 */
function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (loginOverlay) loginOverlay.classList.add("hidden");
  if (appEl) appEl.classList.add("active");

  setStatus("connecting", "Connecting…");

  // Build WebSocket URL (same host, /ws path)
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/ws`;

  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  } catch {}

  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("[ws] Connected (binary arraybuffer mode)");
    setStatus("connecting", "Initializing browser…");
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      handleBinaryFrame(event.data);
    } else {
      try {
        handleServerMessage(JSON.parse(event.data));
      } catch (err) {
        console.error("[ws] Failed to parse JSON message:", err);
      }
    }
  };

  ws.onclose = (event) => {
    console.log("[ws] Closed:", event.code, event.reason);
    setStatus("error", "Disconnected");
    ws = null;

    // Auto-reconnect after 3 seconds for resilience
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        console.log("[ws] Attempting automatic reconnection...");
        connect();
      }, 3000);
    }
  };

  ws.onerror = () => {
    // onclose handles reconnect
  };
}


// ── Server message handler ────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    // Session is ready — transition from login to app
    case "ready":
      remoteViewport = msg.viewport || remoteViewport;
      canvas.width = remoteViewport.width;
      canvas.height = remoteViewport.height;
      viewportSize.textContent = `${remoteViewport.width} × ${remoteViewport.height}`;

      if (msg.quality && qualitySelect) {
        qualitySelect.value = String(msg.quality);
      }

      if (loginOverlay) loginOverlay.classList.add("hidden");
      if (appEl) appEl.classList.add("active");
      setStatus("connected", "Connected");
      urlInput.focus();
      break;


    // ── Screencast frame (fallback text base64) ─────────────
    case "frame":
      renderBase64Frame(msg.data);
      break;

    // ── Stream quality update ───────────────────────────────
    case "quality-updated":
      toast(`⚡ Stream quality set to ${msg.quality}%`, "info");
      break;

    // ── Viewport updated (Device mode switch) ───────────────
    case "viewport-updated":
      remoteViewport = msg.viewport;
      canvas.width = msg.viewport.width;
      canvas.height = msg.viewport.height;
      viewportSize.textContent = `${msg.viewport.width} × ${msg.viewport.height}`;
      break;

    // ── Tor Circuit rotation ────────────────────────────────
    case "circuit-rotated":
      if (msg.success) {
        toast("🧅 Tor circuit rotated — fresh identity active!", "info");
      } else {
        toast(`⚠️ Tor circuit rotation failed: ${msg.error}`, "warning");
      }
      break;

    // ── NoScript / JS Toggled ───────────────────────────────
    case "js-toggled":
      jsEnabled = msg.enabled;
      updateJsButton();
      toast(jsEnabled ? "🛡️ Remote JavaScript ENABLED" : "🚫 NoScript Mode: Remote JavaScript DISABLED", "info");
      break;

    // ── Panic / Session Burned ──────────────────────────────
    case "session-burned":
      placeholder.classList.remove("hidden");
      pageTitle.textContent = "Session incinerated";
      urlInput.value = "";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      toast("🔥 Session incinerated! Memory wiped & clean Tor circuit active", "warning");
      break;

    // ── Emergency Killswitch Engaged ────────────────────────
    case "killswitch-engaged":
      if (killswitchBanner) killswitchBanner.classList.remove("hidden");
      setStatus("error", "Killswitch Engaged");
      toast(msg.message, "error");
      break;

    // ── Navigation events ───────────────────────────────────
    case "nav-start":
      isNavigating = true;
      placeholder.classList.remove("hidden");
      pageTitle.textContent = `Loading ${msg.url}…`;
      break;

    // ── Navigation events ───────────────────────────────────
    case "nav-done":
      isNavigating = false;
      placeholder.classList.add("hidden");
      urlInput.value = msg.url;
      pageTitle.textContent = msg.title || msg.url;
      lockIcon.textContent = msg.url.startsWith("https") ? "🔒" : "🔓";
      break;

    case "nav-error":
      isNavigating = false;
      placeholder.classList.add("hidden");
      toast(`Navigation error: ${msg.message}`, "error");
      pageTitle.textContent = "Navigation failed";
      break;

    case "nav-blocked":
      isNavigating = false;
      toast(`🛡️ Blocked: ${msg.reason}`, "warning");
      pageTitle.textContent = "Blocked by SSRF filter";
      break;

    case "error":
      toast(msg.message, "error");
      break;
  }
}

// ── High-Performance Binary Frame Rendering ───────────────────

/**
 * Decode a binary JPEG frame and draw it on the canvas.
 *
 * Performance optimizations (zero security trade-offs):
 *   1. Hardware-accelerated decode via createImageBitmap()
 *   2. Asynchronous off-main-thread image parsing
 *   3. Zero base64 string allocations
 *   4. Immediate bitmap.close() to prevent GPU memory leaks
 */
async function handleBinaryFrame(buffer) {
  const view = new Uint8Array(buffer);
  const opcode = view[0];

  if (opcode === 1) { // 0x01 = Screencast JPEG Frame
    frameReceived = true;
    placeholder.classList.add("hidden");

    try {
      const imageBytes = buffer.slice(1);
      const blob = new Blob([imageBytes], { type: "image/jpeg" });
      const bitmap = await createImageBitmap(blob);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
    } catch (err) {
      console.warn("[frame] Binary frame decode error:", err);
    }
  }
}

function renderBase64Frame(base64Data) {
  frameReceived = true;
  placeholder.classList.add("hidden");

  const img = new Image();
  img.onload = () => {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = "data:image/jpeg;base64," + base64Data;
}

// ── Input capture: Cached Viewport & Touch Batching ───────────

let cachedCanvasRect = null;
function getCanvasRect() {
  if (!cachedCanvasRect) {
    cachedCanvasRect = canvas.getBoundingClientRect();
  }
  return cachedCanvasRect;
}
window.addEventListener("resize", () => { cachedCanvasRect = null; });
window.addEventListener("scroll", () => { cachedCanvasRect = null; }, { passive: true });

/**
 * Translate an event into remote viewport coordinates with zero layout thrashing.
 */
function canvasCoords(event) {
  const rect = getCanvasRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: Math.round((event.clientX - rect.left) * scaleX),
    y: Math.round((event.clientY - rect.top) * scaleY),
  };
}

// Mouse click — send (x, y) to the server
canvas.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const { x, y } = canvasCoords(e);
  sendWs({ type: "mousedown", x, y, btn: e.button });
});

canvas.addEventListener("mouseup", (e) => {
  e.preventDefault();
  const { x, y } = canvasCoords(e);
  sendWs({ type: "mouseup", x, y, btn: e.button });
});

// Mouse move — enables hover effects on the remote page
canvas.addEventListener("mousemove", (e) => {
  const { x, y } = canvasCoords(e);
  throttledSend("mousemove", { type: "mousemove", x, y }, 40);
});

// Scroll — translate wheel deltas to remote page scrolling
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const { x, y } = canvasCoords(e);
  sendWs({
    type: "scroll",
    x,
    y,
    dX: Math.round(e.deltaX),
    dY: Math.round(e.deltaY),
  });
}, { passive: false });

// Prevent context menu on the canvas
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ── Ultra-Responsive Touch / Mobile Engine ─────────────────────
// Uses requestAnimationFrame to batch touch moves into single 60fps packets,
// preventing WebSocket buffer congestion and rubber-banding lag.
let touchStartX = 0;
let touchStartY = 0;
let lastTouchClientX = 0;
let lastTouchClientY = 0;
let touchStartTime = 0;
let isTouchSwiping = false;
let pendingScrollX = 0;
let pendingScrollY = 0;
let rAFScrollPending = false;

function flushTouchScroll() {
  rAFScrollPending = false;
  if (pendingScrollX !== 0 || pendingScrollY !== 0) {
    sendWs({
      type: "scroll",
      x: touchStartX,
      y: touchStartY,
      dX: pendingScrollX,
      dY: pendingScrollY,
    });
    pendingScrollX = 0;
    pendingScrollY = 0;
  }
}

canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) return;
  const touch = e.touches[0];
  const coords = canvasCoords(touch);
  touchStartX = coords.x;
  touchStartY = coords.y;
  lastTouchClientX = touch.clientX;
  lastTouchClientY = touch.clientY;
  touchStartTime = Date.now();
  isTouchSwiping = false;
  pendingScrollX = 0;
  pendingScrollY = 0;
}, { passive: true });

canvas.addEventListener("touchmove", (e) => {
  if (e.touches.length !== 1) return;
  const touch = e.touches[0];
  const deltaX = lastTouchClientX - touch.clientX;
  const deltaY = lastTouchClientY - touch.clientY;

  if (!isTouchSwiping && (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4)) {
    isTouchSwiping = true;
  }

  if (isTouchSwiping) {
    pendingScrollX += Math.round(deltaX * 1.25);
    pendingScrollY += Math.round(deltaY * 1.25);
    lastTouchClientX = touch.clientX;
    lastTouchClientY = touch.clientY;

    if (!rAFScrollPending) {
      rAFScrollPending = true;
      requestAnimationFrame(flushTouchScroll);
    }
  }
}, { passive: true });

canvas.addEventListener("touchend", (e) => {
  const duration = Date.now() - touchStartTime;
  if (!isTouchSwiping && duration < 320) {
    sendWs({ type: "click", x: touchStartX, y: touchStartY, btn: 0 });
  }
  if (rAFScrollPending) {
    flushTouchScroll();
  }
}, { passive: true });


// ── Input capture: Keyboard ───────────────────────────────────

/**
 * Keyboard events are captured at the document level so they work
 * as long as the app is focused. Each keydown/keyup event sends the
 * DOM key name (e.g. "a", "Enter", "Shift") to the server, which
 * calls page.keyboard.down(key) / page.keyboard.up(key).
 *
 * We only capture keyboard when the canvas/viewport area is focused
 * (not when the URL input is focused).
 */
document.addEventListener("keydown", (e) => {
  // Don't intercept when typing in the URL bar
  if (document.activeElement === urlInput || document.activeElement === tokenInput) return;

  // Prevent default for most keys to avoid browser shortcuts
  if (!isModifierOnly(e.key)) {
    e.preventDefault();
  }

  sendWs({ type: "keydown", key: e.key });
});

document.addEventListener("keyup", (e) => {
  if (document.activeElement === urlInput || document.activeElement === tokenInput) return;

  e.preventDefault();
  sendWs({ type: "keyup", key: e.key });
});

function isModifierOnly(key) {
  return ["Shift", "Control", "Alt", "Meta"].includes(key);
}

// ── Navigation controls ───────────────────────────────────────

const urlForm = $("url-form");
if (urlForm) {
  urlForm.addEventListener("submit", (e) => {
    e.preventDefault();
    navigateTo(urlInput.value.trim());
    canvas.focus();
  });
}

// URL bar: submit on Enter
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    navigateTo(urlInput.value.trim());
    canvas.focus();
  }
});

// Go button
if (btnGo) {
  btnGo.addEventListener("click", (e) => {
    e.preventDefault();
    navigateTo(urlInput.value.trim());
    canvas.focus();
  });
}


// Back / Forward / Reload buttons
btnBack.addEventListener("click",   () => sendWs({ type: "back" }));
btnFwd.addEventListener("click",    () => sendWs({ type: "forward" }));
btnReload.addEventListener("click", () => sendWs({ type: "reload" }));

// ── Quality Selector ──────────────────────────────────────────
if (qualitySelect) {
  qualitySelect.addEventListener("change", () => {
    const quality = parseInt(qualitySelect.value, 10);
    sendWs({ type: "set-quality", quality });
  });
}

// ── Tor Circuit Rotation ──────────────────────────────────────
if (btnCircuit) {
  btnCircuit.addEventListener("click", () => {
    btnCircuit.disabled = true;
    btnCircuit.textContent = "🧅 Rotating…";
    sendWs({ type: "rotate-circuit" });
    setTimeout(() => {
      btnCircuit.disabled = false;
      btnCircuit.textContent = "🧅 New Circuit";
    }, 2500);
  });
}

// ── Device Viewport Modes ─────────────────────────────────────
const DEVICE_PRESETS = {
  desktop: { width: 1280, height: 800, isMobile: false, hasTouch: false, label: "💻 Desktop" },
  mobile:  { width: 390,  height: 844, isMobile: true,  hasTouch: true,  label: "📱 Mobile" },
  tablet:  { width: 820,  height: 1180, isMobile: true, hasTouch: true,  label: "📟 Tablet" },
};

if (deviceSelect) {
  deviceSelect.addEventListener("change", () => {
    const mode = deviceSelect.value;
    const preset = DEVICE_PRESETS[mode] || DEVICE_PRESETS.desktop;

    remoteViewport.width = preset.width;
    remoteViewport.height = preset.height;
    canvas.width = preset.width;
    canvas.height = preset.height;
    viewportSize.textContent = `${preset.width} × ${preset.height}`;

    sendWs({
      type: "set-viewport",
      width: preset.width,
      height: preset.height,
      isMobile: preset.isMobile,
      hasTouch: preset.hasTouch,
    });
    toast(`Switched to ${preset.label} (${preset.width}×${preset.height})`, "info");
  });
}

// ── Virtual Keyboard Bridge (Mobile / Touch Devices) ──────────
if (btnKeyboard && virtualKeyboardBridge) {
  btnKeyboard.addEventListener("click", () => {
    virtualKeyboardBridge.focus();
    virtualKeyboardBridge.click();
    toast("⌨️ Touch keyboard focused — type to enter text", "info");
  });

  // Forward typed text to remote browser
  virtualKeyboardBridge.addEventListener("input", (e) => {
    if (e.data) {
      sendWs({ type: "keypress", text: e.data });
    }
    virtualKeyboardBridge.value = "";
  });

  // Forward control keys (Enter, Backspace, Tab)
  virtualKeyboardBridge.addEventListener("keydown", (e) => {
    if (["Backspace", "Enter", "Tab", "Escape"].includes(e.key)) {
      sendWs({ type: "keydown", key: e.key });
      setTimeout(() => sendWs({ type: "keyup", key: e.key }), 25);
    }
  });
}

// ── NoScript / Remote JS Toggle ───────────────────────────────
let jsEnabled = true;

function updateJsButton() {
  if (!btnToggleJs) return;
  if (jsEnabled) {
    btnToggleJs.textContent = "🛡️ JS: ON";
    btnToggleJs.classList.remove("js-disabled");
    btnToggleJs.title = "JavaScript enabled. Click to engage NoScript Paranoid Mode.";
  } else {
    btnToggleJs.textContent = "🚫 JS: OFF";
    btnToggleJs.classList.add("js-disabled");
    btnToggleJs.title = "NoScript Paranoid Mode active: Zero JavaScript executed remotely.";
  }
}

if (btnToggleJs) {
  btnToggleJs.addEventListener("click", () => {
    jsEnabled = !jsEnabled;
    updateJsButton();
    sendWs({ type: "toggle-js", enabled: jsEnabled });
  });
}

// ── Panic / Burn Session ──────────────────────────────────────
if (btnBurn) {
  btnBurn.addEventListener("click", () => {
    btnBurn.disabled = true;
    btnBurn.textContent = "🔥 Burning…";
    sendWs({ type: "burn-session" });
    setTimeout(() => {
      btnBurn.disabled = false;
      btnBurn.textContent = "🔥 Burn";
    }, 2500);
  });
}

/**
 * Send a navigation request to the server.
 * The server will run SSRF checks before actually navigating.
 */
function navigateTo(url) {
  if (!url) return;
  sendWs({ type: "navigate", url });
}

// ── WebSocket send helpers ────────────────────────────────────

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

/** Throttle high-frequency messages like mousemove */
const throttleTimers = {};
function throttledSend(key, obj, ms) {
  if (throttleTimers[key]) return;
  sendWs(obj);
  throttleTimers[key] = setTimeout(() => {
    delete throttleTimers[key];
  }, ms);
}

// ── UI helpers ────────────────────────────────────────────────

function setStatus(state, text) {
  statusIndicator.className = `status-indicator ${state}`;
  statusText.textContent = text;
}

/**
 * Show a toast notification.
 * @param {string} message
 * @param {"info"|"warning"|"error"} level
 */
function toast(message, level = "info") {
  const el = document.createElement("div");
  el.className = `toast ${level}`;
  el.textContent = message;
  toastContainer.appendChild(el);

  // Auto-remove after 5 seconds
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    el.style.transition = "all 0.3s ease";
    setTimeout(() => el.remove(), 300);
  }, 5000);
}
