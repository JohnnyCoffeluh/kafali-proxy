/**
 * scripts/deploy-hf.js — 1-Click Automated Hugging Face Space Deployment
 *
 * Uses the installed Hugging Face CLI to:
 * 1. Verify authentication
 * 2. Create a 100% PUBLIC Docker Space (16GB RAM, 2 vCPU, $0 Free)
 * 3. Upload all project files
 * 4. Output the permanent live link for iPad, iPhone, and any device (NO tokens needed)
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const hfExe = path.join(process.env.USERPROFILE || "", ".local", "bin", "hf.exe");

console.log("\n  🤗 Automated Hugging Face Space Deployment (Public, Open Access)");
console.log("  " + "═".repeat(60));

// Check if a token was passed as an argument or in environment
const argToken = process.argv.find((a) => a.startsWith("hf_"));
const envToken = process.env.HF_TOKEN;
const tokenToUse = argToken || envToken;

if (tokenToUse) {
  try {
    console.log("  🔑 Authenticating with provided Hugging Face token...");
    execSync(`"${hfExe}" auth login --token "${tokenToUse}"`, { stdio: "ignore" });
    console.log("  ✅ Logged in successfully!");
  } catch (err) {
    console.error("  ❌ Token login failed:", err.message);
  }
}

// Step 1: Check authentication
let username = null;
try {
  const whoamiOutput = execSync(`"${hfExe}" auth whoami`, { encoding: "utf-8" }).trim();
  const match = whoamiOutput.match(/user=([a-zA-Z0-9_-]+)/) || whoamiOutput.match(/Logged in as ([a-zA-Z0-9_-]+)/);
  if (match) {
    username = match[1];
  } else {
    username = whoamiOutput.replace(/^user=/, "").trim();
  }
} catch (err) {
  console.error("\n  ❌ You are not logged in to Hugging Face yet.");
  console.log("  To authenticate (100% free, no credit card):");
  console.log("  1. Copy your free User Access Token from: https://huggingface.co/settings/tokens");
  console.log("  2. Run: npm run deploy:hf <YOUR_TOKEN>\n");
  process.exit(1);
}

// Determine space name
const remainingArgs = process.argv.slice(2).filter((a) => !a.startsWith("hf_"));
const spaceName = remainingArgs[0] || "rbi-shield";
const repoId = `${username}/${spaceName}`;

console.log(`\n  👤 Authenticated as: ${username}`);
console.log(`  📦 Target Space: ${repoId} (100% PUBLIC, Docker, 16GB RAM Free)`);

// Step 2: Create or verify Space repo as PUBLIC
console.log("\n  [1/2] Creating/Verifying Public Space repository on Hugging Face...");
try {
  execSync(
    `"${hfExe}" repos create "${repoId}" --type space --sdk docker --flavor cpu-basic --public --exist-ok`,
    { stdio: "inherit" }
  );
  console.log("  ✅ Public Space repository confirmed");
} catch (err) {
  console.warn("  ℹ️ Space check note:", err.message);
}

// Step 3: Upload code
console.log("\n  [2/2] Uploading Docker application files to Space...");
try {
  execSync(
    `"${hfExe}" upload "${repoId}" . . --type space --exclude "tor/**" --exclude "node_modules/**" --exclude "*.exe" --exclude "cloudflared.exe" --exclude ".env" --exclude ".git/**" --commit-message "Deploy Public RBI Proxy v1.0"`,
    { stdio: "inherit" }
  );
  console.log("  ✅ Upload complete! Space is now building in the cloud.");
} catch (err) {
  console.error("  ❌ Upload failed:", err.message);
  process.exit(1);
}

// Summary
const liveUrl = `https://${username}-${spaceName}.hf.space`;
const spaceUrl = `https://huggingface.co/spaces/${username}/${spaceName}`;
console.log("\n" + "═".repeat(72));
console.log("  🎉 DEPLOYED AS 100% PUBLIC WEB APP ON HUGGING FACE SPACES ($0 FOREVER)!");
console.log("═".repeat(72));
console.log("\n  📱 Direct Live App (Instant Access on ANY device — NO TOKENS):");
console.log(`  👉 \x1b[36m\x1b[1m${liveUrl}\x1b[0m`);
console.log(`\n  ⚙️ Space Management & Logs:`);
console.log(`  🔗 ${spaceUrl}`);
console.log("\n  ⏳ Hugging Face is building the Docker container (takes ~2 minutes).");
console.log("  Once the build finishes, open the link on your iPad, iPhone, or PC!");
console.log("═".repeat(72) + "\n");

