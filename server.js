// ═══════════════════════════════════════════════════════════
//  OutreachAI Backend Server
//  Runs 24/7 on Render.com
//  Bridges browser → Gobii, Instantly, Claude APIs
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Helpers
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(url, fallback) {
  const raw = String(url || fallback || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function joinUrl(base, path = '') {
  const cleanBase = normalizeBaseUrl(base, '');
  const cleanPath = String(path || '').replace(/^\/+/, '');
  if (!cleanBase) throw new Error('Missing base URL');
  return cleanPath ? `${cleanBase}/${cleanPath}` : cleanBase;
}

function withProtocol(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function isConfigured(value) {
  return Boolean(String(value || '').trim());
}

// ── Config from Render environment variables
const CONFIG = {
  GOBII_KEY: String(process.env.GOBII_API_KEY || process.env.GOBII_KEY || '').trim(),
  GOBII_AGENT_ID: String(process.env.GOBII_AGENT_ID || '').trim(),

  INSTANTLY_KEY: String(process.env.INSTANTLY_API_KEY || process.env.INSTANTLY_KEY || '').trim(),
  INSTANTLY_CAMP: String(process.env.INSTANTLY_CAMPAIGN_ID || process.env.INSTANTLY_CAMP || '').trim(),

  CLAUDE_KEY: String(process.env.CLAUDE_KEY || process.env.ANTHROPIC_API_KEY || '').trim(),

  CALENDAR_LINK: withProtocol(process.env.CALENDAR_LINK || 'calendly.com/yourlink'),
  SENDER_NAME: String(process.env.SENDER_NAME || 'Abdiel').trim(),

  POLL_INTERVAL_MS: Math.max(
    30000,
    parseInt(process.env.POLL_INTERVAL_MS || '120000', 10) || 120000
  ),

  LEAD_POLL_INTERVAL_MS: Math.max(
    300000,
    parseInt(process.env.LEAD_POLL_INTERVAL_MS || '1800000', 10) || 1800000
  ),
};

const GOBII_BASE = normalizeBaseUrl(
  process.env.GOBII_BASE_URL,
  'https://gobii.ai/api/v1'
);

const INSTANTLY_BASE = normalizeBaseUrl(
  process.env.INSTANTLY_BASE_URL,
  'https://api.instantly.ai/api/v1'
);

// ── In-memory state
let state = {
  leads: [],
  seenReplyIds: [],
  blockedEmails: [],
  log: [],
  stats: {
    leadsFound: 0,
    imported: 0,
    pushed: 0,
    repliesRead: 0,
    interested: 0,
    autoSent: 0,
    unsub: 0,
  },
  lastGobiiPoll: null,
  lastReplyPoll: null,
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
//  GOBII
// ════════════════════════════════════════════════════════════
function gobiiHeaders() {
  return {
    'X-Api-Key': CONFIG.GOBII_KEY,
    'Content-Type': 'application/json',
  };
}

async function testGobiiConnection() {
  const url = joinUrl(GOBII_BASE, 'ping/');
  const r = await fetch(url, { headers: gobiiHeaders() });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: r.ok, status: r.status, data, url };
}

async function fetchGobiiLeads() {
  if (!isConfigured(CONFIG.GOBII_KEY) || !isConfigured(CONFIG.GOBII_AGENT_ID)) {
    log('Gobii lead worker skipped: missing GOBII_API_KEY or GOBII_AGENT_ID', 'warn');
    return [];
  }

  log('🔍 Polling Gobii for new leads…');

  try {
    const taskUrl = joinUrl(GOBII_BASE, 'tasks/browser-use/');
    const taskResp = await fetch(taskUrl, {
      method: 'POST',
      headers: gobiiHeaders(),
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
              lastName: { type: 'string' },
              email: { type: 'string' },
              company: { type: 'string' },
              title: { type: 'string' },
              location: { type: 'string' },
              website: { type: 'string' },
            },
          },
        },
      }),
    });

    const taskText = await taskResp.text();
    let taskData;
    try {
      taskData = JSON.parse(taskText);
    } catch {
      taskData = { raw: taskText };
    }

    if (!taskResp.ok) {
      log(`Gobii task error: ${taskResp.status} — ${taskText}`, 'error');
      return [];
    }

    const taskId = taskData.id || taskData.task_id;
    if (!taskId) {
      log(`Gobii task started but no task id returned: ${taskText}`, 'error');
      return [];
    }

    log(`📋 Gobii task started: ${taskId}`);

    for (let i = 0; i < 24; i++) {
      await sleep(5000);

      const pollUrl = joinUrl(GOBII_BASE, `tasks/browser-use/${taskId}/`);
      const r = await fetch(pollUrl, { headers: gobiiHeaders() });
      const text = await r.text();

      if (!r.ok) {
        log(`Gobii poll non-200: ${r.status}`, 'warn');
        continue;
      }

      let d;
      try {
        d = JSON.parse(text);
      } catch {
        d = { raw: text };
      }

      const status = String(d.status || d.state || '').toLowerCase();
      log(`Gobii task status: ${status || 'unknown'} (${i + 1}/24)`);

      if (['completed', 'done', 'finished', 'success', 'succeeded'].includes(status)) {
        const raw = d.output || d.result || d.results || d.data || [];
        const leads = parseLeads(raw);
        log(`✅ Gobii returned ${leads.length} leads`);
        return leads;
      }

      if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
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
    try {
      arr = JSON.parse(raw.replace(/```json|```/g, ''));
    } catch {
      return [];
    }
  } else if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && raw.leads) {
    arr = raw.leads;
  } else if (raw && raw.results) {
    arr = raw.results;
  } else if (raw && raw.data) {
    arr = raw.data;
  }

  return arr
    .filter((l) => l && (l.email || l.firstName || l.name))
    .map((l) => ({
      firstName: l.firstName || l.first_name || (l.name || '').split(' ')[0] || '',
      lastName: l.lastName || l.last_name || (l.name || '').split(' ').slice(1).join(' ') || '',
      email: (l.email || l.email_address || '').toLowerCase().trim(),
      company: l.company || l.company_name || l.organization || '',
      title: l.title || l.job_title || '',
      location: l.location || l.city || '',
      website: l.website || l.url || '',
      websiteIntel: l.websiteIntel || l.personalization || '',
      tags: ['gobii'],
      status: 'new',
      addedAt: new Date().toISOString(),
    }))
    .filter((l) => l.email);
}

