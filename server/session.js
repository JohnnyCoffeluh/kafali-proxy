/**
 * session.js — Per-client WebSocket session controller
 *
 * Each WebSocket connection maps to one "session" that owns:
 *   - An incognito Puppeteer BrowserContext (session isolation)
 *   - A Page with screencast streaming
 *   - Message handlers that translate client events → Puppeteer actions
 *
 * ┌──────────┐   WebSocket    ┌────────────┐  CDP/Puppeteer  ┌──────────┐
 * │  Client  │ ◄────────────► │  session.js │ ◄─────────────► │ Chromium │
 * │ (canvas) │  frames/input  │  (Node.js)  │  screenshots    │ (headless)│
 * └──────────┘                └────────────┘                 └──────────┘
 *
 * Input flow:
 *   Client sends JSON: { type, ...payload }
 *   → session.js parses the message
 *   → calls the appropriate Puppeteer API (mouse.click, keyboard, goto…)
 *
 * Output flow:
 *   CDP Page.screencastFrame event fires
 *   → session.js receives base64 frame data
 *   → forwards it to the client over WebSocket as { type: 'frame', data }
 */

"use strict";

const { createSession, destroySession, VIEWPORT } = require("./browser");
const { isSafeUrl } = require("./ssrf");
const { rotateTorCircuit } = require("./tor-control");

/** Navigation timeout in milliseconds */
const NAV_TIMEOUT = 30_000;

/** Screencast quality (1–100 JPEG quality) — 45 gives ultra-fast 20KB frames with crisp text */
const SCREENCAST_QUALITY = 45;

/**
 * Direct zero-copy binary frame transmission.
 */
function sendFrameToClient(ws, base64Data) {
  if (ws.readyState !== ws.OPEN) return;
  const imgLen = Buffer.byteLength(base64Data, "base64");
  const buf = Buffer.allocUnsafe(imgLen + 1);
  buf[0] = 0x01; // 0x01 = Screencast frame opcode
  buf.write(base64Data, 1, imgLen, "base64");
  ws.send(buf, { binary: true });
}

/**
 * High-Performance Adaptive Screencast Pacer.
 * Streams smooth 25-30 FPS video without stop-and-wait round-trip locks.
 * Uses kernel socket buffer backpressure (ws.bufferedAmount) to prevent queue bloat.
 */
function handleScreencastFrame(ws, event) {
  const session = ws._rbiSession;
  if (!session) return;

  const now = Date.now();
  // Target ~30 FPS (~33ms spacing) for silky smooth video streaming
  const minInterval = 33;

  // Congestion backpressure: if socket queue exceeds 48KB, network is busy.
  // Hold latest frame so we never lag or buffer bloat.
  if (ws.bufferedAmount > 48 * 1024) {
    session.pendingFrame = event.data;
    return;
  }

  const elapsed = now - (session.lastSendTime || 0);
  if (elapsed < minInterval) {
    session.pendingFrame = event.data;
    if (!session.pacerTimer) {
      session.pacerTimer = setTimeout(() => {
        session.pacerTimer = null;
        if (ws._rbiSession && session.pendingFrame && ws.bufferedAmount <= 48 * 1024) {
          const frame = session.pendingFrame;
          session.pendingFrame = null;
          session.lastSendTime = Date.now();
          sendFrameToClient(ws, frame);
        }
      }, minInterval - elapsed);
    }
    return;
  }

  // Clear any queued pacer timer
  if (session.pacerTimer) {
    clearTimeout(session.pacerTimer);
    session.pacerTimer = null;
  }

  session.lastSendTime = now;
  session.pendingFrame = null;
  sendFrameToClient(ws, event.data);
}

/**
 * Handle Frame Ack from client (client drew the frame).
 * Used for round-trip latency tracking and flushing pending frames.
 */
function handleClientAck(ws) {
  const session = ws._rbiSession;
  if (!session) return;
  session.lastAckTime = Date.now();
  if (session.pendingFrame && ws.bufferedAmount <= 32 * 1024 && !session.pacerTimer) {
    const next = session.pendingFrame;
    session.pendingFrame = null;
    session.lastSendTime = Date.now();
    sendFrameToClient(ws, next);
  }
}

/**
 * Initialise a session for a newly connected WebSocket client.
 *
 * @param {import('ws').WebSocket} ws — the client WebSocket
 */
