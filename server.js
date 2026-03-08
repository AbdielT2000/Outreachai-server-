// ═══════════════════════════════════════════════════════════
//  OutreachAI Backend Server
//  Runs 24/7 on Render.com (free tier)
//  Apollo → AI personalization → Instantly
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const app     = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Config
const CONFIG = {
  APOLLO_KEY:       process.env.APOLLO_API_KEY   || '',
  INSTANTLY_KEY:    process.env.INSTANTLY_KEY    || 'f12hxp884wmd6akz07fecdfg7jc1',
  INSTANTLY_CAMP:   process.env.INSTANTLY_CAMP   || '17b493f6-83fc-4acc-944c-96c8878a581b',
  CLAUDE_KEY:       process.env.CLAUDE_KEY       || '',
  CALENDAR_LINK:    process.env.CALENDAR_LINK    || 'calendly.com/yourlink',
  SENDER_NAME:      process.env.SENDER_NAME      || 'Abdiel',
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '120000'),
  // Apollo search filters — tweak via env vars or leave as defaults
  APOLLO_TITLES:    (process.env.APOLLO_TITLES   || 'CEO,Founder,Owner,Co-Founder,Managing Director').split(','),
  APOLLO_INDUSTRY:  process.env.APOLLO_INDUSTRY  || 'Marketing & Advertising',
  APOLLO_MIN_EMP:   parseInt(process.env.APOLLO_MIN_EMP || '1'),
  APOLLO_MAX_EMP:   parseInt(process.env.APOLLO_MAX_EMP || '50'),
};

const APOLLO_BASE   = 'https://api.apollo.io/v1';
const INSTANTLY_BASE = 'https://api.instantly.ai/api/v1';

// ── In-memory state
let state = {
  leads:         [],
  seenReplyIds:  [],
  blockedEmails: [],
  log:           [],
  stats:         { leadsFound: 0, imported: 0, pushed: 0, repliesRead: 0, interested: 0, autoSent: 0, unsub: 0, personalized: 0 },
  lastApolloPool: null,
  lastReplyPoll:  null,
  autoReplyEnabled: true,
};

// ── Logging
function log(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 500) state.log = state.log.slice(0, 500);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════════
//  APOLLO — Search for leads
// ════════════════════════════════════════════════════════════
async function fetchApolloLeads(page = 1) {
  if (!CONFIG.APOLLO_KEY) {
    log('No APOLLO_API_KEY set — skipping', 'warn');
    return [];
  }
  log(`🔍 Searching Apollo (page ${page})…`);
  try {
    const body = {
      api_key:              CONFIG.APOLLO_KEY,
      page,
      per_page:             25,
      person_titles:        CONFIG.APOLLO_TITLES,
      organization_industry_tag_ids: [],  // populated below if needed
      organization_num_employees_ranges: [`${CONFIG.APOLLO_MIN_EMP},${CONFIG.APOLLO_MAX_EMP}`],
      contact_email_status: ['verified', 'guessed'],
      prospected_by_current_team: ['no'],  // only new leads
    };

    // Add industry keyword search
    if (CONFIG.APOLLO_INDUSTRY) {
      body.q_organization_keyword_tags = [CONFIG.APOLLO_INDUSTRY];
    }

    const r = await fetch(`${APOLLO_BASE}/mixed_people/search`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body:    JSON.stringify(body),
    });

    if (!r.ok) {
      const err = await r.text();
      log(`Apollo search error ${r.status}: ${err}`, 'error');
      return [];
    }

    const data = await r.json();
    const people = data.people || [];
    log(`✅ Apollo returned ${people.length} people`);

    return people.map(p => ({
      firstName: p.first_name || '',
      lastName:  p.last_name  || '',
      email:     (p.email || '').toLowerCase().trim(),
      company:   p.organization?.name || p.employment_history?.[0]?.organization_name || '',
      title:     p.title || '',
      location:  [p.city, p.state, p.country].filter(Boolean).join(', '),
      website:   p.organization?.website_url || p.organization?.primary_domain ? `https://${p.organization.primary_domain}` : '',
      linkedin:  p.linkedin_url || '',
      apolloId:  p.id,
      tags:      ['apollo'],
      status:    'new',
      addedAt:   new Date().toISOString(),
    })).filter(l => l.email && l.firstName);

  } catch (e) {
    log(`Apollo fetch error: ${e.message}`, 'error');
    return [];
  }
}