// ════════════════════════════════════════════════════════════
//  INSTANTLY
// ════════════════════════════════════════════════════════════
function instantlyUrl(path) {
  return joinUrl(INSTANTLY_BASE, path);
}

async function pushToInstantly(leads) {
  if (!leads.length) return;
  if (!isConfigured(CONFIG.INSTANTLY_KEY) || !isConfigured(CONFIG.INSTANTLY_CAMP)) {
    log('Instantly push skipped: missing INSTANTLY_API_KEY or INSTANTLY_CAMPAIGN_ID', 'warn');
    return;
  }

  log(`📤 Pushing ${leads.length} leads to Instantly…`);

  try {
    const body = {
      api_key: CONFIG.INSTANTLY_KEY,
      campaign_id: CONFIG.INSTANTLY_CAMP,
      skip_if_in_workspace: true,
      leads: leads.map((l) => ({
        email: l.email,
        first_name: l.firstName,
        last_name: l.lastName,
        company_name: l.company,
        personalization:
          l.websiteIntel || `Hi ${l.firstName}, noticed you run ${l.company}.`,
        custom_variables: {
          title: l.title,
          location: l.location,
          website: l.website,
        },
      })),
    };

    const r = await fetch(instantlyUrl('lead/add'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await r.text();
    if (r.ok) {
      state.stats.pushed += leads.length;
      log(`✅ ${leads.length} leads pushed to Instantly`);
    } else {
      log(`Instantly push error: ${r.status} — ${text}`, 'error');
    }
  } catch (e) {
    log(`Instantly push failed: ${e.message}`, 'error');
  }
}

async function fetchInstantlyReplies() {
  if (!isConfigured(CONFIG.INSTANTLY_KEY) || !isConfigured(CONFIG.INSTANTLY_CAMP)) {
    log('Instantly reply worker skipped: missing INSTANTLY_API_KEY or INSTANTLY_CAMPAIGN_ID', 'warn');
    return [];
  }

  log('📬 Checking Instantly for new replies…');

  try {
    const url = `${instantlyUrl('reply/list')}?api_key=${encodeURIComponent(
      CONFIG.INSTANTLY_KEY
    )}&campaign_id=${encodeURIComponent(CONFIG.INSTANTLY_CAMP)}&limit=20`;

    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      log(`Instantly reply fetch error: ${r.status} — ${text}`, 'error');
      return [];
    }

    const text = await r.text();
    let d;
    try {
      d = JSON.parse(text);
    } catch {
      d = { raw: text };
    }

    return d.replies || d.data || d.results || [];
  } catch (e) {
    log(`Reply fetch error: ${e.message}`, 'error');
    return [];
  }
}

async function sendInstantlyReply(toEmail, body) {
  if (!isConfigured(CONFIG.INSTANTLY_KEY) || !isConfigured(CONFIG.INSTANTLY_CAMP)) {
    return false;
  }

  try {
    const r = await fetch(instantlyUrl('reply/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: CONFIG.INSTANTLY_KEY,
        reply_to_email: toEmail,
        email_body: body,
        campaign_id: CONFIG.INSTANTLY_CAMP,
      }),
    });

    return r.ok;
  } catch {
    return false;
  }
}

