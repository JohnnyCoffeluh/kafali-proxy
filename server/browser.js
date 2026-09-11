/**
 * browser.js — Puppeteer browser lifecycle management
 *
 * Launches a single shared Chromium instance on startup, routed through
 * a Tor SOCKS5 proxy for full IP anonymity. Each connected client gets
 * its own incognito BrowserContext so cookies, localStorage, and session
 * data are fully isolated and destroyed on disconnect.
 *
 * Privacy layers:
 *   1. Tor SOCKS5 proxy (hides real IP from all websites)
 *   2. DNS routed through Tor (prevents DNS leaks to ISP)
 *   3. Anti-fingerprinting flags (WebRTC, WebGL, canvas, etc.)
 *   4. Spoofed user-agent (blends in with normal Firefox traffic)
 *   5. Incognito contexts (no persistent cookies/history)
 */

"use strict";

const puppeteer = require("puppeteer");

/** @type {import('puppeteer').Browser | null} */
let browser = null;

/** Default viewport dimensions streamed to the client */
const VIEWPORT = { width: 1280, height: 800 };

/** Tor SOCKS5 proxy address */
const TOR_PROXY = "socks5://127.0.0.1:9050";

/**
 * A generic, common user-agent string to blend in with normal traffic.
 * Using a recent Firefox on Windows — matches the Tor Browser's approach.
 */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0";

const fs = require("fs");

/**
 * Locate official Google Chrome or Edge on the system for proprietary
 * video codec support (H.264, AAC, MP4, AV1, VP9) and hardware acceleration.
 */
function getBrowserExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return undefined;
}

/**
 * Launch the shared Chromium/Chrome instance.
 * Called once when the server boots.
 */
async function launch() {
  if (browser) return browser;

  const execPath = getBrowserExecutablePath();
  if (execPath) {
    console.log("[browser] Using high-performance browser binary with full video codecs: %s", execPath);
  }

  browser = await puppeteer.launch({
    headless: true,
    ignoreHTTPSErrors: true,
    executablePath: execPath,
    args: [
      // ── Tor proxy ─────────────────────────────────────────────
      // Route ALL traffic (HTTP, HTTPS, WS) through Tor SOCKS5
      `--proxy-server=${TOR_PROXY}`,
      // Route DNS lookups through the proxy too (prevents DNS leaks
      // to your ISP — without this, your ISP sees which hostnames
      // you're resolving even though traffic goes through Tor)
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--proxy-bypass-list=<-loopback>",

      // ── Security & Sandboxing ────────────────────────────────
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--disable-default-apps",
      "--no-first-run",
      "--no-default-browser-check",

      // ── SSL bypass ────────────────────────────────────────────
      "--ignore-certificate-errors",
      "--allow-insecure-localhost",

      // ── Anti-fingerprinting ───────────────────────────────────
      // Disable WebRTC — prevents real IP leak through STUN requests
      "--disable-webrtc-hw-encoding",
      "--disable-webrtc-hw-decoding",
      "--enforce-webrtc-ip-permission-check",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",

      // ── Hardware Acceleration & Full Video Streaming Pipeline ──
      "--use-gl=angle",
      "--use-angle=d3d11",
      "--enable-gpu-rasterization",
      "--enable-zero-copy",
      "--enable-accelerated-2d-canvas",
      "--enable-accelerated-video-decode",  // Hardware video decoding for smooth playback
      "--ignore-gpu-blocklist",             // Ensures GPU acceleration stays active
      "--autoplay-policy=no-user-gesture-required", // Allows video to play smoothly when clicked
      "--disable-smooth-scrolling",         // Makes scroll instant & eliminates 15 intermediate frames
      "--disable-ipc-flooding-protection",  // Allows ultra-fast Puppeteer CDP communication
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disk-cache-size=524288000",        // 500MB disk cache for instant page & asset loading
      "--media-cache-size=268435456",       // 256MB dedicated media buffer cache for streaming video chunks

      // ── Sensors & Privacy Protection ─────────────────────────
      "--disable-notifications",
      "--disable-geolocation",
      "--disable-media-stream",             // Block camera/microphone
      "--disable-speech-api",
      "--disable-background-timer-throttling",

      // ── Privacy & Performance Features ───────────────────────
      "--incognito",
      "--disable-client-side-phishing-detection",
      "--disable-component-update",
      "--disable-domain-reliability",
      "--disable-features=OptimizationHints,Translate,MediaRouter,DialMediaRouteProvider",
      "--enable-features=CanvasOopRasterization,NetworkService,NetworkServiceInProcess,VaapiVideoDecoder,PlatformHEVCDecoderSupport,AudioServiceOutOfProcess",
    ],
  });

  console.log("[browser] Chromium launched (PID %d)", browser.process()?.pid);
  console.log("[browser] Traffic routed through Tor at %s", TOR_PROXY);
  return browser;
}

/**
 * Create an isolated browsing session.
 *
 * @returns {{ context: BrowserContext, page: Page }}
 *
 * An incognito BrowserContext is an isolated environment — it has its own
 * cookie jar, localStorage, cache, and service workers. When the context
 * is closed, all of that data is destroyed. This is the core of session
 * isolation in the RBI proxy.
 */
