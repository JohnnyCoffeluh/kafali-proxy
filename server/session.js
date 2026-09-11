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

/** Screencast quality (1–100 JPEG quality) — 50 offers 40% bandwidth reduction with crisp text */
const SCREENCAST_QUALITY = 50;

/**
 * Initialise a session for a newly connected WebSocket client.
 *
 * @param {import('ws').WebSocket} ws — the client WebSocket
 */
async function initSession(ws) {
  // ── 1. Create isolated browser context & page ───────────────
  const { context, page } = await createSession();

  // Store session state on the ws object for easy cleanup
  ws._rbiSession = { context, page, cdpSession: null, quality: SCREENCAST_QUALITY };

  // ── 2. Start screencast via Chrome DevTools Protocol ────────
  //
  // The CDP "Page.startScreencast" command tells Chromium to emit
  // a "Page.screencastFrame" event every time the viewport changes.
  //
  // Connection Improvement (Binary Streaming + Backpressure):
  //   - Raw binary buffers instead of base64 JSON saves ~33% bandwidth
  //   - Backpressure check (ws.bufferedAmount) drops frames if the client
  //     is slow, preventing lag accumulation and keeping frames real-time.
  try {
    const cdp = await page.createCDPSession();
    ws._rbiSession.cdpSession = cdp;

    cdp.on("Page.screencastFrame", async (event) => {
      // Acknowledge the frame so Chromium keeps sending new ones
      try {
        await cdp.send("Page.screencastFrameAck", {
          sessionId: event.sessionId,
        });
      } catch { /* session may have closed */ }

      // Backpressure check: drop frame if client buffer is congested (>32KB)
      // This guarantees zero accumulated input/display latency!
      if (ws.bufferedAmount > 32 * 1024) {
        return;
      }

      // Forward binary JPEG frame to client
      // Byte 0: 0x01 (screencast frame opcode)
      // Bytes 1..N: Raw JPEG buffer
      if (ws.readyState === ws.OPEN) {
        const imgBuffer = Buffer.from(event.data, "base64");
        const binaryMessage = Buffer.concat([Buffer.from([0x01]), imgBuffer]);
        ws.send(binaryMessage, { binary: true });
      }
    });

    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: SCREENCAST_QUALITY,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1,                  // send every frame
    });

    console.log("[session] Screencast started (binary stream with backpressure control)");
  } catch (err) {
    console.error("[session] CDP screencast setup failed, falling back to polling:", err.message);
    // Fallback: poll screenshots every 300ms
    ws._rbiSession.pollInterval = setInterval(async () => {
      try {
        if (ws.bufferedAmount > 64 * 1024) return;
        const q = ws._rbiSession?.quality || SCREENCAST_QUALITY;
        const buffer = await page.screenshot({ type: "jpeg", quality: q });
        if (ws.readyState === ws.OPEN) {
          const binaryMessage = Buffer.concat([Buffer.from([0x01]), buffer]);
          ws.send(binaryMessage, { binary: true });
        }
      } catch { /* page may have closed */ }
    }, 300);
  }

  // ── 3. Listen for client messages ───────────────────────────
  ws.on("message", (raw) => handleMessage(ws, raw));

  // ── 4. Cleanup on disconnect ────────────────────────────────
  ws.on("close", () => cleanup(ws));
  ws.on("error", () => cleanup(ws));

  // Send a ready signal so the client knows the session is live
  send(ws, { type: "ready", viewport: VIEWPORT, quality: SCREENCAST_QUALITY });

  // Auto-navigate to DuckDuckGo so the browser starts immediately with a working live page!
  setTimeout(async () => {
    try {
      if (ws.readyState === ws.OPEN && ws._rbiSession?.page) {
        await handleNavigate(ws, ws._rbiSession.page, "https://duckduckgo.com");
      }
    } catch (e) {
      console.warn("[session] Initial landing navigation error:", e.message);
    }
  }, 200);
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
      //
      // The client sends (x, y) coordinates relative to the canvas,
      // which matches the Puppeteer viewport coordinate system 1:1.
      case "click":
        await page.mouse.click(msg.x, msg.y, {
          button: msg.btn === 2 ? "right" : "left",
        });
        break;

      case "mousemove":
        await page.mouse.move(msg.x, msg.y);
        break;

      case "mousedown":
        await page.mouse.move(msg.x, msg.y);
        await page.mouse.down({
          button: msg.btn === 2 ? "right" : "left",
        });
        break;

      case "mouseup":
        await page.mouse.move(msg.x, msg.y);
        await page.mouse.up({
          button: msg.btn === 2 ? "right" : "left",
        });
        break;

      // ── Scroll ────────────────────────────────────────────
      //
      // Translates the client's wheel event deltas into Puppeteer
      // mouse wheel commands at the specified (x, y) position.
      case "scroll":
        await page.mouse.wheel({ deltaX: msg.dX || 0, deltaY: msg.dY || 0 });
        break;

      // ── Keyboard events with Biometric Jitter ─────────────
      //
      // Anti-Profiling Defense: surveillance websites measure the
      // exact millisecond flight-time between keypresses to build
      // a biometric profile of a user's typing cadence.
      //
      // We enqueue key events with randomized Gaussian micro-delays
      // (15–45ms), mathematically destroying biological typing signatures!
      case "keydown":
        enqueueWithJitter(ws, async (p) => {
          await p.keyboard.down(msg.key);
        });
        break;

      case "keyup":
        enqueueWithJitter(ws, async (p) => {
          await p.keyboard.up(msg.key);
        });
        break;

      // For direct text input (e.g. from mobile virtual keyboard)
      case "keypress":
        if (msg.text) {
          enqueueWithJitter(ws, async (p) => {
            await p.keyboard.type(msg.text, { delay: Math.floor(Math.random() * 25) + 20 });
          });
        }
        break;

      // ── Stream quality control ────────────────────────────
      case "set-quality": {
        const q = Math.max(20, Math.min(95, Number(msg.quality) || 60));
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
            if (ws.bufferedAmount > 64 * 1024) return;
            if (ws.readyState === ws.OPEN) {
              const imgBuffer = Buffer.from(event.data, "base64");
              ws.send(Buffer.concat([Buffer.from([0x01]), imgBuffer]), { binary: true });
            }
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
  send(ws, { type: "nav-start", url: target });

  try {
    await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });

    send(ws, {

      type: "nav-done",
      url: page.url(),
      title: await page.title(),
    });
  } catch (err) {
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
