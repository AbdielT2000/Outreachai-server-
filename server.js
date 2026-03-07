// ═══════════════════════════════════════════════════════════
//  OutreachAI Backend Server
//  Runs 24/7 on Render.com (free tier)
//  Bridges browser → Gobii, Instantly, Claude APIs
// ═══════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const fetch    = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const app      = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Config from environment variables (set in Render dashboard)
const CONFIG = {
  GOBII_KEY:        process.env.GOBII_KEY        || 'jsi12Ryzv4EGJAPshgDPjhYzJUbzFBDoedCx17rTvGk',
  GOBII_AGENT_ID:   process.env.GOBII_AGENT_ID   || '4fbf39a7-63de-4f61-b59c-80c446298205',
  INSTANTLY_KEY:    process.env.INSTANTLY_KEY    || 'f12hxp884wmd6akz07fecdfg7jc1',
  INSTANTLY_CAMP:   process.env.INSTANTLY_CAMP   || '17b493f6-83fc-4acc-944c-96c8878a581b',
  CLAUDE_KEY:       process.env.CLAUDE_KEY        || '',
  CALENDAR_LINK:    process.env.CALENDAR_LINK     || 'calendly.com/yourlink',
  SENDER_NAME:      process.env.SENDER_NAME       || 'Abdiel',
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '120000'), // 2 min default
};

const GOBII_BASE    = 'https://api.gobii.ai/v1';
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v1';

// ── In-memory state (persists while server runs)
let state = {
  leads:       [],
  seenReplyIds: [],
  blockedEmails: [],
  log:         [],
  stats:       { leadsFound: 0, imported: 0, pushed: 0, repliesRead: 0, interested: 0, autoSent: 0, unsub: 0 },
  lastGobiiPoll:    null,
  lastReplyPoll:    null,
  autoReplyEnabled: true,
};

// ── Logging
function log(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 500) state.log = state.log.slice(0, 500);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ════════════════════════════════════════════════════════════
//  GOBII — Fetch leads from agent
// ════════════════════════════════════════════════════════════
async function fetchGobiiLeads() {
  log('🔍 Polling Gobii for new leads…');
  try {
    // Trigger a new task on the agent
    const taskResp = await fetch(`${GOBII_BASE}/tasks/browser-use/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.GOBII_KEY}` },
      body: JSON.stringify({
        agent_id: CONFIG.GOBII_AGENT_ID,
        task: `Search for marketing agencies with 2-10 employees. Find owner or CEO contacts.
Return a JSON array with fields: firstName, lastName, email, company, title, location, website.
Find at least 10 fresh leads not previously found. Return ONLY valid JSON array.`,
        output_schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              firstName: { type: 'string' },
              lastName:  { type: 'string' },
              email:     { type: 'string' },
              company:   { type: 'string' },
              title:     { type: 'string' },
              location:  { type: 'string' },
              website:   { type: 'string' }
            }
          }
        }
      })
    });

    if (!taskResp.ok) {
      log(`Gobii task error: ${taskResp.status}`, 'error');
      return [];
    }

    const taskData = await taskResp.json();
    const taskId   = taskData.id || taskData.task_id;
    log(`📋 Gobii task started: ${taskId}`);

    // Poll for result (max 2 min)
    for (let i = 0; i < 24; i++) {
      await sleep(5000);
      const r = await fetch(`${GOBII_BASE}/tasks/browser-use/${taskId}/`, {
        headers: { 'Authorization': `Bearer ${CONFIG.GOBII_KEY}` }
      });
      if (!r.ok) continue;
      const d = await r.json();
      const status = d.status || d.state || '';
      log(`Gobii task status: ${status} (${i+1}/24)`);

      if (['completed','done','finished'].includes(status)) {
        const raw = d.output || d.result || d.results || [];
        const leads = parseLeads(raw);
        log(`✅ Gobii returned ${leads.length} leads`);
        return leads;
      }
      if (['failed','error'].includes(status)) {
        log(`Gobii task failed: ${d.error || status}`, 'error');
        return [];
      }
    }
    log('Gobii task timed out', 'warn');
    return [];
  } catch (e) {
    log(`Gobii error: ${e.message}`, 'error');
    return [];
  }
}

