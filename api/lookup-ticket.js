const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN;
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;

function authHeader() {
  return 'Basic ' + Buffer.from(`${FRESHDESK_API_KEY}:X`).toString('base64');
}

function stripHtml(html) {
  return html ? html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function mapStatusAgent(status) {
  return { 2: 'Open', 3: 'Pending', 4: 'Resolved', 5: 'Closed' }[status] || `Status ${status}`;
}

function mapStatusCustomer(agentLabel) {
  const map = {
    Open: 'Being Processed',
    Pending: 'Allocated',
    'Waiting information': 'Waiting for more information',
    'Waiting for Parts': 'Waiting for parts to arrive',
    Resolved: 'Resolved',
    Closed: 'Closed',
    'Job Complete waiting': 'Job complete and pending confirmation',
    'Waiting for arrival': 'Waiting for technician arrival',
    'Pending payment': 'Pending payment',
    'Waiting supplier claim': 'Waiting on a supplier claim'
  };
  return map[agentLabel] || agentLabel;
}

async function fdFetch(path) {
  const res = await fetch(`https://${FRESHDESK_DOMAIN}${path}`, {
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' }
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

async function fdGet(path) {
  const res = await fdFetch(path);
  if (!res.ok) throw new Error(`Freshdesk API error ${res.status}: ${JSON.stringify(res.data)}`);
  return res.data;
}

// ─── Fetch ticket pages in parallel ──────────────────────────────────────────
async function fetchTicketPages(fromPage, toPage) {
  const promises = [];
  for (let p = fromPage; p <= toPage; p++) {
    promises.push(
      fdFetch(`/api/v2/tickets?per_page=100&page=${p}&order_by=created_at&order_type=desc&include=requester,company`)
        .then(r => (r.ok && Array.isArray(r.data)) ? r.data : [])
        .catch(() => [])
    );
  }
  const results = await Promise.all(promises);
  return results.flat();
}

// ─── Date formatting ──────────────────────────────────────────────────────────
function formatSpokenDate(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date)) return null;
  const diffDays = Math.floor((Date.now() - date) / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays <= 6) return `${diffDays} days ago`;
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ─── Get public conversations only ───────────────────────────────────────────
async function getLatestUpdate(ticketId, description) {
  const res = await fdFetch(`/api/v2/tickets/${ticketId}/conversations`);
  if (res.ok && Array.isArray(res.data)) {
    for (const convo of [...res.data].reverse()) {
      if (convo.private) continue;
      const text = stripHtml(convo.body_text || convo.plain_text_body || convo.body || '');
      if (text && text.length > 10) return { text: text.slice(0, 500), date: convo.created_at };
    }
  }
  const descText = stripHtml(description || '');
  if (descText && descText.length > 5) return { text: descText.slice(0, 500), date: null };
  return null;
}

// ─── Smart spoken summary ─────────────────────────────────────────────────────
async function buildSmartSpokenSummary(ticket, customerStatusLabel, agentStatusLabel) {
  const cf = ticket.custom_fields || {};
  const productLine  = cf.cf_product_line248059 || cf.cf_product_line || '';
  const productModel = cf.cf_model760094 || cf.cf_model365636 || cf.cf_model289096 || '';
  const productDesc  = [productLine, productModel].filter(Boolean).join(' ');
  const createdDate  = formatSpokenDate(ticket.created_at);
  const issueText    = ticket.subject?.trim() || stripHtml(ticket.description_text || '').slice(0, 120) || '';
  const partsReplaced = cf.cf_parts_replaced || '';
  const latestUpdate = await getLatestUpdate(ticket.id, ticket.description_text || ticket.description);
  const parts = [`Alright, I've found your request.`];

  if (createdDate && issueText) {
    if (productDesc) {
      parts.push(`Your ticket was created ${createdDate} regarding an issue with your ${productDesc} — ${issueText.toLowerCase()}.`);
    } else {
      parts.push(`Your ticket was created ${createdDate} regarding ${issueText.toLowerCase()}.`);
    }
  } else if (productDesc) {
    parts.push(`This request relates to your ${productDesc}.`);
  }

  const statusPhrases = {
    'Being Processed': `It's currently being handled by our technical support team and is marked as in progress.`,
    'Allocated': `It's been allocated to a technician and is currently being actioned.`,
    'Waiting for parts to arrive': `We're currently waiting on parts to arrive before work can proceed.`,
    'Waiting for more information': `Our team is waiting on some additional information before they can proceed.`,
    'Waiting for technician arrival': `A technician has been scheduled and is on their way.`,
    'Job complete and pending confirmation': `The job has been completed and is pending final confirmation.`,
    'Pending payment': `The job is complete and is currently pending payment.`,
    'Waiting on a supplier claim': `We're currently waiting on a response from the supplier before proceeding.`,
    'Resolved': `This ticket has been resolved.`,
    'Closed': `This ticket has been closed.`
  };
  parts.push(statusPhrases[customerStatusLabel] || `It's currently ${customerStatusLabel}.`);

  if (latestUpdate) {
    const intro = latestUpdate.date ? `The last update was ${formatSpokenDate(latestUpdate.date)}` : `The latest update`;
    const text  = latestUpdate.text;
    if (partsReplaced && !['Resolved','Closed'].includes(agentStatusLabel)) {
      parts.push(`${intro} — parts ${partsReplaced} have been identified for this repair.`);
    } else if (/waiting|part/i.test(text)) {
      parts.push(`${intro} — the team is waiting on parts or a supplier response before they can proceed.`);
    } else if (/schedul|appointment|book/i.test(text)) {
      parts.push(`${intro} — a technician appointment has been scheduled.`);
    } else if (/complet|resolv|fixed/i.test(text)) {
      parts.push(`${intro} — the repair has been completed.`);
    } else if (/review|assess/i.test(text)) {
      parts.push(`${intro} — the team has reviewed your case and is determining the next steps.`);
    } else if (text.length > 20) {
      parts.push(`${intro} — ${text.slice(0, 200).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()}`);
    }
  }

  if (['Resolved','Closed'].includes(agentStatusLabel)) {
    parts.push(`If you have any further concerns, please don't hesitate to call us back.`);
  } else if (customerStatusLabel === 'Waiting for more information') {
    parts.push(`Our team will need some additional information from you. Someone from Hayward will be in touch shortly.`);
  } else {
    parts.push(`There's nothing you need to do right now. As soon as there's an update, someone from the Hayward team will reach out to you directly.`);
  }

  return parts.join(' ');
}

// ─── Fuzzy matching ───────────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function soundex(str) {
  const s = str.toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return '';
  const map = { B:1,F:1,P:1,V:1,C:2,G:2,J:2,K:2,Q:2,S:2,X:2,Z:2,D:3,T:3,L:4,M:5,N:5,R:6 };
  let code = s[0], prev = map[s[0]] || 0;
  for (let i = 1; i < s.length && code.length < 4; i++) {
    const curr = map[s[i]] || 0;
    if (curr && curr !== prev) code += curr;
    prev = curr;
  }
  return code.padEnd(4, '0');
}

function nameSimilarity(input, candidate) {
  const a = input.toLowerCase().trim(), b = candidate.toLowerCase().trim();
  if (a === b) return 1.0;
  if (b.includes(a) || a.includes(b)) return 0.9;
  const aWords = a.split(/\s+/), bWords = b.split(/\s+/);
  let wordScore = 0, wordCount = 0;
  for (const aw of aWords) {
    if (aw.length < 2) continue;
    let best = 0;
    for (const bw of bWords) {
      if (bw.length < 2) continue;
      const lev = 1 - levenshtein(aw, bw) / Math.max(aw.length, bw.length);
      const snd = soundex(aw) === soundex(bw) ? 0.2 : 0;
      best = Math.max(best, Math.min(1, lev + snd));
    }
    wordScore += best; wordCount++;
  }
  return wordCount > 0 ? wordScore / wordCount : 0;
}

function bestFuzzyMatch(input, candidates, threshold = 0.72) {
  let best = null;
  candidates.forEach((candidate, index) => {
    if (!candidate) return;
    const score = nameSimilarity(input, candidate);
    if (score >= threshold && (!best || score > best.score)) best = { index, score };
  });
  return best;
}

// ─── Lookup by ticket number ──────────────────────────────────────────────────
async function resolveByTicketId(ticketInput) {
  const normalized = String(ticketInput || '').trim().replace(/^#/, '');
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  const direct = await fdFetch(`/api/v2/tickets/${normalized}?include=requester,company`);
  if (direct.ok && direct.data?.id) return { ticket: direct.data, match_method: 'ticket_id' };
  return null;
}

// ─── Lookup by email ──────────────────────────────────────────────────────────
async function resolveByEmail(email) {
  if (!email || !email.includes('@')) return null;
  const lower = email.trim().toLowerCase();

  // 1. Contact lookup by email field
  const contacts = await fdFetch(`/api/v2/contacts?email=${encodeURIComponent(lower)}`);
  if (contacts.ok && Array.isArray(contacts.data) && contacts.data.length > 0) {
    const tickets = await fdFetch(
      `/api/v2/tickets?requester_id=${contacts.data[0].id}&order_by=created_at&order_type=desc&per_page=1&include=requester,company`
    );
    if (tickets.ok && Array.isArray(tickets.data) && tickets.data.length > 0) {
      return { ticket: tickets.data[0], match_method: 'email', matched_contact: contacts.data[0] };
    }
  }

  // 2. Parallel page scan — check requester.email and cf_retailer_email
  const allTickets = await fetchTicketPages(1, 5);
  const match = allTickets.find(t =>
    t.requester?.email?.toLowerCase() === lower ||
    (t.custom_fields?.cf_retailer_email || '').toLowerCase() === lower
  );
  if (match) return { ticket: match, match_method: 'email' };

  return null;
}

// ─── Lookup by phone ──────────────────────────────────────────────────────────
// Only searches structured fields — requester phone/mobile and cf_phone_number
// Does NOT scan email bodies or conversation text
async function resolveByPhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s\-().+]/g, '');
  if (cleaned.length < 6) return null;

  const variants = [cleaned];
  if (cleaned.startsWith('0')) variants.push('61' + cleaned.slice(1));
  if (cleaned.startsWith('61')) variants.push('0' + cleaned.slice(2));
  const last8 = cleaned.slice(-8);

  // 1. Contact lookup by mobile/phone field
  for (const variant of variants) {
    for (const field of ['mobile', 'phone']) {
      const contacts = await fdFetch(`/api/v2/contacts?${field}=${encodeURIComponent(variant)}`);
      if (contacts.ok && Array.isArray(contacts.data) && contacts.data.length > 0) {
        const tickets = await fdFetch(
          `/api/v2/tickets?requester_id=${contacts.data[0].id}&order_by=created_at&order_type=desc&per_page=1&include=requester,company`
        );
        if (tickets.ok && Array.isArray(tickets.data) && tickets.data.length > 0) {
          return { ticket: tickets.data[0], match_method: 'phone', matched_contact: contacts.data[0] };
        }
      }
    }
  }

  // 2. Parallel page scan — check requester phone fields and cf_phone_number custom field
  const allTickets = await fetchTicketPages(1, 5);
  for (const ticket of allTickets) {
    const phoneFields = [
      ticket.requester?.phone || '',
      ticket.requester?.mobile || '',
      ticket.custom_fields?.cf_phone_number || '',
    ].map(v => v.replace(/[\s\-().+]/g, ''));

    for (const variant of [cleaned, last8]) {
      if (phoneFields.some(f => f.includes(variant) || f.endsWith(last8))) {
        return { ticket, match_method: 'phone' };
      }
    }
  }

  return null;
}