async function initSession(ws) {
  // ── 1. Create isolated browser context & page ───────────────
  const { context, page } = await createSession();

  // Store session state on the ws object for easy cleanup
  ws._rbiSession = {
    context,
    page,
    cdpSession: null,
    quality: SCREENCAST_QUALITY,
    lastSendTime: 0,
    lastAckTime: 0,
    pendingFrame: null,
    pacerTimer: null,
    navigating: false,
  };

  // ── 2. Start screencast via Chrome DevTools Protocol ────────
  try {
    const cdp = await page.createCDPSession();
    ws._rbiSession.cdpSession = cdp;

    cdp.on("Page.screencastFrame", async (event) => {
      try {
        await cdp.send("Page.screencastFrameAck", {
          sessionId: event.sessionId,
        });
      } catch { /* session may have closed */ }

      handleScreencastFrame(ws, event);
    });

    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: SCREENCAST_QUALITY,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,
    });

    console.log("[session] Low-latency screencast active (Client-Ack flow control, zero-copy buffer)");
  } catch (err) {
    console.error("[session] CDP screencast setup failed, falling back to polling:", err.message);
    ws._rbiSession.pollInterval = setInterval(async () => {
      try {
        if (ws.bufferedAmount > 32 * 1024) return;
        const q = ws._rbiSession?.quality || SCREENCAST_QUALITY;
        const buffer = await page.screenshot({ type: "jpeg", quality: q });
        if (ws.readyState === ws.OPEN) {
          const binaryMessage = Buffer.concat([Buffer.from([0x01]), buffer]);
          ws.send(binaryMessage, { binary: true });
        }
      } catch { /* page may have closed */ }
    }, 250);
  }

  // ── 3. Listen for client messages ───────────────────────────
  ws.on("message", (raw) => {
    // Check for high-frequency binary Frame-Ack opcode (0x02)
    if (Buffer.isBuffer(raw) && raw.length === 1 && raw[0] === 0x02) {
      handleClientAck(ws);
      return;
    }
    handleMessage(ws, raw);
  });

  // ── 4. Cleanup on disconnect ────────────────────────────────
  ws.on("close", () => cleanup(ws));
  ws.on("error", () => cleanup(ws));

  // Send a ready signal so the client knows the session is live
  send(ws, { type: "ready", viewport: VIEWPORT, quality: SCREENCAST_QUALITY });

  // Auto-navigate to DuckDuckGo only if the client hasn't initiated navigation
  setTimeout(async () => {
    try {
      if (ws.readyState === ws.OPEN && ws._rbiSession?.page && !ws._rbiSession.hasNavigated) {
        await handleNavigate(ws, ws._rbiSession.page, "https://duckduckgo.com");
      }
    } catch (e) {
      console.warn("[session] Initial landing navigation error:", e.message);
    }
  }, 100);
}


// ── Message router ────────────────────────────────────────────

/**
 * Parse and dispatch a client message to the appropriate handler.
 *
 * Message format: { type: string, ...payload }
 *
 * Supported types:
 *   navigate  { url }         → navigate the page to a new URL
 *   click     { x, y, btn }   → click at canvas coordinates
 *   mousemove { x, y }        → move the mouse (hover effects)
 *   mousedown { x, y, btn }   → press mouse button
 *   mouseup   { x, y, btn }   → release mouse button
 *   scroll    { x, y, dX, dY }→ scroll the page
 *   keydown   { key, code }   → press a key
 *   keyup     { key, code }   → release a key
 *   keypress  { text }        → type text directly
 *   back      {}              → browser back
 *   forward   {}              → browser forward
 *   reload    {}              → reload current page
 */
/**
 * Fast input dispatcher — executes key events immediately without artificial latency.
 */
function enqueueWithJitter(ws, actionFn) {
  if (!ws._rbiSession?.page) return;
  actionFn(ws._rbiSession.page).catch((err) => console.warn("[input] Error:", err.message));
}