async function pauseLeadInInstantly(email) {
  if (!isConfigured(CONFIG.INSTANTLY_KEY) || !isConfigured(CONFIG.INSTANTLY_CAMP)) return;

  try {
    await fetch(instantlyUrl('lead/pause'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: CONFIG.INSTANTLY_KEY,
        campaign_id: CONFIG.INSTANTLY_CAMP,
        email,
      }),
    });
  } catch {
    // silent
  }
}

async function testInstantlyConnection() {
  if (!isConfigured(CONFIG.INSTANTLY_KEY)) {
    return { ok: false, status: 400, data: { error: 'Missing INSTANTLY_API_KEY' } };
  }

  try {
    const url = `${instantlyUrl('reply/list')}?api_key=${encodeURIComponent(
      CONFIG.INSTANTLY_KEY
    )}&campaign_id=${encodeURIComponent(CONFIG.INSTANTLY_CAMP || '')}&limit=1`;

    const r = await fetch(url);
    const text = await r.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    return { ok: r.ok, status: r.status, data, url };
  } catch (e) {
    return { ok: false, status: 500, data: { error: e.message } };
  }
}

// ════════════════════════════════════════════════════════════
//  CLAUDE
// ════════════════════════════════════════════════════════════
async function classifyReply(replyText) {
  if (!CONFIG.CLAUDE_KEY) {
    const t = String(replyText || '').toLowerCase();

    if (/unsubscribe|remove me|stop emailing|opt.?out/.test(t)) {
      return { classification: 'Spam/Unsubscribe', confidence: 0.99, reasoning: 'Opt-out language detected' };
    }
    if (/not interested|no thanks|not for us/.test(t)) {
      return { classification: 'Not Interested', confidence: 0.85, reasoning: 'Rejection language' };
    }
    if (/out of office|on vacation|away until/.test(t)) {
      return { classification: 'Out of Office', confidence: 0.95, reasoning: 'OOO pattern detected' };
    }
    if (/wrong person|not my department|don\'t handle/.test(t)) {
      return { classification: 'Wrong Person', confidence: 0.9, reasoning: 'Wrong contact' };
    }
    if (/not now|maybe later|next quarter|too busy/.test(t)) {
      return { classification: 'Not Now', confidence: 0.8, reasoning: 'Timing objection' };
    }
    if (/tell me more|how does|what does|interested|open to|sure|sounds good|yes/.test(t)) {
      return { classification: 'Interested', confidence: 0.85, reasoning: 'Positive signal' };
    }

    return { classification: 'Not Interested', confidence: 0.5, reasoning: 'No clear signal' };
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: `Classify this cold email reply. Use semantic understanding, not just keywords.

REPLY: "${replyText}"

Categories: Interested | Not Now | Not Interested | Wrong Person | Out of Office | Spam/Unsubscribe

Interested examples: "tell me more", "how does this work?", "sure", "open to chatting", "what's the cost?"

Respond ONLY with valid JSON:
{"classification":"...","confidence":0.00,"reasoning":"one sentence"}`,
          },
        ],
      }),
    });

    const d = await r.json();
    const text = (d.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return { classification: 'Not Interested', confidence: 0.5, reasoning: 'Classification failed' };
  }
}

function buildResponse(classification) {
  const name = CONFIG.SENDER_NAME;
  const cal = CONFIG.CALENDAR_LINK;

  const templates = {
    Interested: `Awesome — happy to show you.\n\nGrab a quick time here:\n${cal}\n\n– ${name}`,
    'Not Now': `No worries at all. What month would be better to circle back?\n\n– ${name}`,
    'Not Interested': `All good — appreciate you letting me know. If anything changes, feel free to reach out.\n\n– ${name}`,
    'Wrong Person': `Got it — who would be the right person to reach out to about this?\n\n– ${name}`,
    'Out of Office': `Thanks — I'll follow up when you're back.\n\n– ${name}`,
  };

  return templates[classification] || null;
}