async function createSession() {
  if (!browser) throw new Error("Browser not launched");

  // Create a brand-new incognito context (isolated from all others)
  const context = await browser.createBrowserContext();

  // Open one page inside the context
  const page = await context.newPage();

  // Lock the viewport so screenshots have a consistent resolution
  await page.setViewport(VIEWPORT);

  // ── Anti-fingerprinting on the page level ────────────────────

  // Spoof user-agent to a generic Firefox (matches Tor Browser)
  await page.setUserAgent(USER_AGENT);

  // Set Accept-Language to generic English to avoid locale fingerprinting
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.5",
  });

  // ── Block trackers natively via CDP (zero overhead, zero video chunk pausing) ──
  try {
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    await cdp.send("Network.setBlockedURLs", {
      urls: [
        "*google-analytics.com*",
        "*googletagmanager.com*",
        "*doubleclick.net*",
        "*googlesyndication.com*",
        "*googleadservices.com*",
        "*adservice.google*",
        "*facebook.net*",
        "*connect.facebook.net*",
        "*scorecardresearch.com*",
        "*criteo.com*",
        "*adnxs.com*",
        "*outbrain.com*",
        "*taboola.com*",
        "*amazon-adsystem.com*",
        "*hotjar.com*",
        "*clarity.ms*",
        "*segment.io*",
        "*mixpanel.com*",
        "*adroll.com*",
        "*rubiconproject.com*",
        "*pubmatic.com*",
        "*openx.net*",
        "*sentry.io*",
        "*datadoghq.com*"
      ]
    });
    // Spoof the WebRTC IP handling policy
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: USER_AGENT,
      platform: "Win32",
    });
    await cdp.detach();
  } catch { /* best effort */ }

  // Inject anti-fingerprinting and media acceleration scripts before any page JS runs
  await page.evaluateOnNewDocument(() => {
    // ── Pre-configure YouTube & HTML5 Video Players ─────────────
    try {
      localStorage.setItem("yt-player-quality", JSON.stringify({
        data: "480p",
        expiration: Date.now() + 86400000,
        creation: Date.now()
      }));
    } catch {}

    // ── Override WebRTC to prevent IP leaks ─────────────────────
    // Replace RTCPeerConnection so no STUN/TURN requests can reveal IP
    Object.defineProperty(window, "RTCPeerConnection", {
      value: undefined, writable: false, configurable: false,
    });
    Object.defineProperty(window, "webkitRTCPeerConnection", {
      value: undefined, writable: false, configurable: false,
    });
    Object.defineProperty(window, "mozRTCPeerConnection", {
      value: undefined, writable: false, configurable: false,
    });

    // ── Spoof canvas fingerprint ────────────────────────────────
    // Add subtle random noise to canvas toDataURL/toBlob so sites
    // can't build a unique fingerprint from canvas rendering.
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const ctx = this.getContext("2d");
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] ^= 1;     // tiny bit flip — invisible but unique
        }
        ctx.putImageData(imageData, 0, 0);
      }
      return origToDataURL.apply(this, args);
    };

    // ── Spoof navigator properties ──────────────────────────────
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory",        { get: () => 8 });
    Object.defineProperty(navigator, "platform",            { get: () => "Win32" });

    // Hide that this is headless Chrome
    Object.defineProperty(navigator, "webdriver", { get: () => false });

    // ── Spoof screen dimensions ─────────────────────────────────
    Object.defineProperty(screen, "width",      { get: () => 1920 });
    Object.defineProperty(screen, "height",     { get: () => 1080 });
    Object.defineProperty(screen, "availWidth", { get: () => 1920 });
    Object.defineProperty(screen, "availHeight",{ get: () => 1040 });
    Object.defineProperty(screen, "colorDepth", { get: () => 24 });
    Object.defineProperty(screen, "pixelDepth", { get: () => 24 });

    // ── Block Geolocation API ───────────────────────────────────
    navigator.geolocation.getCurrentPosition = (s, e) =>
      e?.({ code: 1, message: "User denied Geolocation" });
    navigator.geolocation.watchPosition = () => -1;

    // ── Video & Media Playback Optimizer ─────────────────────────
    const configureMedia = (el) => {
      if (!el) return;
      el.playsInline = true;
      el.setAttribute("playsinline", "");
      el.setAttribute("webkit-playsinline", "");
      if (el.preload === "none") el.preload = "auto";
    };

    window.addEventListener("DOMContentLoaded", () => {
      document.querySelectorAll("video, audio").forEach(configureMedia);

      // Watch for dynamically inserted video/audio elements (SPA players)
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of m.addedNodes) {
            if (node.nodeName === "VIDEO" || node.nodeName === "AUDIO") {
              configureMedia(node);
            } else if (node.querySelectorAll) {
              node.querySelectorAll("video, audio").forEach(configureMedia);
            }
          }
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });

      // Keep YouTube player tuned to smooth streaming bitrate
      setInterval(() => {
        const yt = document.getElementById("movie_player");
        if (yt && typeof yt.setPlaybackQuality === "function") {
          try { yt.setPlaybackQuality("medium"); } catch {}
        }
      }, 3000);
    });
  });

  return { context, page };
}


/**
 * Tear down a session — closes all pages and destroys the incognito context.
 * After this call, all cookies, cache, and history for this session are gone.
 */
async function destroySession(context) {
  try {
    await context.close();
    console.log("[browser] Incognito context destroyed");
  } catch (err) {
    console.error("[browser] Error destroying context:", err.message);
  }
}

/**
 * Shut down the entire browser process. Called on server shutdown.
 */
async function shutdown() {
  if (browser) {
    await browser.close();
    browser = null;
    console.log("[browser] Chromium shut down");
  }
}

module.exports = { launch, createSession, destroySession, shutdown, VIEWPORT };