function parseLeads(raw) {
  let arr = [];
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw.replace(/```json|```/g, '')); } catch(e) { return []; }
  } else if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && raw.leads)   { arr = raw.leads; }
  else if (raw && raw.results)   { arr = raw.results; }
  else if (raw && raw.data)      { arr = raw.data; }

  return arr.filter(l => l && (l.email || l.firstName)).map(l => ({
    firstName: l.firstName || l.first_name || (l.name||'').split(' ')[0] || '',
    lastName:  l.lastName  || l.last_name  || (l.name||'').split(' ').slice(1).join(' ') || '',
    email:     (l.email    || l.email_address || '').toLowerCase().trim(),
    company:   l.company   || l.company_name || l.organization || '',
    title:     l.title     || l.job_title || '',
    location:  l.location  || l.city || '',
    website:   l.website   || l.url || '',
    tags:      ['gobii'],
    status:    'new',
    addedAt:   new Date().toISOString()
  }));
}

// ════════════════════════════════════════════════════════════
//  INSTANTLY — Push leads + fetch replies
// ════════════════════════════════════════════════════════════
async function pushToInstantly(leads) {
  if (!leads.length) return;
  log(`📤 Pushing ${leads.length} leads to Instantly…`);
  try {
    const body = {
      api_key:              CONFIG.INSTANTLY_KEY,
      campaign_id:          CONFIG.INSTANTLY_CAMP,
      skip_if_in_workspace: true,
      leads: leads.map(l => ({
        email:             l.email,
        first_name:        l.firstName,
        last_name:         l.lastName,
        company_name:      l.company,
        personalization:   l.websiteIntel || `Hi ${l.firstName}, noticed you run ${l.company}.`,
        custom_variables:  { title: l.title, location: l.location, website: l.website }
      }))
    };
    const r = await fetch(`${INSTANTLY_BASE}/lead/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (r.ok) {
      state.stats.pushed += leads.length;
      log(`✅ ${leads.length} leads pushed to Instantly`);
    } else {
      log(`Instantly push error: ${d.message || JSON.stringify(d)}`, 'error');
    }
  } catch (e) {
    log(`Instantly push failed: ${e.message}`, 'error');
  }
}

async function fetchInstantlyReplies() {
  log('📬 Checking Instantly for new replies…');
  try {
    const r = await fetch(
      `${INSTANTLY_BASE}/reply/list?api_key=${CONFIG.INSTANTLY_KEY}&campaign_id=${CONFIG.INSTANTLY_CAMP}&limit=20`
    );
    if (!r.ok) { log(`Instantly reply fetch error: ${r.status}`, 'error'); return []; }
    const d = await r.json();
    return d.replies || d.data || d || [];
  } catch (e) {
    log(`Reply fetch error: ${e.message}`, 'error');
    return [];
  }
}

async function sendInstantlyReply(toEmail, body) {
  try {
    const r = await fetch(`${INSTANTLY_BASE}/reply/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:        CONFIG.INSTANTLY_KEY,
        reply_to_email: toEmail,
        email_body:     body,
        campaign_id:    CONFIG.INSTANTLY_CAMP
      })
    });
    return r.ok;
  } catch (e) { return false; }
}

async function pauseLeadInInstantly(email) {
  try {
    await fetch(`${INSTANTLY_BASE}/lead/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: CONFIG.INSTANTLY_KEY, campaign_id: CONFIG.INSTANTLY_CAMP, email })
    });
  } catch(e) { /* silent */ }
}

// ════════════════════════════════════════════════════════════
//  CLAUDE — Classify reply intent
// ════════════════════════════════════════════════════════════
async function classifyReply(replyText) {
  if (!CONFIG.CLAUDE_KEY) {
    // Fallback: keyword-based classification
    const t = replyText.toLowerCase();
    if (/unsubscribe|remove me|stop emailing|opt.?out/.test(t)) return { classification: 'Spam/Unsubscribe', confidence: 0.99, reasoning: 'Opt-out language detected' };
    if (/not interested|no thanks|not for us/.test(t))          return { classification: 'Not Interested',   confidence: 0.85, reasoning: 'Rejection language' };
    if (/out of office|on vacation|away until/.test(t))         return { classification: 'Out of Office',    confidence: 0.95, reasoning: 'OOO pattern detected' };
    if (/wrong person|not my department|don't handle/.test(t))  return { classification: 'Wrong Person',     confidence: 0.90, reasoning: 'Wrong contact' };
    if (/not now|maybe later|next quarter|too busy/.test(t))    return { classification: 'Not Now',          confidence: 0.80, reasoning: 'Timing objection' };
    if (/tell me more|how does|what does|interested|open to|sure|sounds good|yes/.test(t)) return { classification: 'Interested', confidence: 0.85, reasoning: 'Positive signal' };
    return { classification: 'Not Interested', confidence: 0.50, reasoning: 'No clear signal' };
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':          CONFIG.CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Classify this cold email reply. Use semantic understanding, not just keywords.

REPLY: "${replyText}"

Categories: Interested | Not Now | Not Interested | Wrong Person | Out of Office | Spam/Unsubscribe

Interested examples: "tell me more", "how does this work?", "sure", "open to chatting", "what's the cost?"

Respond ONLY with valid JSON:
{"classification":"...","confidence":0.00,"reasoning":"one sentence"}`
        }]
      })
    });
    const d    = await r.json();
    const text = (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    return JSON.parse(text.replace(/```json|```/g,'').trim());
  } catch(e) {
    return { classification: 'Not Interested', confidence: 0.5, reasoning: 'Classification failed' };
  }
}