// ════════════════════════════════════════════════════════════
//  CLAUDE — Personalize email first line from website
// ════════════════════════════════════════════════════════════
async function personalizeForLead(lead) {
  if (!CONFIG.CLAUDE_KEY || !lead.website) return null;
  try {
    // First fetch the website via search to get intel
    const searchResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':          CONFIG.CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 200,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role:    'user',
          content: `Visit ${lead.website} and write ONE short personalized compliment (max 12 words) about ${lead.company} that could open a cold email. Focus on something specific: their niche, a client result, their positioning, or a unique service. Return ONLY the compliment, no punctuation at the end, no quotes.`,
        }],
      }),
    });

    const data = await searchResp.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (text && text.length > 5 && text.length < 120) {
      state.stats.personalized++;
      log(`✏️ Personalized for ${lead.firstName} @ ${lead.company}: "${text}"`);
      return text;
    }
    return null;
  } catch (e) {
    log(`Personalization error for ${lead.company}: ${e.message}`, 'warn');
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  INSTANTLY — Push leads + fetch/send replies
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
        email:            l.email,
        first_name:       l.firstName,
        last_name:        l.lastName,
        company_name:     l.company,
        personalization:  l.personalization || `Hi ${l.firstName}, noticed you run ${l.company}.`,
        custom_variables: { title: l.title, location: l.location, website: l.website },
      })),
    };
    const r = await fetch(`${INSTANTLY_BASE}/lead/add`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
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
  log('📬 Checking Instantly for replies…');
  try {
    const r = await fetch(
      `${INSTANTLY_BASE}/reply/list?api_key=${CONFIG.INSTANTLY_KEY}&campaign_id=${CONFIG.INSTANTLY_CAMP}&limit=20`
    );
    if (!r.ok) { log(`Instantly reply error: ${r.status}`, 'error'); return []; }
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
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        api_key:        CONFIG.INSTANTLY_KEY,
        reply_to_email: toEmail,
        email_body:     body,
        campaign_id:    CONFIG.INSTANTLY_CAMP,
      }),
    });
    return r.ok;
  } catch (e) { return false; }
}

async function pauseLeadInInstantly(email) {
  try {
    await fetch(`${INSTANTLY_BASE}/lead/pause`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ api_key: CONFIG.INSTANTLY_KEY, campaign_id: CONFIG.INSTANTLY_CAMP, email }),
    });
  } catch (e) { /* silent */ }
}

// ════════════════════════════════════════════════════════════
//  CLAUDE — Classify reply intent
// ════════════════════════════════════════════════════════════
async function classifyReply(replyText) {
  if (!CONFIG.CLAUDE_KEY) {
    const t = replyText.toLowerCase();
    if (/unsubscribe|remove me|stop emailing|opt.?out/.test(t))  return { classification: 'Spam/Unsubscribe', confidence: 0.99 };
    if (/not interested|no thanks|not for us/.test(t))           return { classification: 'Not Interested',   confidence: 0.85 };
    if (/out of office|on vacation|away until/.test(t))          return { classification: 'Out of Office',    confidence: 0.95 };
    if (/wrong person|not my department/.test(t))                return { classification: 'Wrong Person',     confidence: 0.90 };
    if (/not now|maybe later|next quarter/.test(t))              return { classification: 'Not Now',          confidence: 0.80 };
    if (/tell me more|how does|interested|open to|sure|yes/.test(t)) return { classification: 'Interested',  confidence: 0.85 };
    return { classification: 'Not Interested', confidence: 0.50 };
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body:    JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{
          role:    'user',
          content: `Classify this cold email reply semantically.\n\nREPLY: "${replyText}"\n\nCategories: Interested | Not Now | Not Interested | Wrong Person | Out of Office | Spam/Unsubscribe\n\nRespond ONLY with valid JSON: {"classification":"...","confidence":0.00,"reasoning":"one sentence"}`,
        }],
      }),
    });
    const d    = await r.json();
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    return { classification: 'Not Interested', confidence: 0.5, reasoning: 'Classification failed' };
  }
}

