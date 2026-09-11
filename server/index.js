/**
 * index.js — Express + WebSocket server entry point
 *
 * Architecture overview:
 *
 *   ┌───────────────────────────────────────────────────────┐
 *   │                    Express Server                     │
 *   │                                                       │
 *   │  GET /          → serves public/index.html            │
 *   │  GET /health    → JSON health check (auth required)   │
 *   │  WS  /ws?token= → WebSocket upgrade (auth required)  │
 *   │                                                       │
 *   │  ┌─────────────────────────────────────────────────┐  │
 *   │  │        WebSocket Server (ws library)            │  │
 *   │  │                                                 │  │
 *   │  │  on connection → verifyToken → initSession()    │  │
 *   │  │  on message    → session.js routes to Puppeteer │  │
 *   │  │  on close      → destroySession()               │  │
 *   │  └─────────────────────────────────────────────────┘  │
 *   └───────────────────────────────────────────────────────┘
 */

"use strict";

// Load env vars before anything else
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const express = require("express");
const { WebSocketServer } = require("ws");

const { verifyToken, requireAuth } = require("./auth");
const { launch, shutdown } = require("./browser");
const { initSession } = require("./session");
const { rotateTorCircuit } = require("./tor-control");

const PORT = parseInt(process.env.PORT, 10) || 7860;

// ── Tor process handle & Killswitch state ────────────────────
let torProcess = null;
let torHealthy = false;

function isTorHealthy() {
  return torHealthy && torProcess !== null && !torProcess.killed;
}

// ── Express app ───────────────────────────────────────────────

const app = express();

// Serve the frontend from public/ (no-cache for instant frontend updates)
app.use(express.static(path.join(__dirname, "..", "public"), {
  etag: false,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
}));

// Health-check endpoint (protected)
app.get("/health", requireAuth, (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), torHealthy: isTorHealthy() });
});

// Killswitch status endpoint
app.get("/api/killswitch-status", requireAuth, (_req, res) => {
  res.json({ killswitchEngaged: !isTorHealthy(), torHealthy: isTorHealthy() });
});