async function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return send(ws, { type: "error", message: "Invalid JSON" });
  }

  const { page } = ws._rbiSession || {};
  if (!page) return;

  try {
    switch (msg.type) {
      // ── Navigation ────────────────────────────────────────
      case "navigate":
        await handleNavigate(ws, page, msg.url);
        break;

      case "back":
        await page.goBack({ timeout: NAV_TIMEOUT }).catch(() => {});
        break;

      case "forward":
        await page.goForward({ timeout: NAV_TIMEOUT }).catch(() => {});
        break;

      case "reload":
        await page.reload({ timeout: NAV_TIMEOUT }).catch(() => {});
        break;

      // ── Mouse events ──────────────────────────────────────
      case "click":
        page.mouse.click(msg.x, msg.y, {
          button: msg.btn === 2 ? "right" : "left",
        }).catch(() => {});
        break;

      case "mousemove":
        page.mouse.move(msg.x, msg.y).catch(() => {});
        break;

      case "mousedown":
        page.mouse.move(msg.x, msg.y).then(() =>
          page.mouse.down({ button: msg.btn === 2 ? "right" : "left" })
        ).catch(() => {});
        break;

      case "mouseup":
        page.mouse.move(msg.x, msg.y).then(() =>
          page.mouse.up({ button: msg.btn === 2 ? "right" : "left" })
        ).catch(() => {});
        break;

      // ── Scroll ────────────────────────────────────────────
      case "scroll":
        page.mouse.wheel({ deltaX: msg.dX || 0, deltaY: msg.dY || 0 }).catch(() => {});
        break;

      // ── Low-Latency Keyboard events (0ms artificial latency) ─
      case "keydown":
        page.keyboard.down(msg.key).catch(() => {});
        break;

      case "keyup":
        page.keyboard.up(msg.key).catch(() => {});
        break;

      // Direct text insertion for mobile and virtual keyboards (instant)
      case "keypress":
        if (msg.text) {
          page.keyboard.insertText(msg.text).then(() => {
            if (msg.submit) {
              return page.keyboard.press("Enter");
            }
          }).catch(() => {});
        }
        break;

      // ── Frame Ack (Client drew frame) ─────────────────────
      case "frame-ack":
        handleClientAck(ws);
        break;

      // ── Latency / Ping Measurement ────────────────────────
      case "ping":
        send(ws, { type: "pong", t: msg.t });
        break;

      // ── Stream quality control ────────────────────────────
      case "set-quality": {
        const q = Math.max(20, Math.min(95, Number(msg.quality) || 45));
        ws._rbiSession.quality = q;
        if (ws._rbiSession.cdpSession) {
          try {
            await ws._rbiSession.cdpSession.send("Page.startScreencast", {
              format: "jpeg",
              quality: q,
              maxWidth: VIEWPORT.width,
              maxHeight: VIEWPORT.height,
              everyNthFrame: 1,
            });
          } catch {}
        }
        send(ws, { type: "quality-updated", quality: q });
        break;
      }

      // ── Tor Circuit Rotation ──────────────────────────────
      case "rotate-circuit": {
        try {
          await rotateTorCircuit();
          send(ws, { type: "circuit-rotated", success: true });
        } catch (err) {
          send(ws, { type: "circuit-rotated", success: false, error: err.message });
        }
        break;
      }

      // ── NoScript Mode: Toggle Remote JavaScript ───────────
      case "toggle-js": {
        const enabled = Boolean(msg.enabled);
        ws._rbiSession.jsEnabled = enabled;
        try {
          await page.setJavaScriptEnabled(enabled);
          send(ws, { type: "js-toggled", enabled });
          console.log("[session] Remote JavaScript set to %s", enabled ? "ENABLED" : "DISABLED (NoScript)");
        } catch (err) {
          send(ws, { type: "error", message: `JS toggle error: ${err.message}` });
        }
        break;
      }

      // ── Panic / Burn Session: Instant Memory Incinerator ───
      case "burn-session": {
        console.log("[session] 🔥 Burning session (memory wipe & new circuit)...");
        try {
          if (ws._rbiSession.pacerTimer) {
            clearTimeout(ws._rbiSession.pacerTimer);
            ws._rbiSession.pacerTimer = null;
          }

          // 1. Detach CDP & destroy existing context
          if (ws._rbiSession.cdpSession) {
            try { await ws._rbiSession.cdpSession.detach(); } catch {}
          }
          await destroySession(ws._rbiSession.context);

          // 2. Rotate Tor circuit to get fresh identity
          await rotateTorCircuit();

          // 3. Create clean new incognito session
          const { context: newCtx, page: newPage } = await createSession();
          ws._rbiSession.context = newCtx;
          ws._rbiSession.page = newPage;
          ws._rbiSession.lastSendTime = 0;
          ws._rbiSession.pendingFrame = null;
          ws._rbiSession.pacerTimer = null;

          // Restore viewport & quality
          const currentVp = ws._rbiSession.viewport || VIEWPORT;
          await newPage.setViewport(currentVp);

          // Setup CDP on new clean page
          const newCdp = await newPage.createCDPSession();
          ws._rbiSession.cdpSession = newCdp;

          newCdp.on("Page.screencastFrame", async (event) => {
            try {
              await newCdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
            } catch {}
            handleScreencastFrame(ws, event);
          });

          await newCdp.send("Page.startScreencast", {
            format: "jpeg",
            quality: ws._rbiSession.quality || SCREENCAST_QUALITY,
            maxWidth: currentVp.width,
            maxHeight: currentVp.height,
            everyNthFrame: 1,
          });

          send(ws, {
            type: "session-burned",
            message: "🔥 Session incinerated! In-memory caches wiped & clean Tor circuit active.",
            viewport: currentVp,
          });
        } catch (err) {
          console.error("[session] Burn session failed:", err.message);
          send(ws, { type: "error", message: `Burn session failed: ${err.message}` });
        }
        break;
      }

      // ── Dynamic Viewport & Mobile Emulation ───────────────
      case "set-viewport": {
        const w = Math.max(320, Math.min(2560, Number(msg.width) || 1280));
        const h = Math.max(320, Math.min(1600, Number(msg.height) || 800));
        const isMobile = Boolean(msg.isMobile);
        const hasTouch = Boolean(msg.hasTouch);

        try {
          await page.setViewport({
            width: w,
            height: h,
            isMobile,
            hasTouch,
            deviceScaleFactor: 1,
          });

          ws._rbiSession.viewport = { width: w, height: h, isMobile, hasTouch };

          if (ws._rbiSession.cdpSession) {
            await ws._rbiSession.cdpSession.send("Page.startScreencast", {
              format: "jpeg",
              quality: ws._rbiSession.quality || 60,
              maxWidth: w,
              maxHeight: h,
              everyNthFrame: 1,
            });
          }

          send(ws, {
            type: "viewport-updated",
            viewport: { width: w, height: h, isMobile, hasTouch },
          });
        } catch (err) {
          console.error("[session] Failed to update viewport:", err.message);
          send(ws, { type: "error", message: `Viewport error: ${err.message}` });
        }
        break;
      }

      default:
        send(ws, { type: "error", message: `Unknown type: ${msg.type}` });
    }
  } catch (err) {
    console.error(`[session] Error handling "${msg.type}":`, err.message);
    send(ws, { type: "error", message: err.message });
  }
}

