# OutreachAI Server — Deploy Guide

## What this does
Runs 24/7 on Render.com (free). Fixes the CORS error and keeps your pipeline running even when your browser is closed.

- Polls Gobii every 30 min for new leads
- Pushes leads to Instantly automatically  
- Checks for replies every 2 minutes
- Classifies replies with Claude AI
- Sends booking link to interested prospects automatically

---

## Deploy in 5 steps

### Step 1 — Create a GitHub account
Go to github.com and sign up free if you don't have one.

### Step 2 — Upload these files to GitHub
1. Click "New repository"
2. Name it: `outreachai-server`
3. Make it Public
4. Upload all 3 files: `server.js`, `package.json`, `render.yaml`

### Step 3 — Create a Render account
Go to render.com → Sign up with your GitHub account.

### Step 4 — Deploy
1. In Render dashboard → click "New +" → "Web Service"
2. Connect your GitHub repo `outreachai-server`
3. Render auto-detects everything from render.yaml
4. Add your Claude API key in Environment Variables:
   - Key: `CLAUDE_KEY`
   - Value: your Anthropic API key (from console.anthropic.com)
5. Click "Deploy"

### Step 5 — Connect to OutreachAI app
1. After deploy, Render gives you a URL like: `https://outreachai-server.onrender.com`
2. Open OutreachAI app → Settings → paste that URL into "Backend Server URL"
3. Click Save & Connect

That's it. Everything runs 24/7 from that point.

---

## Your credentials (already in render.yaml)
- Gobii Key: jsi12Ryzv4EGJAPshgDPjhYzJUbzFBDoedCx17rTvGk
- Gobii Agent: 4fbf39a7-63de-4f61-b59c-80c446298205
- Instantly Key: f12hxp884wmd6akz07fecdfg7jc1
- Campaign ID: 17b493f6-83fc-4acc-944c-96c8878a581b

---

## API Endpoints (for reference)
- GET  /              → health check + stats
- GET  /api/state     → full state for browser app
- POST /api/leads/fetch  → trigger lead pull now
- POST /api/replies/check → trigger reply check now
- POST /api/autoreply/toggle → enable/disable auto-reply
- GET  /api/proxy/gobii/*  → proxies Gobii API (fixes CORS)
- ALL  /api/proxy/instantly/* → proxies Instantly API (fixes CORS)
