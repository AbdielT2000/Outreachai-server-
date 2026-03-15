// ═══════════════════════════════════════════════════════════
//  OutreachAI Backend Server — Multi-Campaign Edition
//  Each campaign has its own sender name + calendar link
//  so auto-replies go out as the right client
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── Global config (fallback defaults)
const CONFIG = {
  INSTANTLY_KEY:    process.env.INSTANTLY_KEY    || '',
  INSTANTLY_KEY_V2: process.env.INSTANTLY_KEY_V2 || '',
  CLAUDE_KEY:       process.env.CLAUDE_KEY       || '',
  SENDER_NAME:      process.env.SENDER_NAME      || 'The Team',
  CALENDAR_LINK:    process.env.CALENDAR_LINK    || '',
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '300000'),
};

const V1 = 'https://api.instantly.ai/api/v1';
const V2 = 'https://api.instantly.ai/api/v2';

// ── Per-campaign config store — persisted to disk so restarts don't wipe data
// Shape: { [campaignId]: { name, senderName, calendarLink, instantlyKey, campaignId } }
const CAMPAIGNS_FILE = path.join(__dirname, 'campaigns.json');

function loadCampaigns() {
  try {
    if (fs.existsSync(CAMPAIGNS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'));
      console.log(`[INFO] Loaded ${Object.keys(data).length} campaigns from disk`);
      return data;
    }
  } catch (e) { console.error('[WARN] Could not load campaigns.json:', e.message); }
  return {};
}

function saveCampaignsToDisk() {
  try { fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(campaigns, null, 2)); }
  catch (e) { console.error('[WARN] Could not save campaigns.json:', e.message); }
}

let campaigns = loadCampaigns();

// ── State
let state = {
  log:           [],
  stats:         { personalized: 0, pushed: 0, repliesChecked: 0, autoReplied: 0 },
  repliedEmails: new Set(),
  workerRunning: false,
  lastPoll:      null,
};

function log(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 500) state.log = state.log.slice(0, 500);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Look up which campaign config to use for a given campaign ID
function getCampaignCfg(campaignId) {
  if (campaignId && campaigns[campaignId]) return campaigns[campaignId];
  // fallback to global defaults
  return {
    senderName:   CONFIG.SENDER_NAME,
    calendarLink: CONFIG.CALENDAR_LINK,
    instantlyKey: CONFIG.INSTANTLY_KEY,
    campaignId,
  };
}

// ════════════════════════════════════════════════════════════
//  RESEARCH — fetch and clean page text from any URL
// ════════════════════════════════════════════════════════════
async function fetchPageText(url, timeoutMs = 9000) {
  try {
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!r.ok) return null;
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return text.length > 50 ? text.slice(0, 3500) : null;
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════
//  RESEARCH — find best page to read about a company
//  Priority: website → Google search → LinkedIn
// ════════════════════════════════════════════════════════════
async function researchCompany(lead) {
  const company = lead.company || '';
  const website = lead.website || '';

  // 1. Try their website first
  if (website) {
    const text = await fetchPageText(website);
    if (text) {
      log(`🔍 Got website for ${company}`);
      return { source: 'website', url: website, text };
    }
  }

  // 2. Try Google search to find their site
  if (company) {
    try {
      const query = encodeURIComponent(`${company} agency official site`);
      const googleUrl = `https://www.google.com/search?q=${query}`;
      const html = await fetch(googleUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(7000),
        redirect: 'follow',
      }).then(r => r.ok ? r.text() : null).catch(() => null);

      if (html) {
        const urlMatch = html.match(/href="(https?:\/\/(?!www\.google)[^"&]+)"/);
        if (urlMatch) {
          const foundUrl = urlMatch[1];
          const text = await fetchPageText(foundUrl);
          if (text) {
            log(`🔍 Found ${company} via Google: ${foundUrl}`);
            return { source: 'google', url: foundUrl, text };
          }
        }
      }
    } catch {}
  }

  // 3. Try LinkedIn company page
  if (company) {
    const linkedinSlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const linkedinUrl = `https://www.linkedin.com/company/${linkedinSlug}/about/`;
    const text = await fetchPageText(linkedinUrl, 8000);
    if (text && text.length > 100) {
      log(`🔍 Got LinkedIn for ${company}`);
      return { source: 'linkedin', url: linkedinUrl, text };
    }
  }

  log(`⚠️  No research found for ${company} — using name only`, 'warn');
  return { source: 'none', url: '', text: null };
}

