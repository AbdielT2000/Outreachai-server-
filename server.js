// ═══════════════════════════════════════════════════════════
//  OutreachAI Backend Server
//  Apollo → AI Personalization → Instantly
//  Runs 24/7 on Render.com
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const app     = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Config
const CONFIG = {
  APOLLO_KEY:       process.env.APOLLO_API_KEY    || '',
  INSTANTLY_KEY:    process.env.INSTANTLY_KEY     || 'f12hxp884wmd6akz07fecdfg7jc1',
  INSTANTLY_KEY_V2: process.env.INSTANTLY_KEY_V2 || '',
  INSTANTLY_CAMP:   process.env.INSTANTLY_CAMP    || '17b493f6-83fc-4acc-944c-96c8878a581b',
  CLAUDE_KEY:       process.env.CLAUDE_KEY        || '',
  CALENDAR_LINK:    process.env.CALENDAR_LINK     || 'calendly.com/yourlink',
  SENDER_NAME:      process.env.SENDER_NAME       || 'Abdiel',
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '120000'),
};

const APOLLO_BASE  = 'https://api.apollo.io/api/v1';
const INSTANTLY_V1 = 'https://api.instantly.ai/api/v1';
const INSTANTLY_V2 = 'https://api.instantly.ai/api/v2';

// ── In-memory state
let state = {
  leads:            [],
  seenReplyIds:     [],
  blockedEmails:    [],
  log:              [],
  stats:            { leadsFound: 0, enriched: 0, pushed: 0, repliesRead: 0, interested: 0, autoSent: 0, unsub: 0, personalized: 0 },
  lastApolloRun:    null,
  lastReplyPoll:    null,
  autoReplyEnabled: true,
  leadWorkerRunning: false,
};

function log(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 500) state.log = state.log.slice(0, 500);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════════
//  APOLLO — Search (no credits)
// ════════════════════════════════════════════════════════════
async function apolloSearch(page = 1) {
  log(`🔍 Apollo search page ${page}…`);
  const body = {
    page,
    per_page: 100,
    person_titles: ['founder', 'owner', 'ceo', 'co-founder', 'managing director'],
    organization_num_employees_ranges: ['1,50'],
    q_organization_keyword_tags: ['marketing', 'advertising'],
    person_locations: ['United States'],
    contact_email_status: ['verified'],
  };
  const r = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': CONFIG.APOLLO_KEY },
    body:    JSON.stringify(body),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Apollo search ${r.status}: ${err}`);
  }
  const data = await r.json();
  const people = data.people || data.contacts || [];
  log(`✅ Apollo returned ${people.length} people`);
  return people;
}

// ════════════════════════════════════════════════════════════
//  APOLLO — Enrich (1 credit per person)
// ════════════════════════════════════════════════════════════
async function enrichPerson(person) {
  const body = {
    first_name:             person.first_name || '',
    last_name:              person.last_name  || '',
    organization_name:      person.organization?.name || '',
    domain:                 person.organization?.primary_domain || '',
    linkedin_url:           person.linkedin_url || '',
    reveal_personal_emails: false,
  };
  const r = await fetch(`${APOLLO_BASE}/people/match`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': CONFIG.APOLLO_KEY },
    body:    JSON.stringify(body),
  });
  if (!r.ok) {
    log(`Enrich failed ${r.status} for ${person.first_name} ${person.last_name}`, 'warn');
    return null;
  }
  const data  = await r.json();
  const p     = data.person || data;
  const email = (p.email || '').toLowerCase().trim();
  if (!email || email.includes('email_not_unlocked') || !email.includes('@')) return null;
  const domain = person.organization?.primary_domain || '';
  return {
    first_name: person.first_name || '',
    last_name:  person.last_name  || '',
    email,
    company:    person.organization?.name || '',
    website:    person.organization?.website_url || (domain ? `https://${domain}` : ''),
    title:      person.title || '',
  };
}

