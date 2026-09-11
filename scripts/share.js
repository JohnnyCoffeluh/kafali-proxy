/**
 * scripts/share.js — 1-Click Zero-Dollar Tunnel Sharing
 *
 * Generates an instant, free HTTPS link with no sign-ups or credit cards.
 * Routes directly to your local RBI Proxy so you can use it on your
 * iPad and iPhone with ZERO app downloads.
 */

"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PORT = process.env.PORT || 7860;

console.log("\n  🚀 Starting instant $0 tunnel for iPad & iPhone access...");
console.log(`  🔗 Target local port: ${PORT}`);

const cloudflaredExe = path.join(__dirname, "..", "cloudflared.exe");

if (fs.existsSync(cloudflaredExe)) {
  startCloudflareTunnel();
} else {
  startLocaltunnel();
}

function displayBanner(publicUrl) {
  const directLink = publicUrl;


  console.log("\n" + "═".repeat(72));
  console.log("  🛡️  RBI PROXY — FREE ZERO-DOWNLOAD LINK READY!");
  console.log("═".repeat(72));
  console.log("\n  📱 Direct 1-Click Link for Safari (iPad & iPhone):");
  console.log(`  👉 \x1b[36m\x1b[1m${directLink}\x1b[0m`);
  console.log("\n  ✨ How to use on iOS (Safari):");
  console.log("     1. Open the link above in Safari (NO app downloads needed!).");
  console.log("     2. Tap the Share button 📤 (square with arrow up).");
  console.log("     3. Tap 'Add to Home Screen' for full-screen edge-to-edge app mode.");
  console.log("\n  🔒 All remote browsing is isolated on your PC and routed via Tor.");
  console.log("  🛑 Press Ctrl+C in this terminal whenever you want to stop sharing.");
  console.log("═".repeat(72) + "\n");
}

function startCloudflareTunnel() {
  console.log("  ⚡ Using Cloudflare Quick Tunnel (Free, End-to-End Encrypted)...");

  const child = spawn(cloudflaredExe, ["tunnel", "--url", `http://127.0.0.1:${PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let found = false;

  const checkLine = (chunk) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match && !found) {
      found = true;
      displayBanner(match[0]);
    }
  };

  child.stdout.on("data", checkLine);
  child.stderr.on("data", checkLine);

  child.on("error", (err) => {
    console.warn("  ⚠️ Cloudflare tunnel error:", err.message);
    startLocaltunnel();
  });

  child.on("exit", (code) => {
    if (!found) {
      console.warn("  ⚠️ Cloudflare tunnel closed early. Falling back to localtunnel...");
      startLocaltunnel();
    }
  });

  process.on("SIGINT", () => {
    child.kill();
    process.exit(0);
  });
}

function startLocaltunnel() {
  console.log("  ⚡ Starting localtunnel fallback...");
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npxCmd, ["-y", "localtunnel", "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let found = false;

  const checkLine = (chunk) => {
    const text = chunk.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.loca\.lt/);
    if (match && !found) {
      found = true;
      displayBanner(match[0]);
    }
  };

  child.stdout.on("data", checkLine);
  child.stderr.on("data", checkLine);

  process.on("SIGINT", () => {
    child.kill();
    process.exit(0);
  });
}