// ════════════════════════════════════════════════════════════
//  CLAUDE — personalize opener with real research
// ════════════════════════════════════════════════════════════
async function personalizeForLead(lead) {
  const fallback = `Noticed ${lead.company} works with businesses on their marketing growth.`;
  if (!CONFIG.CLAUDE_KEY) return fallback;

  const research = await researchCompany(lead);

  let ctx;
  if (research.text) {
    ctx = `Research source: ${research.source} (${research.url})\nContent:\n"""\n${research.text}\n"""`;
  } else {
    ctx = `No website or page found. Only known info: Company name is "${lead.company}". Contact: ${lead.first_name}, Title: ${lead.title || 'unknown'}.`;
  }

  const prompt = `You are writing the FIRST LINE of a cold email to ${lead.first_name} at ${lead.company}.

${ctx}

Your job: Write ONE ultra-specific opening line that proves you actually know what this company does.

STRICT RULES:
- Start with "Noticed" or "Saw" — do NOT start with "Hi" or "I"
- Reference their SPECIFIC service, niche, client type, or methodology
- Maximum 15 words total
- FORBIDDEN: "I noticed you work at", "I came across", "I checked your website", "your company", "you run", "I visited"
- Return ONLY the single line — no quotes, no punctuation at end

GOOD examples:
Noticed ELITE PPC focuses heavily on Google Ads for local service businesses.
Saw BlueWing Impact runs SEO campaigns specifically for B2B SaaS companies.
Noticed Thrive CRM helps marketing agencies automate their client onboarding.
Saw Scaletopia places remote dev teams for Series A startups.

BAD examples (never write these):
Hi ${lead.first_name}, noticed you work at ${lead.company}.
I noticed your company does marketing.
Saw that you run ${lead.company}.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(22000),
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const d = await r.json();
    const text = (d.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()
      .replace(/^["'`]|["'`.,]$/g, '')
      .replace(/^(Hi\s+\w+,?\s*)/i, '');

    if (text && text.length > 10 && text.length < 160) {
      state.stats.personalized++;
      log(`✏️  ${lead.first_name} @ ${lead.company} [${research.source}]: "${text}"`);
      return text;
    }
  } catch (e) { log(`Personalization error: ${e.message}`, 'warn'); }
  return fallback;
}


// ════════════════════════════════════════════════════════════
//  CLAUDE — classify reply
// ════════════════════════════════════════════════════════════
async function classifyReply(replyText) {
  if (!CONFIG.CLAUDE_KEY) return 'other';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: `Classify this cold email reply into exactly one word:\n- interested (wants to learn more, open to a call)\n- not_interested (said no, unsubscribe)\n- question (asked something, not committed)\n- ooo (out of office auto-reply)\n- other\n\nReply:\n"""\n${replyText.slice(0, 800)}\n"""\n\nReturn ONLY one of: interested, not_interested, question, ooo, other` }],
      }),
      signal: AbortSignal.timeout(12000),
    });
    const d = await r.json();
    const result = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim().toLowerCase().split(/\s/)[0];
    const valid = ['interested', 'not_interested', 'question', 'ooo', 'other'];
    return valid.includes(result) ? result : 'other';
  } catch (e) { log(`Classify error: ${e.message}`, 'warn'); return 'other'; }
}

// ════════════════════════════════════════════════════════════
//  CLAUDE — write booking reply AS the client
// ════════════════════════════════════════════════════════════
async function writeBookingReply(prospectName, prospectCompany, originalMessage, calLink, senderName) {
  const fallback = `Hey ${prospectName},\n\nGreat to hear from you! Here's a link to book a time:\n\n${calLink}\n\nLooking forward to connecting.\n\n– ${senderName}`;
  if (!CONFIG.CLAUDE_KEY) return fallback;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: `Write a short, warm reply to a cold email prospect who is interested in booking a call.\n\nProspect: ${prospectName} at ${prospectCompany}\nTheir message: "${originalMessage.slice(0, 300)}"\nCalendar link: ${calLink}\nYou are: ${senderName}\n\nRules:\n- 2-4 sentences max\n- Warm but not over-the-top\n- Include the calendar link naturally\n- Sign off with exactly "– ${senderName}"\n- Return ONLY the reply body, no subject line` }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await r.json();
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return text.length > 20 ? text : fallback;
  } catch (e) { log(`Booking reply error: ${e.message}`, 'warn'); return fallback; }
}