// ════════════════════════════════════════════════════════════
//  MAIN WORKERS
// ════════════════════════════════════════════════════════════
async function runLeadWorker() {
  log('═══ Lead Worker starting ═══');

  const leads = await fetchGobiiLeads();
  state.lastGobiiPoll = new Date().toISOString();

  if (!leads.length) return;

  const existingEmails = new Set(state.leads.map((l) => l.email));
  const newLeads = leads.filter((l) => l.email && !existingEmails.has(l.email));

  state.stats.leadsFound += leads.length;
  state.stats.imported += newLeads.length;
  state.leads.push(...newLeads);

  log(`✅ ${newLeads.length} new leads imported (${leads.length - newLeads.length} dupes skipped)`);

  if (newLeads.length > 0) {
    await pushToInstantly(newLeads);
  }
}

async function runReplyWorker() {
  log('═══ Reply Worker starting ═══');

  const replies = await fetchInstantlyReplies();
  state.lastReplyPoll = new Date().toISOString();

  for (const reply of replies) {
    const replyId = reply.id || reply.reply_id || `${reply.email || reply.from_email}-${reply.timestamp || reply.created_at || Date.now()}`;
    const fromEmail = (reply.from_email || reply.email || '').toLowerCase();
    const fromName = reply.from_name || reply.name || fromEmail.split('@')[0] || 'unknown';
    const bodyText = reply.body || reply.text || reply.reply_text || '';

    if (!replyId || !fromEmail) continue;
    if (state.seenReplyIds.includes(replyId)) continue;
    if (state.blockedEmails.includes(fromEmail)) continue;

    state.seenReplyIds.push(replyId);
    state.stats.repliesRead++;

    const result = await classifyReply(bodyText);
    const { classification, confidence, reasoning } = result;

    let action = 'logged';
    let autoSent = false;

    log(`📩 ${fromName} → ${classification} (${Math.round(confidence * 100)}%)`);

    if (classification === 'Spam/Unsubscribe') {
      state.blockedEmails.push(fromEmail);
      await pauseLeadInInstantly(fromEmail);
      state.stats.unsub++;
      action = 'blocked_permanently';
    } else if (classification === 'Interested' && confidence >= 0.8 && state.autoReplyEnabled) {
      const response = buildResponse('Interested');
      autoSent = await sendInstantlyReply(fromEmail, response);
      state.stats.interested++;
      if (autoSent) state.stats.autoSent++;
      action = autoSent ? 'booking_link_sent' : 'booking_link_failed';
      log(`🎉 Booking link sent to ${fromName}`, autoSent ? 'success' : 'warn');
    } else if (classification === 'Interested' && confidence < 0.8) {
      state.stats.interested++;
      action = 'flagged_for_review';
    } else if (
      ['Not Now', 'Not Interested', 'Wrong Person', 'Out of Office'].includes(classification) &&
      state.autoReplyEnabled
    ) {
      const response = buildResponse(classification);
      if (response) {
        autoSent = await sendInstantlyReply(fromEmail, response);
        if (autoSent) state.stats.autoSent++;

        if (['Not Now', 'Not Interested', 'Out of Office'].includes(classification)) {
          await pauseLeadInInstantly(fromEmail);
        }

        action = 'replied_and_' + classification.toLowerCase().replace(/ /g, '_');
      }
    }

    state.log.unshift({
      time: new Date().toISOString(),
      from: fromName,
      fromEmail,
      body: bodyText.slice(0, 160),
      classification,
      confidence,
      reasoning,
      action,
      autoSent,
    });
  }

  if (state.seenReplyIds.length > 1000) {
    state.seenReplyIds = state.seenReplyIds.slice(-1000);
  }
}

// ════════════════════════════════════════════════════════════
//  TIMERS
// ════════════════════════════════════════════════════════════
async function startWorkers() {
  log('🚀 OutreachAI server started');

  const runLeads = async () => {
    try {
      await runLeadWorker();
    } catch (e) {
      log('Lead worker error: ' + e.message, 'error');
    }
    setTimeout(runLeads, CONFIG.LEAD_POLL_INTERVAL_MS);
  };

  const runReplies = async () => {
    try {
      await runReplyWorker();
    } catch (e) {
      log('Reply worker error: ' + e.message, 'error');
    }
    setTimeout(runReplies, CONFIG.POLL_INTERVAL_MS);
  };

  setTimeout(runLeads, 5000);
  setTimeout(runReplies, 8000);
}