// ─── Lookup by name (fuzzy — parallel batch scan) ────────────────────────────
async function resolveByName(name) {
  if (!name || name.trim().length < 2) return null;
  const trimmed = name.trim();

  // Parallel fetch of first 10 pages (up to 1000 tickets)
  const allTickets = await fetchTicketPages(1, 10);

  let bestMatch = null;
  let bestScore = 0;

  for (const ticket of allTickets) {
    const candidates = [
      ticket.custom_fields?.cf_customer_name || '',
      ticket.custom_fields?.cf_contact_person || '',
      ticket.requester?.name || ''
    ];
    const fuzzy = bestFuzzyMatch(trimmed, candidates);
    if (fuzzy && fuzzy.score > bestScore) {
      bestScore = fuzzy.score;
      bestMatch = ticket;
      if (bestScore >= 0.97) break;
    }
  }

  if (bestMatch) return { ticket: bestMatch, match_method: 'name' };
  return null;
}

// ─── Lookup by address ────────────────────────────────────────────────────────
async function resolveByAddress(address) {
  if (!address || address.trim().length < 4) return null;
  const lower = address.trim().toLowerCase();

  const allTickets = await fetchTicketPages(1, 5);
  const match = allTickets.find(t =>
    (t.custom_fields?.cf_job_address || '').toLowerCase().includes(lower)
  );
  if (match) return { ticket: match, match_method: 'address' };
  return null;
}