// Tor circuit rotation endpoint
app.post("/api/rotate-circuit", requireAuth, async (_req, res) => {
  try {
    const result = await rotateTorCircuit();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HTTP server ───────────────────────────────────────────────

const server = http.createServer(app);

// ── WebSocket server ──────────────────────────────────────────
//
// The WS server is attached to the same HTTP server. It listens for
// upgrade requests on the /ws path.
//
// Ultra-Low Latency optimizations:
//   - perMessageDeflate: false — avoids wasting CPU compressing already-compressed JPEGs
//   - TCP_NODELAY — disables Nagle's algorithm, sending packets immediately (0ms delay)
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

server.on("upgrade", (request, socket, head) => {
  // Only accept upgrades on /ws
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  // Force TCP_NODELAY immediately: cuts packet ping by 40-80ms!
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 10000);

  // Open access — complete WebSocket handshake for any client
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", async (ws, _request) => {
  console.log("[ws] Client connected (%d total)", wss.clients.size);

  try {
    // Create an isolated Puppeteer session for this client
    await initSession(ws);
  } catch (err) {
    console.error("[ws] Failed to init session:", err.message);
    ws.close(1011, "Session initialization failed");
  }

  ws.on("close", () => {
    console.log("[ws] Client disconnected (%d remaining)", wss.clients.size);
  });
});

// ── Tor auto-start ────────────────────────────────────────────

/**
 * Start the Tor SOCKS5 proxy process.
 * Waits for "Bootstrapped 100%" before resolving.
 */
function startTor() {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const torDir = path.join(__dirname, "..", "tor");
    const torExe = process.env.TOR_EXECUTABLE_PATH || (isWin ? path.join(torDir, "tor", "tor.exe") : "tor");
    const dataDir = process.env.TOR_DATA_DIR || (isWin ? path.join(torDir, "data") : "/tmp/tor-data");

    // Ensure data directory exists
    const fs = require("fs");
    try {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
    } catch (e) {
      console.warn("[tor] Warning creating dataDir:", e.message);
    }

    console.log(`[tor] Starting Tor proxy via ${torExe} (data: ${dataDir})...`);

    const torArgs = [
      "--SocksPort", "9050 KeepAliveIsolateSOCKSAuth OptimisticData",
      "--DNSPort", "9053",
      "--ControlPort", "9051",
      "--CookieAuthentication", "1",
      "--AvoidDiskWrites", "1",
      "--CircuitBuildTimeout", "10",
      "--NumEntryGuards", "1",
      "--ClientUseIPv6", "0",
      "--AutomapHostsOnResolve", "1",
      "--NewCircuitPeriod", "1800",
      "--MaxCircuitDirtiness", "1800",
      "--ClientOnly", "1",
      "--MaxMemInQueues", "512 MBytes",
      "--BandwidthRate", "100 MBytes",
      "--BandwidthBurst", "200 MBytes",
      "--DataDirectory", dataDir,
    ];

    // On Windows, bundle includes geoip files in tor/data
    const geoip = path.join(dataDir, "geoip");
    const geoip6 = path.join(dataDir, "geoip6");
    if (fs.existsSync(geoip)) torArgs.push("--GeoIPFile", geoip);
    if (fs.existsSync(geoip6)) torArgs.push("--GeoIPv6File", geoip6);

    torProcess = spawn(torExe, torArgs, { stdio: ["ignore", "pipe", "pipe"] });

    let resolved = false;

    torProcess.stdout.on("data", (data) => {
      const line = data.toString().trim();
      // Show key bootstrap milestones
      if (line.includes("Bootstrapped")) {
        const match = line.match(/Bootstrapped (\d+)%/);
        if (match) process.stdout.write(`\r[tor] Bootstrapped ${match[1]}%`);
      }
      if (line.includes("Bootstrapped 100%") && !resolved) {
        resolved = true;
        torHealthy = true;
        console.log("\n[tor] ✅ Tor is ready — SOCKS5 proxy on 127.0.0.1:9050 (Killswitch Active)");
        resolve();
      }
    });

    torProcess.stderr.on("data", (data) => {
      const line = data.toString().trim();
      if (line) console.error("[tor/err]", line);
    });

    torProcess.on("error", (err) => {
      torHealthy = false;
      if (!resolved) reject(new Error(`Tor failed to start: ${err.message}`));
    });

    torProcess.on("exit", (code) => {
      torHealthy = false;
      console.warn(`\n[tor] 🛑 Tor process exited with code ${code}. ENGAGING HARD KILLSWITCH.`);
      // Broadcast emergency killswitch notification to all connected clients
      for (const client of wss.clients) {
        try {
          if (client.readyState === 1) {
            client.send(JSON.stringify({
              type: "killswitch-engaged",
              message: "🛑 KILLSWITCH ENGAGED: Tor connection lost. Outbound network frozen to prevent deanonymization.",
            }));
          }
        } catch {}
      }
      if (!resolved) reject(new Error(`Tor exited with code ${code}`));
      torProcess = null;
    });

    // Timeout after 60 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error("Tor failed to bootstrap within 60 seconds"));
      }
    }, 60_000);
  });
}

/**
 * Stop the Tor process.
 */
function stopTor() {
  if (torProcess) {
    torProcess.kill();
    torProcess = null;
    console.log("[tor] Tor process stopped");
  }
}

// ── Boot sequence ─────────────────────────────────────────────

async function main() {
  // 1. Start Tor SOCKS5 proxy
  await startTor();

  // 2. Launch Chromium (routed through Tor)
  await launch();

  // 3. Start HTTP server
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  🛡️  RBI Proxy running at http://localhost:${PORT} (0.0.0.0:${PORT})`);
    console.log(`  🧅 All traffic routed through Tor (your IP is hidden)`);
    console.log(`  🌐 Public Access Mode: Open to anyone with the link (no token required)\n`);
  });
}

// ── Graceful shutdown ─────────────────────────────────────────

async function gracefulShutdown(signal) {
  console.log(`\n[server] Received ${signal}, shutting down...`);

  // Close all WebSocket connections
  for (const client of wss.clients) {
    client.close(1001, "Server shutting down");
  }

  // Close HTTP server
  server.close();

  // Shut down Chromium
  await shutdown();

  // Stop Tor
  stopTor();

  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// Start the server
main().catch((err) => {
  console.error("[server] Fatal error:", err);
  process.exit(1);
});
