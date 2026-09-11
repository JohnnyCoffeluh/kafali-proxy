# 📱 100% Free Mobile & Cloud Deployment Guide ($0 Budget)

> **Cost:** $0.00 (Forever)  
> **Credit Card Needed:** None  
> **Downloads on iPad/iPhone:** Zero (Works directly in Safari)  
> **Portability:** 100% cross-platform (Windows & Linux Docker)

---

## ☁️ Method 1: Free 24/7 Cloud Hosting on Render.com (Recommended)

Use this so your RBI Proxy is online **24/7 even when your PC and laptop are turned off**.

> **Why Render.com?**  
> • **Cost:** $0.00 Free forever (No credit card needed)  
> • **Docker Container Support:** Automatically builds the included `Dockerfile` with native Linux Tor & Chromium.  
> • **Permanent HTTPS URL:** Gives you a fixed domain (`https://rbi-shield-xxxx.onrender.com`) that never expires.  
> • **100% Safari Compatible:** WebSockets and canvas streaming work seamlessly on iPad and iPhone.

### Step-by-Step Instructions:

1. **Step 1: Create a Free GitHub Repository**
   - Go to [https://github.com/new](https://github.com/new).
   - Repository name: `rbi-proxy`
   - Set visibility to **Private** (recommended) or Public.
   - Click **Create repository**.

2. **Step 2: Push your code from your PC**
   - Open PowerShell inside `c:\Users\canda\Desktop\flutter\bypassos\rbi-proxy` and run:
     ```bash
     git add .
     git commit -m "Deploy RBI Proxy"
     git branch -M main
     git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/rbi-proxy.git
     git push -u origin main
     ```

3. **Step 3: Deploy on Render (1 Click)**
   - Go to [https://render.com](https://render.com) and click **Sign Up with GitHub** (Free, no credit card).
   - In your Render dashboard, click **New +** → **Web Service**.
   - Select your `rbi-proxy` repository from GitHub and click **Connect**.
   - Configure the service:
     - **Name:** `rbi-shield` (or any name you like)
     - **Runtime:** `Docker`
     - **Instance Type:** `Free` ($0/month)
   - Scroll down to **Environment Variables**:
     - Key: `AUTH_TOKEN` | Value: `change-me-to-a-strong-secret` (or your chosen password)
     - Key: `PORT` | Value: `3000`
   - Click **Create Web Service**.

4. **Step 4: Open on your iPad / iPhone**
   - Render will build your Docker container in ~2-3 minutes.
   - Once it turns green (**Live**), Render displays your permanent URL:
     `https://rbi-shield-xxxx.onrender.com/?token=change-me-to-a-strong-secret`
   - Open that URL in Safari on your iPhone/iPad!
   - Tap Safari's **Share button 📤** → **Add to Home Screen** for full-screen edge-to-edge isolated browsing.

---

## ⚡ Method 2: Fast Alternative on Koyeb ($0 Free Tier)

Koyeb is another modern cloud platform supporting Docker web applications with global edge routing:

1. Sign up at [https://www.koyeb.com](https://www.koyeb.com) (Free with GitHub).
2. Click **Create App** → **GitHub**.
3. Select your `rbi-proxy` repository.
4. Builder: Select **Dockerfile**.
5. Set Environment Variable: `AUTH_TOKEN = your-secret-token`.
6. Click **Deploy**. Your permanent HTTPS Koyeb link will be live in 2 minutes.

---

## 💻 Method 3: Instant Local PC Sharing (When Your Computer is On)

Use this when you are sitting at your desk and want to use your PC's powerful hardware and fast home internet connection to browse from your couch on your iPad.

> **Note:** This requires your PC to remain powered on. If your PC goes to sleep or you close the terminal, the connection will pause until reopened.

### Step 1: Start the server
In your terminal inside `rbi-proxy`:
```bash
npm start
```

### Step 2: Open a second terminal and generate your tunnel link
```bash
npm run share
```

### Step 3: Open the generated link on your iPad / iPhone
Safari will open the remote browser instantly with zero app downloads.

---


## 🔒 Mobile Security Checklist

1. **Keep your Token Secret:** The token in `?token=...` prevents random people from finding and using your proxy. Never post your link on public forums.
2. **Use "Add to Home Screen" on iOS:** Safari's URL bars and gesture conflicts disappear when running as a PWA, making touch and scrolling feel completely native.
3. **Use the "🔥 Burn" button:** When finished browsing a sensitive site, tap the **🔥 Burn** button. This wipes all session cookies, clears memory, and rotates the Tor circuit instantly.
4. **Use "🚫 JS: OFF" (NoScript) on High-Risk Sites:** For investigative journalism or untrusted links, tap the **⚡ JS: ON** button to toggle it to **🚫 JS: OFF** before visiting. This prevents any malicious scripts from running.