// ════════════════════════════════════════════════════════════
//  INSTANTLY V2 — fetch replies for a campaign
// ════════════════════════════════════════════════════════════
async function fetchReplies(campaignId) {
  const key = CONFIG.INSTANTLY_KEY_V2;
  if (!key) return [];
  try {
    const url = `${V2}/emails?limit=100&type=received${campaignId ? `&campaign_id=${campaignId}` : ''}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { log(`V2 replies fetch ${r.status}`, 'warn'); return []; }
    const d = await r.json();
    return d.items || d.data || d || [];
  } catch (e) { log(`fetchReplies error: ${e.message}`, 'warn'); return []; }
}

// ════════════════════════════════════════════════════════════
//  INSTANTLY V2 — send reply into thread
// ════════════════════════════════════════════════════════════
async function sendReply(emailId, replyBody) {
  const key = CONFIG.INSTANTLY_KEY_V2;
  if (!key) return false;
  try {
    const r = await fetch(`${V2}/emails/${emailId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ body: replyBody }),
      signal: AbortSignal.timeout(12000),
    });
    if (r.ok) { log(`📤 Auto-reply sent (email ${emailId})`, 'success'); return true; }
    const txt = await r.text();
    log(`sendReply ${r.status}: ${txt.slice(0, 120)}`, 'warn');
    return false;
  } catch (e) { log(`sendReply error: ${e.message}`, 'warn'); return false; }
}

// ════════════════════════════════════════════════════════════
//  REPLY WORKER
//  Loops all registered campaigns, polls replies, auto-responds
// ════════════════════════════════════════════════════════════
async function replyWorker() {
  if (state.workerRunning) return;
  state.workerRunning = true;
  state.lastPoll = new Date().toISOString();
  log('🔄 Reply worker running…');

  try {
    // Build list of campaign IDs to check
    // Always include registered campaigns + the global default campaign
    const campaignIds = new Set([
      ...Object.keys(campaigns),
      CONFIG.INSTANTLY_CAMP,
    ].filter(Boolean));

    if (!campaignIds.size) {
      log('No campaigns configured for reply polling', 'warn');
      state.workerRunning = false;
      return;
    }

    for (const campaignId of campaignIds) {
      const cfg = getCampaignCfg(campaignId);
      if (!cfg.calendarLink) {
        log(`Campaign ${campaignId}: no calendar link set, skipping`, 'warn');
        continue;
      }

      const replies = await fetchReplies(campaignId);
      log(`Campaign ${campaignId}: ${replies.length} replies`);
      state.stats.repliesChecked += replies.length;

      for (const reply of replies) {
        const emailId   = reply.id || reply.email_id;
        const fromEmail = (reply.from_address?.email || reply.from_email || reply.from || '').toLowerCase();
        const fromName  = reply.from_address?.name || reply.from_name || fromEmail.split('@')[0] || 'there';
        const company   = reply.lead?.company_name || reply.company || '';
        const bodyText  = reply.body?.text || reply.body || reply.text_body || '';

        if (!emailId || !bodyText || state.repliedEmails.has(fromEmail)) continue;

        const classification = await classifyReply(bodyText);
        log(`📬 [${cfg.senderName}] ${fromEmail} → ${classification}`);

        if (classification !== 'interested') continue;

        // Build the calendar link
        const calLink = cfg.calendarLink.startsWith('http') ? cfg.calendarLink : 'https://' + cfg.calendarLink;

        // Write reply AS this campaign's sender
        const replyBody = await writeBookingReply(fromName, company, bodyText, calLink, cfg.senderName);

        const sent = await sendReply(emailId, replyBody);
        if (sent) {
          state.repliedEmails.add(fromEmail);
          state.stats.autoReplied++;
          log(`✅ Auto-replied as "${cfg.senderName}" to ${fromEmail} → ${calLink}`, 'success');
        }

        await sleep(1500);
      }
    }
  } catch (e) {
    log(`Reply worker error: ${e.message}`, 'error');
  }

  state.workerRunning = false;
  log('✅ Reply worker done');
}

// ════════════════════════════════════════════════════════════
//  API ROUTES
// ════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({ ok: true, service: 'outreachai-server', uptime: process.uptime(), stats: state.stats, lastPoll: state.lastPoll }));

app.get('/api/health', (req, res) => res.json({
  ok: true, service: 'outreachai-server', uptime: process.uptime(),
  claudeConfigured: !!CONFIG.CLAUDE_KEY,
  instantlyConfigured: !!CONFIG.INSTANTLY_KEY,
  replyWorkerActive: !!CONFIG.INSTANTLY_KEY_V2,
  campaignsRegistered: Object.keys(campaigns).length,
}));

app.get('/api/status', (req, res) => res.json({
  ok: true, ...state.stats,
  lastPoll: state.lastPoll,
  workerRunning: state.workerRunning,
  repliedCount: state.repliedEmails.size,
  campaigns: Object.values(campaigns).map(c => ({ id: c.campaignId, name: c.name, senderName: c.senderName, hasCalendar: !!c.calendarLink })),
}));

app.get('/api/logs', (req, res) => res.json({ ok: true, logs: state.log.slice(0, 200) }));