function buildAutoResponse(classification) {
  const name = CONFIG.SENDER_NAME;
  const cal  = CONFIG.CALENDAR_LINK;
  const templates = {
    'Interested':     `Awesome — happy to show you what we do.\n\nGrab a quick time here:\n${cal}\n\n– ${name}`,
    'Not Now':        `No worries at all. What month would be better to circle back?\n\n– ${name}`,
    'Not Interested': `All good — appreciate you letting me know.\n\n– ${name}`,
    'Wrong Person':   `Got it — who would be the right person to reach out to?\n\n– ${name}`,
    'Out of Office':  `Thanks — I'll follow up when you're back.\n\n– ${name}`,
  };
  return templates[classification] || null;
}

// ════════════════════════════════════════════════════════════
//  MAIN WORKERS
// ════════════════════════════════════════════════════════════
async function runLeadWorker() {
  log('═══ Apollo Lead Worker starting ═══');
  const leads = await fetchApolloLeads();
  if (!leads.length) { state.lastApolloPool = new Date().toISOString(); return; }

  // Deduplicate against existing
  const existingEmails = new Set([
    ...state.leads.map(l => l.email),
    ...state.blockedEmails,
  ]);
  const newLeads = leads.filter(l => l.email && !existingEmails.has(l.email));
  log(`${newLeads.length} new leads after dedup (${leads.length - newLeads.length} dupes)`);

  state.stats.leadsFound += leads.length;
  state.stats.imported   += newLeads.length;
  state.lastApolloPool    = new Date().toISOString();

  if (!newLeads.length) return;

  // Personalize each lead (with rate limiting — 1 per 3s to avoid API overload)
  log(`✏️ Personalizing ${newLeads.length} leads…`);
  for (const lead of newLeads) {
    if (lead.website) {
      lead.personalization = await personalizeForLead(lead) || `Hi ${lead.firstName}, noticed you run ${lead.company}.`;
    } else {
      lead.personalization = `Hi ${lead.firstName}, noticed you run ${lead.company}.`;
    }
    await sleep(3000);
  }

  state.leads.push(...newLeads);
  await pushToInstantly(newLeads);
  log(`✅ Lead worker done — ${newLeads.length} leads pushed with personalization`);
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

    const { classification, confidence, reasoning } = await classifyReply(bodyText);
    log(`📩 ${fromName} → ${classification} (${Math.round((confidence||0)*100)}%)`);

    let action = 'logged';

    if (classification === 'Spam/Unsubscribe') {
      state.blockedEmails.push(fromEmail);
      await pauseLeadInInstantly(fromEmail);
      state.stats.unsub++;
      action = 'unsubscribed';

    } else if (classification === 'Interested' && (confidence||0) >= 0.80 && state.autoReplyEnabled) {
      const sent = await sendInstantlyReply(fromEmail, buildAutoResponse('Interested'));
      state.stats.interested++;
      state.stats.autoSent++;
      action = sent ? 'booking_link_sent' : 'booking_link_failed';
      if (sent) log(`🎉 Booking link sent to ${fromName}!`, 'success');

    } else if (classification === 'Interested') {
      state.stats.interested++;
      action = 'flagged_review';

    } else if (state.autoReplyEnabled) {
      const response = buildAutoResponse(classification);
      if (response) {
        await sendInstantlyReply(fromEmail, response);
        if (['Not Now', 'Not Interested', 'Out of Office'].includes(classification)) {
          await pauseLeadInInstantly(fromEmail);
        }
        state.stats.autoSent++;
        action = 'replied_' + classification.toLowerCase().replace(/ /g, '_');
      }
    }

    state.log.unshift({
      time: new Date().toISOString(),
      from: fromName, fromEmail,
      body: bodyText.slice(0, 160),
      classification, confidence, reasoning, action,
    });
  }

  if (state.seenReplyIds.length > 1000) state.seenReplyIds = state.seenReplyIds.slice(-1000);
}