function buildResponse(classification) {
  const name = CONFIG.SENDER_NAME;
  const cal  = CONFIG.CALENDAR_LINK;
  const templates = {
    'Interested':     `Awesome — happy to show you.\n\nGrab a quick time here:\n${cal}\n\n– ${name}`,
    'Not Now':        `No worries at all. What month would be better to circle back?\n\n– ${name}`,
    'Not Interested': `All good — appreciate you letting me know. If anything changes, feel free to reach out.\n\n– ${name}`,
    'Wrong Person':   `Got it — who would be the right person to reach out to about this?\n\n– ${name}`,
    'Out of Office':  `Thanks — I'll follow up when you're back.\n\n– ${name}`,
  };
  return templates[classification] || null;
}

// ════════════════════════════════════════════════════════════
//  MAIN WORKERS
// ════════════════════════════════════════════════════════════
async function runLeadWorker() {
  log('═══ Lead Worker starting ═══');
  const leads = await fetchGobiiLeads();
  if (!leads.length) { state.lastGobiiPoll = new Date().toISOString(); return; }

  // Deduplicate
  const existingEmails = new Set(state.leads.map(l => l.email));
  const newLeads = leads.filter(l => l.email && !existingEmails.has(l.email));

  state.stats.leadsFound += leads.length;
  state.stats.imported   += newLeads.length;
  state.leads.push(...newLeads);
  state.lastGobiiPoll = new Date().toISOString();

  log(`✅ ${newLeads.length} new leads imported (${leads.length - newLeads.length} dupes skipped)`);

  if (newLeads.length > 0) await pushToInstantly(newLeads);
}

async function runReplyWorker() {
  log('═══ Reply Worker starting ═══');
  const replies = await fetchInstantlyReplies();
  state.lastReplyPoll = new Date().toISOString();

  for (const reply of replies) {
    const replyId   = reply.id || reply.reply_id || (reply.email + reply.timestamp);
    const fromEmail = (reply.from_email || reply.email || '').toLowerCase();
    const fromName  = reply.from_name  || reply.name  || fromEmail.split('@')[0];
    const bodyText  = reply.body       || reply.text  || reply.reply_text || '';

    if (state.seenReplyIds.includes(replyId)) continue;
    if (state.blockedEmails.includes(fromEmail)) continue;

    state.seenReplyIds.push(replyId);
    state.stats.repliesRead++;

    const result = await classifyReply(bodyText);
    const { classification, confidence, reasoning } = result;
    let action = 'logged';
    let autoSent = false;

    log(`📩 ${fromName} → ${classification} (${Math.round(confidence*100)}%)`);

    if (classification === 'Spam/Unsubscribe') {
      state.blockedEmails.push(fromEmail);
      await pauseLeadInInstantly(fromEmail);
      state.stats.unsub++;
      action = 'blocked_permanently';

    } else if (classification === 'Interested' && confidence >= 0.80 && state.autoReplyEnabled) {
      const response = buildResponse('Interested');
      autoSent = await sendInstantlyReply(fromEmail, response);
      state.stats.interested++;
      state.stats.autoSent++;
      action = autoSent ? 'booking_link_sent' : 'booking_link_failed';
      log(`🎉 Booking link sent to ${fromName}`, 'success');

    } else if (classification === 'Interested' && confidence < 0.80) {
      state.stats.interested++;
      action = 'flagged_for_review';

    } else if (['Not Now','Not Interested','Wrong Person','Out of Office'].includes(classification) && state.autoReplyEnabled) {
      const response = buildResponse(classification);
      if (response) {
        autoSent = await sendInstantlyReply(fromEmail, response);
        if (['Not Now','Not Interested','Out of Office'].includes(classification)) {
          await pauseLeadInInstantly(fromEmail);
        }
        state.stats.autoSent++;
        action = 'replied_and_' + classification.toLowerCase().replace(/ /g,'_');
      }
    }

    state.log.unshift({
      time: new Date().toISOString(),
      from: fromName, fromEmail, body: bodyText.slice(0,160),
      classification, confidence, reasoning, action, autoSent
    });
  }

  if (state.seenReplyIds.length > 1000) state.seenReplyIds = state.seenReplyIds.slice(-1000);
}