// ════════════════════════════════════════════════════════════
//  CLAUDE — AI personalization
// ════════════════════════════════════════════════════════════
async function personalizeForLead(lead) {
  if (!CONFIG.CLAUDE_KEY || !lead.website) {
    return `Hi ${lead.first_name}, noticed you run ${lead.company}.`;
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 150,
        tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{
          role:    'user',
          content: `Visit ${lead.website} and write ONE short compliment (max 12 words) about ${lead.company} to open a cold email. Be specific — mention their niche, a result, their positioning, or a unique service. Return ONLY the compliment, no punctuation at end, no quotes.`,
        }],
      }),
    });
    const d    = await r.json();
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (text && text.length > 5 && text.length < 120) {
      state.stats.personalized++;
      log(`✏️ ${lead.first_name} @ ${lead.company}: "${text}"`);
      return text;
    }
  } catch (e) {
    log(`Personalization error for ${lead.company}: ${e.message}`, 'warn');
  }
  return `Hi ${lead.first_name}, noticed you run ${lead.company}.`;
}

// ════════════════════════════════════════════════════════════
//  INSTANTLY — Push leads (V1)
// ════════════════════════════════════════════════════════════
async function pushToInstantly(leads) {
  if (!leads.length) return;
  const url = `${INSTANTLY_V1}/lead/add`;
  log(`[Instantly V1] POST ${url} — ${leads.length} leads`);
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key:              CONFIG.INSTANTLY_KEY,
      campaign_id:          CONFIG.INSTANTLY_CAMP,
      skip_if_in_workspace: true,
      leads: leads.map(l => ({
        email:            l.email,
        first_name:       l.first_name,
        last_name:        l.last_name,
        company_name:     l.company,
        personalization:  l.personalization,
        custom_variables: { title: l.title, website: l.website },
      })),
    }),
  });
  const d = await r.json();
  if (r.ok) {
    state.stats.pushed += leads.length;
    log(`[Instantly V1] ✅ ${leads.length} leads pushed — status ${r.status}`);
  } else {
    log(`[Instantly V1] ❌ error ${r.status}: ${JSON.stringify(d)}`, 'error');
  }
}

// ════════════════════════════════════════════════════════════
//  INSTANTLY — Fetch replies (V2)
// ════════════════════════════════════════════════════════════
async function fetchInstantlyReplies() {
  const key = CONFIG.INSTANTLY_KEY_V2;
  if (!key) {
    log('[Instantly V2] INSTANTLY_KEY_V2 not set — reply worker skipped', 'warn');
    return [];
  }
  const url = `${INSTANTLY_V2}/emails?campaign_id=${CONFIG.INSTANTLY_CAMP}&limit=25`;
  log(`[Instantly V2] GET ${url}`);
  try {
    const r        = await fetch(url, { headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' } });
    const bodyText = await r.text();
    log(`[Instantly V2] /emails → ${r.status} | ${bodyText.slice(0, 300)}`);
    if (!r.ok) { log(`[Instantly V2] ❌ ${r.status}: ${bodyText}`, 'error'); return []; }
    const d      = JSON.parse(bodyText);
    const emails = d.items || d.data || (Array.isArray(d) ? d : []);
    const replies = emails.filter(e => e.ue_type === 3);
    log(`[Instantly V2] ${emails.length} emails, ${replies.length} inbound replies`);
    return replies.map(e => ({
      id:         e.id,
      email_id:   e.id,
      from_email: e.from_address_email || '',
      from_name:  (e.from_address_email || '').split('@')[0],
      body:       e.body?.text || e.body?.html || '',
      eaccount:   e.eaccount || '',
    }));
  } catch (e) {
    log(`[Instantly V2] ❌ exception: ${e.message}`, 'error');
    return [];
  }
}

// ════════════════════════════════════════════════════════════
//  INSTANTLY — Send reply (V2)
// ════════════════════════════════════════════════════════════
async function sendInstantlyReply(replyToUuid, eaccount, bodyText) {
  const key = CONFIG.INSTANTLY_KEY_V2;
  if (!key) { log('[Instantly V2] Cannot send reply — key not set', 'warn'); return false; }
  const url = `${INSTANTLY_V2}/emails/reply`;
  log(`[Instantly V2] POST ${url} → ${replyToUuid}`);
  try {
    const r = await fetch(url, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ eaccount, reply_to_uuid: replyToUuid, body: { text: bodyText } }),
    });
    const respText = await r.text();
    log(`[Instantly V2] /emails/reply → ${r.status} | ${respText.slice(0, 150)}`);
    return r.ok;
  } catch (e) {
    log(`[Instantly V2] ❌ send exception: ${e.message}`, 'error');
    return false;
  }
}