// ════════════════════════════════════════════════════════════
//  TIMERS
// ════════════════════════════════════════════════════════════
async function startWorkers() {
  log('🚀 OutreachAI server started — Apollo + Instantly + Claude');

  const runLeads = async () => {
    try { await runLeadWorker(); } catch (e) { log('Lead worker error: ' + e.message, 'error'); }
    setTimeout(runLeads, 30 * 60 * 1000); // every 30 min
  };

  const runReplies = async () => {
    try { await runReplyWorker(); } catch (e) { log('Reply worker error: ' + e.message, 'error'); }
    setTimeout(runReplies, CONFIG.POLL_INTERVAL_MS); // every 2 min
  };

  setTimeout(runLeads,   5000);
  setTimeout(runReplies, 8000);
}

// ════════════════════════════════════════════════════════════
//  API ROUTES
// ════════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    stats:  state.stats,
    lastApolloPool: state.lastApolloPool,
    lastReplyPoll:  state.lastReplyPoll,
    apolloConfigured: !!CONFIG.APOLLO_KEY,
    claudeConfigured: !!CONFIG.CLAUDE_KEY,
  });
});

// Full state for browser app
app.get('/api/state', (req, res) => {
  res.json({
    leads:            state.leads.slice(0, 200),
    stats:            state.stats,
    log:              state.log.slice(0, 100),
    blockedEmails:    state.blockedEmails,
    lastApolloPool:   state.lastApolloPool,
    lastReplyPoll:    state.lastReplyPoll,
    autoReplyEnabled: state.autoReplyEnabled,
  });
});

// Test Apollo connection
app.get('/api/apollo/test', async (req, res) => {
  if (!CONFIG.APOLLO_KEY) return res.status(400).json({ ok: false, error: 'APOLLO_API_KEY not set in environment' });
  try {
    const r = await fetch(`${APOLLO_BASE}/auth/health`, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      method: 'POST',
      body: JSON.stringify({ api_key: CONFIG.APOLLO_KEY }),
    });
    const d = await r.json();
    if (r.ok && (d.is_logged_in || d.user)) {
      log('✅ Apollo connection verified');
      res.json({ ok: true, user: d.user || d, message: 'Apollo connected successfully' });
    } else {
      // Try a minimal search as fallback test
      const sr = await fetch(`${APOLLO_BASE}/mixed_people/search`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ api_key: CONFIG.APOLLO_KEY, per_page: 1, page: 1 }),
      });
      const sd = await sr.json();
      if (sr.ok) {
        res.json({ ok: true, message: 'Apollo connected', credits: sd.pagination });
      } else {
        res.status(sr.status).json({ ok: false, error: sd.message || JSON.stringify(sd) });
      }
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Trigger Apollo lead fetch now
app.post('/api/leads/fetch', async (req, res) => {
  res.json({ ok: true, message: 'Apollo lead worker started' });
  runLeadWorker().catch(e => log(e.message, 'error'));
});

// Trigger reply check now
app.post('/api/replies/check', async (req, res) => {
  res.json({ ok: true, message: 'Reply worker started' });
  runReplyWorker().catch(e => log(e.message, 'error'));
});

// Toggle auto-reply
app.post('/api/autoreply/toggle', (req, res) => {
  state.autoReplyEnabled = !state.autoReplyEnabled;
  log(`Auto-reply ${state.autoReplyEnabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ autoReplyEnabled: state.autoReplyEnabled });
});

// Add leads manually from browser
app.post('/api/leads/add', async (req, res) => {
  const leads = req.body.leads || [];
  if (!leads.length) return res.json({ ok: false, message: 'No leads' });
  await pushToInstantly(leads);
  state.leads.push(...leads);
  state.stats.imported += leads.length;
  res.json({ ok: true, pushed: leads.length });
});

// Proxy: Instantly API (solves CORS for browser)
app.all('/api/proxy/instantly/*', async (req, res) => {
  try {
    const path = req.params[0];
    const r = await fetch(`${INSTANTLY_BASE}/${path}`, {
      method:  req.method,
      headers: { 'Content-Type': 'application/json' },
      body:    req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Unblock email
app.post('/api/unblock', (req, res) => {
  const { email } = req.body;
  state.blockedEmails = state.blockedEmails.filter(e => e !== email);
  res.json({ ok: true });
});

// View logs
app.get('/api/logs', (req, res) => {
  res.json({ logs: state.log.slice(0, 200) });
});

// Clear logs
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