// ─── Master resolver ──────────────────────────────────────────────────────────
async function resolveTicket({ ticket_id, email, phone, name, address }) {
  if (ticket_id) { const r = await resolveByTicketId(ticket_id); if (r) return r; }
  if (email)     { const r = await resolveByEmail(email);         if (r) return r; }
  if (phone)     { const r = await resolveByPhone(phone);         if (r) return r; }
  if (name)      { const r = await resolveByName(name);           if (r) return r; }
  if (address)   { const r = await resolveByAddress(address);     if (r) return r; }
  return null;
}

// ─── Customer visible custom fields ──────────────────────────────────────────
function getCustomerVisibleCustomFields(ticket, ticketFields) {
  return (Array.isArray(ticketFields) ? ticketFields.filter(f => f.name?.startsWith('cf_') && f.displayed_to_customers) : [])
    .map(f => ({ name: f.name, label: f.label_for_customers || f.label, value: ticket.custom_fields?.[f.name] ?? null }))
    .filter(f => f.value !== null && f.value !== '');
}

// ─── Vercel Handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { ticket_id, email, phone, name, address } = body;

    if (!ticket_id && !email && !phone && !name && !address) {
      return res.status(200).json({
        found: false,
        spoken_summary: 'I need at least one of the following to find your request: a ticket number, name, email address, phone number, or street address.'
      });
    }

    const result = await resolveTicket({ ticket_id, email, phone, name, address });

    if (!result) {
      const attempted = [ticket_id&&'ticket number', email&&'email', phone&&'phone number', name&&'name', address&&'address'].filter(Boolean).join(', ');
      return res.status(200).json({
        found: false,
        lookup_attempted: true,
        lookup_fields_tried: attempted,
        spoken_summary: `I wasn't able to find a request matching the ${attempted} you provided. It's possible the details were submitted under a different name or contact. I can transfer you to our support team who can look into this further.`
      });
    }

    const { ticket, match_method, matched_contact } = result;
    const ticketFields        = await fdGet('/api/v2/admin/ticket_fields').catch(() => []);
    const agentStatusLabel    = mapStatusAgent(ticket.status);
    const customerStatusLabel = mapStatusCustomer(agentStatusLabel);
    const displayId           = ticket.display_id || ticket.id;
    const cf                  = ticket.custom_fields || {};
    const customerName        = cf.cf_customer_name || cf.cf_contact_person || matched_contact?.name || ticket.requester?.name || '';
    const requester           = ticket.requester || matched_contact || {};
    const company             = ticket.company || {};

    const spoken_summary = await buildSmartSpokenSummary(ticket, customerStatusLabel, agentStatusLabel);
    const brief_summary  = `Ticket ${displayId} — ${customerStatusLabel}. Customer: ${customerName}.`;

    return res.status(200).json({
      found: true,
      match_method,
      ticket_id: ticket.id,
      display_id: displayId,
      status: { raw_value: ticket.status, agent_label: agentStatusLabel, customer_value_label: customerStatusLabel },
      subject: ticket.subject?.trim() || '',
      requester: {
        id:    requester.id || null,
        name:  customerName,
        email: requester.email || '',
        phone: cf.cf_phone_number || requester.phone || requester.mobile || ''
      },
      company:  { id: company.id || null, name: company.name || cf.cf_company || '' },
      product:  { line: cf.cf_product_line248059 || cf.cf_product_line || '', model: cf.cf_model760094 || cf.cf_model365636 || cf.cf_model289096 || '', serial: cf.cf_serial_number || '' },
      job:      { id: cf.cf_job_id || '', address: cf.cf_job_address || '' },
      custom_fields_for_customers: getCustomerVisibleCustomFields(ticket, ticketFields),
      brief_summary,
      spoken_summary
    });

  } catch (err) {
    console.error('lookup-ticket error', err);
    return res.status(500).json({
      found: false,
      spoken_summary: "I wasn't able to retrieve your request details right now. Let me transfer you to our support team who can assist you directly."
    });
  }
}