// ════════════════════════════════════════════════════════════
//  API ROUTES
// ════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    gobiiBase: GOBII_BASE,
    instantlyBase: INSTANTLY_BASE,
    stats: state.stats,
    lastGobiiPoll: state.lastGobiiPoll,
    lastReplyPoll: state.lastReplyPoll,
  });
});

app.get('/api/state', (req, res) => {
  res.json({
    leads: state.leads.slice(0, 200),
    stats: state.stats,
    log: state.log.slice(0, 100),
    blockedEmails: state.blockedEmails,
    lastGobiiPoll: state.lastGobiiPoll,
    lastReplyPoll: state.lastReplyPoll,
    autoReplyEnabled: state.autoReplyEnabled,
  });
});

app.get('/api/gobii/test', async (req, res) => {
  log('Testing Gobii connection…');

  try {
    const result = await testGobiiConnection();

    if (result.ok) {
      log(`✅ Gobii connected — ${JSON.stringify(result.data).slice(0, 120)}`);
      return res.json({
        ok: true,
        status: result.status,
        data: result.data,
        agentId: CONFIG.GOBII_AGENT_ID,
        baseUrl: result.url,
      });
    }

    log(`Gobii test failed: ${result.status} — ${JSON.stringify(result.data)}`, 'error');
    return res.status(result.status).json({
      ok: false,
      status: result.status,
      data: result.data,
      agentId: CONFIG.GOBII_AGENT_ID,
      baseUrl: result.url,
    });
  } catch (e) {
    log(`Gobii test error: ${e.message}`, 'error');
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/instantly/test', async (req, res) => {
  const result = await testInstantlyConnection();
  res.status(result.ok ? 200 : result.status).json(result);
});

app.post('/api/gobii/fetch-now', async (req, res) => {
  const leads = await fetchGobiiLeads();
  state.lastGobiiPoll = new Date().toISOString();
  state.stats.leadsFound += leads.length;
  return res.json({ ok: true, count: leads.length, leads });
});

app.post('/api/instantly/push-now', async (req, res) => {
  const leads = req.body?.leads || [];
  if (!Array.isArray(leads) || !leads.length) {
    return res.json({ ok: false, message: 'No leads' });
  }

  await pushToInstantly(leads);
  state.leads.push(...leads);
  state.stats.imported += leads.length;
  return res.json({ ok: true, pushed: leads.length });
});

app.post('/api/replies/check-now', async (req, res) => {
  await runReplyWorker();
  return res.json({ ok: true, stats: state.stats, lastReplyPoll: state.lastReplyPoll });
});

app.post('/api/auto-reply/toggle', (req, res) => {
  state.autoReplyEnabled = !!req.body?.enabled;
  return res.json({ ok: true, enabled: state.autoReplyEnabled });
});

app.post('/api/unblock', (req, res) => {
  const { email } = req.body || {};
  state.blockedEmails = state.blockedEmails.filter((e) => e !== email);
  return res.json({ ok: true });
});

app.post('/api/log/clear', (req, res) => {
  state.log = [];
  return res.json({ ok: true });
});

app.get('/api/proxy/gobii/*', async (req, res) => {
  try {
    const path = req.params[0];
    const r = await fetch(joinUrl(GOBII_BASE, path), {
      headers: gobiiHeaders(),
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.all('/api/proxy/instantly/*', async (req, res) => {
  try {
    const path = req.params[0];
    const r = await fetch(joinUrl(INSTANTLY_BASE, path), {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/gobii/discover', async (req, res) => {
  const candidates = [
    'https://gobii.ai/api/v1',
    'https://gobii.ai/api',
    'https://gobii.ai/v1',
    'https://app.gobii.ai/api/v1',
    'https://app.gobii.ai/api',
  ];

  const results = [];
  for (const base of candidates) {
    try {
      const r = await fetch(joinUrl(base, 'persistent-agents/'), {
        headers: gobiiHeaders(),
      });
      results.push({ base, status: r.status, ok: r.ok });
      if (r.ok) {
        results[results.length - 1].winner = true;
        break;
      }
    } catch (e) {
      results.push({ base, error: e.message });
    }
  }

  const winner = results.find((r) => r.ok);
  return res.json({ winner: winner?.base || null, results });
});

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  log(`OutreachAI server running on port ${PORT}`);
  startWorkers();
});