async function pauseLeadInInstantly(email) {
  try {
    await fetch(`${INSTANTLY_V1}/lead/pause`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ api_key: CONFIG.INSTANTLY_KEY, campaign_id: CONFIG.INSTANTLY_CAMP, email }),
    });
  } catch (e) {}
}

// ════════════════════════════════════════════════════════════
//  CLAUDE — Classify reply
// ════════════════════════════════════════════════════════════
async function classifyReply(text) {
  if (!CONFIG.CLAUDE_KEY) {
    const t = text.toLowerCase();
    if (/unsubscribe|remove me|stop email|opt.?out/.test(t))          return { classification: 'Spam/Unsubscribe', confidence: 0.99 };
    if (/not interested|no thanks|not for us/.test(t))               return { classification: 'Not Interested',   confidence: 0.85 };
    if (/out of office|on vacation|away until/.test(t))              return { classification: 'Out of Office',    confidence: 0.95 };
    if (/wrong person|not my department/.test(t))                    return { classification: 'Wrong Person',     confidence: 0.90 };
    if (/not now|maybe later|next quarter/.test(t))                  return { classification: 'Not Now',          confidence: 0.80 };
    if (/tell me more|how does|interested|open to|sure|yes/.test(t)) return { classification: 'Interested',       confidence: 0.85 };
    return { classification: 'Not Interested', confidence: 0.50 };
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514', max_tokens: 150,
        messages: [{ role: 'user', content: `Classify this cold email reply.\n\nREPLY: "${text}"\n\nCategories: Interested | Not Now | Not Interested | Wrong Person | Out of Office | Spam/Unsubscribe\n\nJSON only: {"classification":"...","confidence":0.00,"reasoning":"one sentence"}` }],
      }),
    });
    const d  = await r.json();
    const t2 = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return JSON.parse(t2.replace(/```json|```/g, '').trim());
  } catch (e) { return { classification: 'Not Interested', confidence: 0.5 }; }
}

function buildAutoResponse(classification) {
  const templates = {
    'Interested':     `Awesome — happy to show you.\n\nGrab a quick time here:\n${CONFIG.CALENDAR_LINK}\n\n– ${CONFIG.SENDER_NAME}`,
    'Not Now':        `No worries. What month would work better to circle back?\n\n– ${CONFIG.SENDER_NAME}`,
    'Not Interested': `All good — appreciate you letting me know.\n\n– ${CONFIG.SENDER_NAME}`,
    'Wrong Person':   `Got it — who would be the right person to reach out to?\n\n– ${CONFIG.SENDER_NAME}`,
    'Out of Office':  `Thanks — I'll follow up when you're back.\n\n– ${CONFIG.SENDER_NAME}`,
  };
  return templates[classification] || null;
}

