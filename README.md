---
title: RBI Shield Proxy
emoji: 🛡️
colorFrom: indigo
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---


# 🛡️ RBI Proxy — Remote Browser Isolation & Anti-Tracking Shield

A zero-trust Remote Browser Isolation (RBI) proxy designed to neutralize web exploits, malware, and tracking. Runs an isolated Chromium instance inside a hardened sandbox and routes 100% of network and DNS traffic through the Tor network.

---

## 🚀 Features

- **🧅 100% Tor-Routed Traffic**: SOCKS5 proxy + DNS-over-Tor prevents ISP & destination tracking.
- **⚡ Hard Killswitch**: If Tor disconnects for even 1 millisecond, outbound traffic freezes instantly.
- **🛡️ Anti-De-Anonymization Suite**: Keystroke biometric jitter (15–45ms), canvas spoofing, WebRTC hardware leak protection, and NoScript mode.
- **🔥 1-Click Panic Burner**: Wipes cookies, cache, memory, and requests a new Tor circuit (`SIGNAL NEWNYM`).
- **📱 Universal Multi-Device Web Access**: Zero app installs needed on iOS/Android. Touch gestures (tap, drag-scroll, virtual keyboard bridge) and responsive layout.

---

## 📱 Instant Free Access on iPad & iPhone ($0 — No Downloads)

To open the RBI browser on your iPad or iPhone right now via your PC:

```bash
npm run share
```

This starts a free Cloudflare Quick Tunnel and gives you a direct link:
`https://<random-id>.trycloudflare.com/?token=<your-token>`

1. Open this link in Safari on your iPad or iPhone.
2. Tap the Safari **Share** icon (square with arrow up).
3. Select **Add to Home Screen** for full-screen edge-to-edge isolated browsing!

---

## ☁️ 100% Free 24/7 Cloud Hosting ($0 Forever — No Credit Card)

You can host this app 24/7 in the cloud so it works even when your computer is shut down.

### Option 1: Hugging Face Spaces (Recommended — 16GB RAM / 2 vCPU FREE)
1. Go to [huggingface.co](https://huggingface.co) and sign up (free, no credit card).
2. Click **New Space** → Name: `rbi-shield` → Space SDK: **Docker (Blank)**.
3. Push or upload the repository files (`Dockerfile`, `package.json`, `server/`, `public/`, `README.md`).
4. Hugging Face builds the Docker container automatically and gives you a free HTTPS link `https://username-rbi-shield.hf.space/?token=your-token`!

### Option 2: Render.com
1. Go to [render.com](https://render.com) and sign up using GitHub.
2. Click **New +** → **Web Service** → Connect your GitHub repository.
3. Select runtime **Docker**, Free plan ($0).
4. Set Environment Variable: `AUTH_TOKEN` = `your-secret-password`.
5. Render deploys the app and provides a free HTTPS link `https://<app-name>.onrender.com`.

---

## 💻 Local Development

```bash
# Install dependencies
npm install

# Start local server
npm start

# Share to mobile devices
npm run share
```