// ════════════════════════════════════════════════════════════
//  TIMERS
// ════════════════════════════════════════════════════════════
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startWorkers() {
  log('🚀 OutreachAI server started');

  // Lead worker — every 30 min
  const runLeads = async () => {
    try { await runLeadWorker(); } catch(e) { log('Lead worker error: '+e.message,'error'); }
    setTimeout(runLeads, 30 * 60 * 1000);
  };

  // Reply worker — every 2 min
  const runReplies = async () => {
    try { await runReplyWorker(); } catch(e) { log('Reply worker error: '+e.message,'error'); }
    setTimeout(runReplies, CONFIG.POLL_INTERVAL_MS);
  };

  // Start both after 5 second warmup
  setTimeout(runLeads,   5000);
  setTimeout(runReplies, 8000);
}

// ════════════════════════════════════════════════════════════
//  API ROUTES (called by OutreachAI browser app)
// ════════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), stats: state.stats, lastGobiiPoll: state.lastGobiiPoll, lastReplyPoll: state.lastReplyPoll });
});

// Get all state for the browser app
app.get('/api/state', (req, res) => {
  res.json({
    leads:       state.leads.slice(0, 200),
    stats:       state.stats,
    log:         state.log.slice(0, 100),
    blockedEmails: state.blockedEmails,
    lastGobiiPoll: state.lastGobiiPoll,
    lastReplyPoll: state.lastReplyPoll,
    autoReplyEnabled: state.autoReplyEnabled,
  });
});

// Trigger lead pull now
app.post('/api/leads/fetch', async (req, res) => {
  res.json({ ok: true, message: 'Lead worker started' });
  runLeadWorker().catch(e => log(e.message,'error'));
});

// Trigger reply check now
app.post('/api/replies/check', async (req, res) => {
  res.json({ ok: true, message: 'Reply worker started' });
  runReplyWorker().catch(e => log(e.message,'error'));
});

// Toggle auto-reply
app.post('/api/autoreply/toggle', (req, res) => {
  state.autoReplyEnabled = !state.autoReplyEnabled;
  log(`Auto-reply ${state.autoReplyEnabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ autoReplyEnabled: state.autoReplyEnabled });
});

// Add leads manually (from browser app)
app.post('/api/leads/add', async (req, res) => {
  const leads = req.body.leads || [];
  if (!leads.length) return res.json({ ok: false, message: 'No leads' });
  await pushToInstantly(leads);
  state.leads.push(...leads);
  state.stats.imported += leads.length;
  res.json({ ok: true, pushed: leads.length });
});

// Proxy: Gobii API (solves CORS)
app.get('/api/proxy/gobii/*', async (req, res) => {
  try {
    const path = req.params[0];
    const r = await fetch(`${GOBII_BASE}/${path}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.GOBII_KEY}` }
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Proxy: Instantly API (solves CORS)
app.all('/api/proxy/instantly/*', async (req, res) => {
  try {
    const path = req.params[0];
    const r = await fetch(`${INSTANTLY_BASE}/${path}`, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Unblock email
app.post('/api/unblock', (req, res) => {
  const { email } = req.body;
  state.blockedEmails = state.blockedEmails.filter(e => e !== email);
  res.json({ ok: true });
});

// Clear log
app.post('/api/log/clear', (req, res) => {
  state.log = [];
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OutreachAI server running on port ${PORT}`);
  startWorkers();
});