// ════════════════════════════════════════════════════════════
//  MAIN WORKERS
// ════════════════════════════════════════════════════════════
async function runLeadWorker() {
  if (state.leadWorkerRunning) { log('Lead worker already running — skipping'); return; }
  state.leadWorkerRunning = true;
  log('═══ Lead Worker starting ═══');

  try {
    if (!CONFIG.APOLLO_KEY) { log('No APOLLO_API_KEY — skipping', 'warn'); return; }

    let people;
    try {
      people = await apolloSearch();
    } catch (e) {
      log(`Apollo search failed: ${e.message}`, 'error');
      return;
    }

    if (!people.length) { log('Apollo returned 0 people'); return; }

    const seenEmails    = new Set(state.leads.map(l => l.email));
    const seenApolloIds = new Set(state.leads.map(l => l.apolloId).filter(Boolean));
    const fresh         = people.filter(p => !seenApolloIds.has(p.id));
    log(`${fresh.length} new people to enrich (${people.length - fresh.length} already seen)`);

    const toEnrich      = fresh.slice(0, 25);
    const enrichedLeads = [];

    for (const person of toEnrich) {
      const lead = await enrichPerson(person);
      if (lead && lead.email && !seenEmails.has(lead.email)) {
        lead.apolloId = person.id;
        enrichedLeads.push(lead);
        seenEmails.add(lead.email);
        state.stats.enriched++;
        log(`📧 ${lead.first_name} ${lead.last_name} <${lead.email}> @ ${lead.company}`);
      }
      await sleep(1000);
    }

    state.stats.leadsFound += enrichedLeads.length;
    state.lastApolloRun = new Date().toISOString();
    log(`✅ ${enrichedLeads.length} leads with verified emails`);

    if (!enrichedLeads.length) return;

    log(`✏️ Personalizing ${enrichedLeads.length} leads…`);
    for (const lead of enrichedLeads) {
      lead.personalization = await personalizeForLead(lead);
      await sleep(2000);
    }

    state.leads.push(...enrichedLeads.map(l => ({
      ...l, addedAt: new Date().toISOString(), status: 'new', tags: ['apollo']
    })));

    await pushToInstantly(enrichedLeads);
    log(`🎉 Lead worker done — ${enrichedLeads.length} leads personalized and pushed to Instantly`);

  } finally {
    state.leadWorkerRunning = false;
  }
}

async function runReplyWorker() {
  log('═══ Reply Worker starting ═══');
  let replies;
  try {
    replies = await fetchInstantlyReplies();
  } catch (e) {
    log(`Reply fetch error: ${e.message}`, 'error');
    return;
  }
  state.lastReplyPoll = new Date().toISOString();
  if (!replies.length) { log('No new replies'); return; }

  for (const reply of replies) {
    const replyId   = reply.id;
    const fromEmail = (reply.from_email || '').toLowerCase();
    const fromName  = reply.from_name  || fromEmail.split('@')[0];
    const bodyText  = reply.body || '';

    if (state.seenReplyIds.includes(replyId) || state.blockedEmails.includes(fromEmail)) continue;
    state.seenReplyIds.push(replyId);
    state.stats.repliesRead++;

    const { classification, confidence } = await classifyReply(bodyText);
    log(`📩 ${fromName} <${fromEmail}> → ${classification} (${Math.round((confidence||0)*100)}%)`);

    if (classification === 'Spam/Unsubscribe') {
      state.blockedEmails.push(fromEmail);
      await pauseLeadInInstantly(fromEmail);
      state.stats.unsub++;
    } else if (classification === 'Interested' && (confidence||0) >= 0.80 && state.autoReplyEnabled) {
      const sent = await sendInstantlyReply(reply.email_id, reply.eaccount, buildAutoResponse('Interested'));
      state.stats.interested++;
      state.stats.autoSent++;
      if (sent) log(`🎉 Booking link sent to ${fromName}!`, 'success');
    } else if (classification === 'Interested') {
      state.stats.interested++;
      log(`⚑ ${fromName} interested but low confidence — flagged for manual review`);
    } else if (state.autoReplyEnabled) {
      const response = buildAutoResponse(classification);
      if (response) {
        await sendInstantlyReply(reply.email_id, reply.eaccount, response);
        if (['Not Now', 'Not Interested', 'Out of Office'].includes(classification)) {
          await pauseLeadInInstantly(fromEmail);
        }
        state.stats.autoSent++;
      }
    }
  }
  if (state.seenReplyIds.length > 1000) state.seenReplyIds = state.seenReplyIds.slice(-1000);
}