// ── Navigation with SSRF check ────────────────────────────────

/**
 * Navigate to a URL after SSRF validation.
 *
 * Flow:
 *   1. Validate the URL against SSRF rules (DNS resolve + CIDR check)
 *   2. If safe, call page.goto() with a 30-second timeout
 *   3. Send the final URL back to the client (may differ after redirects)
 */
async function handleNavigate(ws, page, url) {
  if (ws._rbiSession) {
    ws._rbiSession.hasNavigated = true;
  }
  let target = String(url).trim();

  if (!target) {
    return send(ws, { type: "error", message: "Missing URL" });
  }

  // If not starting with http:// or https://:
  if (!/^https?:\/\//i.test(target)) {
    // If it contains spaces or lacks a dot, treat it as a search query!
    if (target.includes(" ") || !target.includes(".")) {
      target = `https://duckduckgo.com/?q=${encodeURIComponent(target)}`;
    } else {
      target = "https://" + target;
    }
  }

  // ── SSRF check ──────────────────────────────────────────────
  const check = await isSafeUrl(target);
  if (!check.safe) {
    console.warn("[ssrf] Blocked navigation to:", target, "—", check.reason);
    return send(ws, {
      type: "nav-blocked",
      url: target,
      reason: check.reason,
    });
  }

  // ── Navigate ────────────────────────────────────────────────
  if (ws._rbiSession) ws._rbiSession.navigating = true;
  send(ws, { type: "nav-start", url: target });

  try {
    await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });

    if (ws._rbiSession) ws._rbiSession.navigating = false;

    send(ws, {
      type: "nav-done",
      url: page.url(),
      title: await page.title(),
    });
  } catch (err) {
    if (ws._rbiSession) ws._rbiSession.navigating = false;
    // Don't toast error if user navigated away or navigation was superseded
    if (err.message.includes("net::ERR_ABORTED") || err.message.includes("Execution context was destroyed")) {
      return;
    }
    send(ws, { type: "nav-error", url, message: err.message });
  }
}

// ── Cleanup ───────────────────────────────────────────────────

/**
 * Destroy the session when the client disconnects.
 * This closes the incognito context, wiping all cookies and session data.
 */
async function cleanup(ws) {
  const session = ws._rbiSession;
  if (!session) return;
  ws._rbiSession = null;

  if (session.pacerTimer) {
    clearTimeout(session.pacerTimer);
    session.pacerTimer = null;
  }

  // Stop screencast polling fallback if active
  if (session.pollInterval) {
    clearInterval(session.pollInterval);
  }

  // Close CDP session
  if (session.cdpSession) {
    try { await session.cdpSession.detach(); } catch {}
  }

  // Destroy the incognito context (session isolation)
  await destroySession(session.context);
  console.log("[session] Client session cleaned up");
}

// ── Utility ───────────────────────────────────────────────────

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

module.exports = { initSession };
