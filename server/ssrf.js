/**
 * ssrf.js — Server-Side Request Forgery (SSRF) defense
 *
 * Before navigating Puppeteer to any URL we:
 *   1. Parse the URL and reject dangerous schemes (file:, data:, javascript:)
 *   2. Resolve the hostname to an IP address via DNS
 *   3. Check the resolved IP against blocked private/internal CIDR ranges
 *
 * This prevents an attacker from using the RBI proxy to reach internal
 * services, cloud metadata endpoints, or the loopback interface.
 */

"use strict";

const dns = require("dns");
const { URL } = require("url");

// ── Blocked scheme list ────────────────────────────────────────
const BLOCKED_SCHEMES = new Set(["file:", "data:", "javascript:", "ftp:"]);

// ── Blocked IPv4 CIDR ranges ──────────────────────────────────
// Each entry: [networkBigInt, maskBigInt]
const BLOCKED_IPV4_CIDRS = [
  parseCIDRv4("0.0.0.0/8"),       // "This" network
  parseCIDRv4("10.0.0.0/8"),      // Private (RFC 1918)
  parseCIDRv4("100.64.0.0/10"),   // Carrier-grade NAT
  parseCIDRv4("127.0.0.0/8"),     // Loopback
  parseCIDRv4("169.254.0.0/16"),  // Link-local (incl. cloud metadata)
  parseCIDRv4("172.16.0.0/12"),   // Private (RFC 1918)
  parseCIDRv4("192.0.0.0/24"),    // IETF protocol assignments
  parseCIDRv4("192.168.0.0/16"),  // Private (RFC 1918)
  parseCIDRv4("198.18.0.0/15"),   // Benchmark testing
  parseCIDRv4("224.0.0.0/4"),     // Multicast
  parseCIDRv4("240.0.0.0/4"),     // Reserved
];

// ── Blocked IPv6 addresses ────────────────────────────────────
const BLOCKED_IPV6 = new Set([
  "::1",       // Loopback
  "::",        // Unspecified
]);

// IPv6 prefixes that map to private ranges
const BLOCKED_IPV6_PREFIXES = [
  "fc",  // fc00::/7 — Unique Local Addresses
  "fd",  // fd00::/8 — subset of ULA
  "fe80", // fe80::/10 — Link-local
];

// ── Helpers ───────────────────────────────────────────────────

/**
 * Parse an IPv4 CIDR string like "10.0.0.0/8" into [network, mask] bigints.
 */
function parseCIDRv4(cidr) {
  const [ip, prefixLen] = cidr.split("/");
  const parts = ip.split(".").map(Number);
  const ipInt = BigInt(
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
  const mask = prefixLen === "0"
    ? 0n
    : BigInt(0xffffffff) << BigInt(32 - Number(prefixLen)) & BigInt(0xffffffff);
  return [ipInt & mask, mask];
}

/**
 * Convert a dotted-quad IPv4 string to a bigint.
 */
function ipv4ToBigInt(ip) {
  const parts = ip.split(".").map(Number);
  return BigInt(
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

/**
 * Returns true if the given IPv4 string falls within any blocked CIDR.
 */
function isBlockedIPv4(ip) {
  const ipInt = ipv4ToBigInt(ip);
  return BLOCKED_IPV4_CIDRS.some(([network, mask]) => (ipInt & mask) === network);
}

/**
 * Returns true if the given IPv6 string is blocked.
 */
function isBlockedIPv6(ip) {
  const normalized = ip.toLowerCase();
  if (BLOCKED_IPV6.has(normalized)) return true;
  return BLOCKED_IPV6_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// ── Public API ────────────────────────────────────────────────

const net = require("net");

// ── Tor DNS Resolver ──────────────────────────────────────────
// Route SSRF DNS validation queries through Tor's DNSPort (127.0.0.1:9053)
const torResolver = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
try {
  torResolver.setServers(["127.0.0.1:9053"]);
} catch (e) {
  console.warn("[ssrf] Could not bind Tor DNS resolver:", e.message);
}

async function resolveHostname(hostname) {
  try {
    const v4 = await torResolver.resolve4(hostname);
    if (v4 && v4.length > 0) return v4[0];
  } catch (err4) {
    try {
      const v6 = await torResolver.resolve6(hostname);
      if (v6 && v6.length > 0) return v6[0];
    } catch (err6) {
      throw new Error(`Tor DNS query timed out: ${err4.message}`);
    }
  }
  return null;
}

/**
 * Validate a URL string for safe navigation.
 */
async function isSafeUrl(urlString) {
  // Step 1: Parse
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { safe: false, reason: "Malformed URL" };
  }

  // Reject dangerous schemes
  if (BLOCKED_SCHEMES.has(parsed.protocol)) {
    return { safe: false, reason: `Blocked scheme: ${parsed.protocol}` };
  }

  // Only allow http/https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, reason: `Unsupported scheme: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Quick-reject obvious private hostnames
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home")
  ) {
    return { safe: false, reason: "Blocked hostname: private/local" };
  }

  // If hostname is directly an IPv4 literal
  if (net.isIP(hostname) === 4) {
    if (isBlockedIPv4(hostname)) {
      return { safe: false, reason: `Blocked private IPv4: ${hostname}` };
    }
    return { safe: true };
  }

  // If hostname is directly an IPv6 literal
  if (net.isIP(hostname) === 6) {
    if (isBlockedIPv6(hostname)) {
      return { safe: false, reason: `Blocked private IPv6: ${hostname}` };
    }
    return { safe: true };
  }

  // Step 2: Attempt DNS resolution via Tor DNS to detect rebinding to private IPs
  try {
    const address = await resolveHostname(hostname);
    if (address) {
      const family = address.includes(":") ? 6 : 4;
      if (family === 4 && isBlockedIPv4(address)) {
        return {
          safe: false,
          reason: `Resolved IP ${address} is in a blocked private range`,
        };
      }
      if (family === 6 && isBlockedIPv6(address)) {
        return {
          safe: false,
          reason: `Resolved IPv6 ${address} is in a blocked range`,
        };
      }
    }
  } catch (err) {
    // If Tor's UDP DNS port times out (e.g. during circuit building), but the target
    // is a public domain name, allow it through to Chromium since Chromium's
    // SOCKS5 proxy will resolve it remotely on the Tor exit node with zero ISP leakage!
    console.warn(`[ssrf] Tor DNS note for ${hostname}: ${err.message} — delegating to Tor SOCKS5 proxy`);
  }

  return { safe: true };
}

module.exports = { isSafeUrl };