// ── Register / update a campaign
// POST /api/campaigns
// Body: { campaignId, name, senderName, calendarLink, instantlyKey (optional) }
app.post('/api/campaigns', (req, res) => {
  const { campaignId, name, senderName, calendarLink, instantlyKey } = req.body || {};
  if (!campaignId || !senderName || !calendarLink) {
    return res.status(400).json({ ok: false, error: 'campaignId, senderName, and calendarLink are required' });
  }
  campaigns[campaignId] = {
    campaignId,
    name:         name        || campaignId,
    senderName:   senderName,
    calendarLink: calendarLink,
    instantlyKey: instantlyKey || CONFIG.INSTANTLY_KEY,
    notes:        req.body.notes || '',
    addedAt:      new Date().toISOString(),
  };
  saveCampaignsToDisk();
  log(`Campaign registered: "${name}" → sender: ${senderName}, cal: ${calendarLink}`);
  res.json({ ok: true, campaign: campaigns[campaignId] });
});

// ── Get all campaigns
app.get('/api/campaigns', (req, res) => {
  res.json({ ok: true, campaigns: Object.values(campaigns) });
});

// ── Delete a campaign
app.delete('/api/campaigns/:id', (req, res) => {
  const id = req.params.id;
  if (campaigns[id]) { delete campaigns[id]; saveCampaignsToDisk(); res.json({ ok: true }); }
  else res.status(404).json({ ok: false, error: 'Campaign not found' });
});

// ── Personalize single lead
app.post('/api/personalize', async (req, res) => {
  const { lead } = req.body || {};
  if (!lead || !lead.first_name) return res.status(400).json({ ok: false, error: 'lead with first_name required' });
  try {
    const personalization = await personalizeForLead(lead);
    res.json({ ok: true, personalization });
  } catch (e) {
    log(`/api/personalize error: ${e.message}`, 'error');
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Push batch to Instantly
app.post('/api/csv/push', async (req, res) => {
  const { leads, instantly_key, campaign_id } = req.body || {};
  if (!leads || !leads.length) return res.status(400).json({ ok: false, error: 'leads array required' });
  const iKey  = instantly_key || CONFIG.INSTANTLY_KEY;
  const iCamp = campaign_id   || CONFIG.INSTANTLY_CAMP;
  if (!iKey)  return res.status(400).json({ ok: false, error: 'Instantly API key not set' });
  if (!iCamp) return res.status(400).json({ ok: false, error: 'Instantly campaign ID not set' });
  log(`[CSV Push] Pushing ${leads.length} leads to ${iCamp}`);
  try {
    const r = await fetch(`${V1}/lead/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: iKey, campaign_id: iCamp, skip_if_in_workspace: true, leads: leads.slice(0, 2000) }),
      signal: AbortSignal.timeout(25000),
    });
    const txt = await r.text();
    if (r.ok) { state.stats.pushed += leads.length; res.json({ ok: true, pushed: leads.length }); }
    else { let e = txt; try { e = JSON.parse(txt).error || txt; } catch {} res.status(r.status).json({ ok: false, error: e }); }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Manually trigger reply check
app.post('/api/replies/check', (req, res) => {
  res.json({ ok: true, message: 'Reply worker triggered' });
  replyWorker();
});

// ── Clear replied set
app.post('/api/replies/reset', (req, res) => {
  state.repliedEmails.clear();
  res.json({ ok: true, message: 'Replied set cleared' });
});

// ── Test Instantly connection with any key (POST from dashboard, GET for default)
app.all('/api/instantly/test', async (req, res) => {
  const key = req.body?.instantly_key || CONFIG.INSTANTLY_KEY;
  if (!key) return res.status(400).json({ ok: false, error: 'No Instantly key provided' });
  try {
    const r = await fetch(`${V1}/campaign/list?api_key=${key}&limit=1`, {
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      res.json({ ok: true, message: 'Instantly connected' });
    } else {
      const txt = await r.text();
      let err = txt; try { err = JSON.parse(txt).error || txt; } catch {}
      res.status(r.status).json({ ok: false, error: err });
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── 404
app.use((req, res) => res.status(404).json({ ok: false, error: `Not found: ${req.method} ${req.path}` }));

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`🚀 OutreachAI server on port ${PORT}`);
  log(`Claude: ${CONFIG.CLAUDE_KEY ? '✅' : '❌'}  V1: ${CONFIG.INSTANTLY_KEY ? '✅' : '❌'}  V2: ${CONFIG.INSTANTLY_KEY_V2 ? '✅' : '❌'}`);
  log(`Default calendar: ${CONFIG.CALENDAR_LINK || '❌ not set'}`);

  if (CONFIG.INSTANTLY_KEY_V2) {
    log(`⏰ Reply worker — polling every ${CONFIG.POLL_INTERVAL_MS / 60000} min`);
    replyWorker();
    setInterval(replyWorker, CONFIG.POLL_INTERVAL_MS);
  } else {
    log('⚠️  Reply worker disabled — set INSTANTLY_KEY_V2 to enable', 'warn');
  }
});
