/**
 * tor-control.js — Tor Controller client for circuit rotation
 *
 * Communicates with the Tor ControlPort (127.0.0.1:9051) using safe
 * cookie-based authentication. Allows rotating Tor circuits on demand
 * via the standard Tor control protocol command: SIGNAL NEWNYM.
 */

"use strict";

const net = require("net");
const fs = require("fs");
const path = require("path");

const CONTROL_PORT = 9051;
const CONTROL_HOST = "127.0.0.1";

/**
 * Locate the Tor control authentication cookie across Windows and Linux environments.
 */
function getCookiePath() {
  const custom = process.env.TOR_COOKIE_PATH;
  if (custom && fs.existsSync(custom)) return custom;

  const candidates = [
    custom,
    process.env.TOR_DATA_DIR ? path.join(process.env.TOR_DATA_DIR, "control_auth_cookie") : null,
    path.join(__dirname, "..", "tor", "data", "control_auth_cookie"),
    "/tmp/tor-data/control_auth_cookie",
    "/var/lib/tor/control_auth_cookie",
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0] || path.join(__dirname, "..", "tor", "data", "control_auth_cookie");
}

/**
 * Send a command to the Tor ControlPort with cookie authentication.
 *
 * @param {string} cmd — Tor control command (e.g. "SIGNAL NEWNYM")
 * @returns {Promise<string>} — Tor control response
 */
function sendTorControlCommand(cmd) {
  return new Promise((resolve, reject) => {
    const cookiePath = getCookiePath();
    // Check if auth cookie exists
    if (!fs.existsSync(cookiePath)) {
      return reject(new Error(`Tor control auth cookie not found at ${cookiePath}. Is Tor running with CookieAuthentication?`));
    }

    const cookieHex = fs.readFileSync(cookiePath).toString("hex").toUpperCase();
    const socket = net.createConnection({ host: CONTROL_HOST, port: CONTROL_PORT }, () => {
      // Step 1: Authenticate with hex cookie
      socket.write(`AUTHENTICATE ${cookieHex}\r\n`);
    });

    let authenticated = false;
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\r\n");

      while (lines.length > 1) {
        const line = lines.shift();
        if (!authenticated) {
          if (line.startsWith("250")) {
            authenticated = true;
            // Step 2: Send requested command
            socket.write(`${cmd}\r\n`);
          } else {
            socket.destroy();
            return reject(new Error(`Tor authentication failed: ${line}`));
          }
        } else {
          // Response to our command
          if (line.startsWith("250")) {
            socket.write("QUIT\r\n");
            socket.end();
            return resolve(line);
          } else {
            socket.destroy();
            return reject(new Error(`Tor command error: ${line}`));
          }
        }
      }
      buffer = lines[0]; // keep remainder
    });

    socket.on("error", (err) => {
      reject(new Error(`Tor ControlPort connection error: ${err.message}`));
    });

    // Timeout after 5 seconds
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("Tor ControlPort timeout"));
    });
  });
}

/**
 * Rotate Tor circuits by requesting a new identity.
 * Tor switches to clean circuits for future connections.
 */
async function rotateTorCircuit() {
  console.log("[tor-control] Requesting new Tor identity (SIGNAL NEWNYM)...");
  await sendTorControlCommand("SIGNAL NEWNYM");
  console.log("[tor-control] ✅ New Tor circuit active");
  return { success: true, message: "Tor circuit rotated successfully" };
}

module.exports = { rotateTorCircuit, sendTorControlCommand };