// ════════════════════════════════════════════════════════════
//  TIMERS
// ════════════════════════════════════════════════════════════
async function startWorkers() {
  log('🚀 OutreachAI server started — Apollo + Claude + Instantly V2');
  log(`Config check → Apollo:${!!CONFIG.APOLLO_KEY} | InstantlyV1:${!!CONFIG.INSTANTLY_KEY} | InstantlyV2:${!!CONFIG.INSTANTLY_KEY_V2} | Claude:${!!CONFIG.CLAUDE_KEY}`);

  const runLeads = async () => {
    try { await runLeadWorker(); } catch (e) { log('Lead worker crash: ' + e.message, 'error'); }
    setTimeout(runLeads, 30 * 60 * 1000);
  };
  const runReplies = async () => {
    try { await runReplyWorker(); } catch (e) { log('Reply worker crash: ' + e.message, 'error'); }
    setTimeout(runReplies, CONFIG.POLL_INTERVAL_MS);
  };

  setTimeout(runLeads,   5000);
  setTimeout(runReplies, 8000);
}

// ════════════════════════════════════════════════════════════
//  API ROUTES — all return JSON, never HTML
// ════════════════════════════════════════════════════════════

// ── Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'outreachai-server', uptime: process.uptime() });
});

// ── Root (also returns JSON)
app.get('/', (req, res) => {
  res.json({
    ok: true, service: 'outreachai-server', uptime: process.uptime(),
    stats: state.stats,
    lastApolloRun: state.lastApolloRun,
    lastReplyPoll: state.lastReplyPoll,
    apolloConfigured:      !!CONFIG.APOLLO_KEY,
    claudeConfigured:      !!CONFIG.CLAUDE_KEY,
    instantlyV1Configured: !!CONFIG.INSTANTLY_KEY,
    instantlyV2Configured: !!CONFIG.INSTANTLY_KEY_V2,
  });
});

// ── Status counters
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    leadsFound:   state.stats.leadsFound,
    enriched:     state.stats.enriched,
    pushed:       state.stats.pushed,
    repliesRead:  state.stats.repliesRead,
    interested:   state.stats.interested,
    autoSent:     state.stats.autoSent,
    unsub:        state.stats.unsub,
    personalized: state.stats.personalized,
    lastApolloRun: state.lastApolloRun,
    lastReplyPoll: state.lastReplyPoll,
    leadWorkerRunning: state.leadWorkerRunning,
  });
});

// ── Logs
app.get('/api/logs', (req, res) => {
  res.json({ ok: true, logs: state.log.slice(0, 200) });
});

// ── Full state
app.get('/api/state', (req, res) => {
  res.json({
    ok: true,
    leads: state.leads.slice(0, 200),
    stats: state.stats,
    log:   state.log.slice(0, 100),
    blockedEmails:    state.blockedEmails,
    lastApolloRun:    state.lastApolloRun,
    lastReplyPoll:    state.lastReplyPoll,
    autoReplyEnabled: state.autoReplyEnabled,
  });
});

// ── Trigger lead fetch (POST)
app.post('/api/leads/fetch', (req, res) => {
  res.json({ ok: true, started: true, message: 'Apollo lead worker started' });
  runLeadWorker().catch(e => log('Lead worker error: ' + e.message, 'error'));
});

// ── Trigger reply check (POST)
app.post('/api/replies/check', (req, res) => {
  res.json({ ok: true, started: true, message: 'Reply worker started' });
  runReplyWorker().catch(e => log('Reply worker error: ' + e.message, 'error'));
});

// ── Test Apollo
app.get('/api/apollo/test', async (req, res) => {
  if (!CONFIG.APOLLO_KEY) return res.status(400).json({ ok: false, error: 'APOLLO_API_KEY not set' });
  try {
    const r = await fetch(`${APOLLO_BASE}/mixed_people/api_search`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': CONFIG.APOLLO_KEY },
      body:    JSON.stringify({ page: 1, per_page: 1, person_titles: ['ceo'], person_locations: ['United States'] }),
    });
    const d = await r.json();
    if (r.ok) {
      res.json({ ok: true, message: `Apollo connected — ${d.pagination?.total_entries || '?'} prospects available` });
    } else {
      res.status(r.status).json({ ok: false, error: d.message || JSON.stringify(d) });
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Test Instantly V2
app.get('/api/instantly/test', async (req, res) => {
  const key = CONFIG.INSTANTLY_KEY_V2;
  if (!key) return res.status(400).json({ ok: false, error: 'INSTANTLY_KEY_V2 not set in Render env vars' });
  try {
    const r        = await fetch(`${INSTANTLY_V2}/emails?limit=1`, {
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }
    });
    const bodyText = await r.text();
    if (r.ok) {
      res.json({ ok: true, message: 'Instantly V2 connected', status: r.status });
    } else {
      res.status(r.status).json({ ok: false, status: r.status, error: bodyText });
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Toggle auto-reply
app.post('/api/autoreply/toggle', (req, res) => {
  state.autoReplyEnabled = !state.autoReplyEnabled;
  log(`Auto-reply ${state.autoReplyEnabled ? 'ENABLED' : 'DISABLED'}`);
  res.json({ ok: true, autoReplyEnabled: state.autoReplyEnabled });
});

// ── Proxy Instantly (browser CORS fix)
app.all('/api/proxy/instantly/*', async (req, res) => {
  try {
    const path    = req.params[0];
    const isV2    = path.startsWith('v2/');
    const baseUrl = isV2 ? 'https://api.instantly.ai/api' : INSTANTLY_V1;
    const url     = `${baseUrl}/${path}`;
    const headers = { 'Content-Type': 'application/json' };
    if (isV2 && CONFIG.INSTANTLY_KEY_V2) headers['Authorization'] = `Bearer ${CONFIG.INSTANTLY_KEY_V2}`;
    const r = await fetch(url, {
      method: req.method, headers,
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Unblock email
app.post('/api/unblock', (req, res) => {
  state.blockedEmails = state.blockedEmails.filter(e => e !== req.body.email);
  res.json({ ok: true });
});

// ── Clear logs
app.post('/api/log/clear', (req, res) => { state.log = []; res.json({ ok: true }); });


// ════════════════════════════════════════════════════════════
//  CSV IMPORT ROUTES
// ════════════════════════════════════════════════════════════

// Personalize a single lead via Claude
app.post('/api/personalize', async (req, res) => {
  const { lead } = req.body || {};
  if(!lead || !lead.first_name) return res.status(400).json({ ok: false, error: 'lead required' });
  try {
    const personalization = await personalizeForLead(lead);
    res.json({ ok: true, personalization });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Push a batch of pre-personalized CSV leads to Instantly
app.post('/api/csv/push', async (req, res) => {
  const { leads, instantly_key, campaign_id } = req.body || {};
  if(!leads || !leads.length) return res.status(400).json({ ok: false, error: 'leads array required' });

  const iKey  = instantly_key  || CONFIG.INSTANTLY_KEY;
  const iCamp = campaign_id    || CONFIG.INSTANTLY_CAMP;

  // Cap at 2000 per call
  const batch = leads.slice(0, 2000);
  log(`[CSV Push] Pushing ${batch.length} leads to Instantly campaign ${iCamp}`);

  try {
    const r = await fetch(`${INSTANTLY_V1}/lead/add`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key:              iKey,
        campaign_id:          iCamp,
        skip_if_in_workspace: true,
        leads:                batch,
      }),
    });
    const bodyText = await r.text();
    log(`[CSV Push] Instantly responded ${r.status}: ${bodyText.slice(0,200)}`);

    if(r.ok){
      state.stats.pushed += batch.length;
      res.json({ ok: true, pushed: batch.length });
    } else {
      let errMsg = bodyText;
      try { errMsg = JSON.parse(bodyText).error || bodyText; } catch(e) {}
      res.status(r.status).json({ ok: false, error: errMsg, status: r.status });
    }
  } catch(e) {
    log(`[CSV Push] Exception: ${e.message}`, 'error');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 404 catch-all — always JSON, never HTML
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.path}` });
});

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`OutreachAI server running on port ${PORT}`);
  startWorkers();
});
