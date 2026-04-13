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
    'Waiting information': 'Waiting information',
    'Waiting for Parts': 'Waiting for Parts',
    Resolved: 'Resolved',
    Closed: 'Closed',
    'Job Complete waiting': 'Job Complete waiting',
    'Waiting for arrival': 'Waiting for arrival',
    'Pending payment': 'Pending payment',
    'Waiting supplier claim': 'Waiting supplier claim'
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

// ─── Scan recent tickets and match against custom fields ──────────────────────
// Freshdesk does not allow searching custom fields via its search API,
// so we page through recent tickets and match locally.
async function scanTicketsByCustomField(matchFn, maxPages = 5) {
  let page = 1;
  while (page <= maxPages) {
    const res = await fdFetch(
      `/api/v2/tickets?per_page=100&page=${page}&order_by=created_at&order_type=desc&include=requester,company`
    );
    if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) break;
    const match = res.data.find(matchFn);
    if (match) return match;
    if (res.data.length < 100) break;
    page++;
  }
  return null;
}

// ─── Lookup by ticket number ──────────────────────────────────────────────────
async function resolveByTicketId(ticketInput) {
  const normalized = String(ticketInput || '').trim().replace(/^#/, '');
  if (!normalized || !/^\d+$/.test(normalized)) return null;

  const direct = await fdFetch(`/api/v2/tickets/${normalized}?include=requester,company`);
  if (direct.ok && direct.data?.id) return { ticket: direct.data, match_method: 'ticket_id' };

  const searchQuery = encodeURIComponent(`display_id:${normalized}`);
  const search = await fdFetch(`/api/v2/search/tickets?query="${searchQuery}"`);
  if (search.ok && search.data?.results?.length > 0) {
    const t = await fdGet(`/api/v2/tickets/${search.data.results[0].id}?include=requester,company`);
    return { ticket: t, match_method: 'ticket_id' };
  }
  return null;
}

// ─── Lookup by email ──────────────────────────────────────────────────────────
async function resolveByEmail(email) {
  if (!email || !email.includes('@')) return null;
  const lower = email.trim().toLowerCase();

  // 1. Standard contact lookup by requester email
  const contacts = await fdFetch(`/api/v2/contacts?email=${encodeURIComponent(lower)}`);
  if (contacts.ok && Array.isArray(contacts.data) && contacts.data.length > 0) {
    const tickets = await fdFetch(
      `/api/v2/tickets?requester_id=${contacts.data[0].id}&order_by=created_at&order_type=desc&per_page=1&include=requester,company`
    );
    if (tickets.ok && Array.isArray(tickets.data) && tickets.data.length > 0) {
      return { ticket: tickets.data[0], match_method: 'email', matched_contact: contacts.data[0] };
    }
  }

  // 2. Freshdesk search API
  const search = await fdFetch(
    `/api/v2/search/tickets?query="${encodeURIComponent(`email:${lower}`)}"`
  );
  if (search.ok && search.data?.results?.length > 0) {
    const t = await fdGet(`/api/v2/tickets/${search.data.results[0].id}?include=requester,company`);
    return { ticket: t, match_method: 'email' };
  }

  // 3. Scan custom field cf_retailer_email (tickets submitted by retailer on behalf of customer)
  const byRetailerEmail = await scanTicketsByCustomField(t =>
    t.custom_fields?.cf_retailer_email?.toLowerCase() === lower
  );
  if (byRetailerEmail) return { ticket: byRetailerEmail, match_method: 'email' };

  return null;
}

// ─── Lookup by phone ──────────────────────────────────────────────────────────
async function resolveByPhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s\-().+]/g, '');
  if (cleaned.length < 6) return null;

  // Build AU variants
  const variants = [cleaned];
  if (cleaned.startsWith('0')) variants.push('61' + cleaned.slice(1));
  if (cleaned.startsWith('61')) variants.push('0' + cleaned.slice(2));
  const last8 = cleaned.slice(-8); // last 8 digits for fuzzy match

  // 1. Standard contact lookup by phone/mobile
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

  // 2. Scan custom field cf_phone_number (customer phone stored on ticket)
  const byCustomPhone = await scanTicketsByCustomField(t => {
    const val = (t.custom_fields?.cf_phone_number || '').replace(/\D/g, '');
    return val.length >= 6 && val.endsWith(last8);
  });
  if (byCustomPhone) return { ticket: byCustomPhone, match_method: 'phone' };

  // 3. Also check requester phone on the ticket object itself
  const byRequesterPhone = await scanTicketsByCustomField(t => {
    const val = (t.requester?.phone || t.requester?.mobile || '').replace(/\D/g, '');
    return val.length >= 6 && val.endsWith(last8);
  });
  if (byRequesterPhone) return { ticket: byRequesterPhone, match_method: 'phone' };

  return null;
}

// ─── Lookup by name ───────────────────────────────────────────────────────────
async function resolveByName(name) {
  if (!name || name.trim().length < 2) return null;
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();

  // 1. Standard contact search
  const contacts = await fdFetch(`/api/v2/contacts?query=${encodeURIComponent(trimmed)}`);
  if (contacts.ok && Array.isArray(contacts.data) && contacts.data.length > 0) {
    const best = contacts.data.find(c =>
      c.name?.toLowerCase() === lower || c.name?.toLowerCase().startsWith(lower)
    ) || contacts.data[0];
    const tickets = await fdFetch(
      `/api/v2/tickets?requester_id=${best.id}&order_by=created_at&order_type=desc&per_page=1&include=requester,company`
    );
    if (tickets.ok && Array.isArray(tickets.data) && tickets.data.length > 0) {
      return { ticket: tickets.data[0], match_method: 'name', matched_contact: best };
    }
  }

  // 2. Freshdesk search API by requester name
  const search = await fdFetch(
    `/api/v2/search/tickets?query="${encodeURIComponent(`requester:"${trimmed}"`)}"`
  );
  if (search.ok && search.data?.results?.length > 0) {
    const t = await fdGet(`/api/v2/tickets/${search.data.results[0].id}?include=requester,company`);
    return { ticket: t, match_method: 'name' };
  }

  // 3. Scan custom field cf_customer_name
  // This is the actual end-customer name when ticket was submitted by a retailer
  const byCustomerName = await scanTicketsByCustomField(t => {
    const val = (t.custom_fields?.cf_customer_name || '').toLowerCase();
    return val && (val === lower || val.includes(lower) || lower.includes(val));
  });
  if (byCustomerName) return { ticket: byCustomerName, match_method: 'name' };

  // 4. Scan custom field cf_contact_person (retailer contact person)
  const byContactPerson = await scanTicketsByCustomField(t => {
    const val = (t.custom_fields?.cf_contact_person || '').toLowerCase();
    return val && (val === lower || val.includes(lower) || lower.includes(val));
  });
  if (byContactPerson) return { ticket: byContactPerson, match_method: 'name' };

  return null;
}

// ─── Lookup by street address ─────────────────────────────────────────────────
async function resolveByAddress(address) {
  if (!address || address.trim().length < 4) return null;
  const lower = address.trim().toLowerCase();

  // 1. Freshdesk full-text search
  const search = await fdFetch(
    `/api/v2/search/tickets?query=${encodeURIComponent(`"${address.trim()}"`)}`
  );
  if (search.ok && search.data?.results?.length > 0) {
    const match = search.data.results.find(t =>
      (t.custom_fields?.cf_job_address || '').toLowerCase().includes(lower)
    ) || search.data.results[0];
    if (match?.id) {
      const t = await fdGet(`/api/v2/tickets/${match.id}?include=requester,company`);
      return { ticket: t, match_method: 'address' };
    }
  }

  // 2. Scan custom field cf_job_address directly
  const byAddress = await scanTicketsByCustomField(t => {
    const val = (t.custom_fields?.cf_job_address || '').toLowerCase();
    return val && val.includes(lower);
  });
  if (byAddress) return { ticket: byAddress, match_method: 'address' };

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

// ─── Text helpers ─────────────────────────────────────────────────────────────
function sanitizeCustomerUpdate(text) {
  if (!text) return '';
  let cleaned = stripHtml(text);
  cleaned = cleaned
    .replace(/\burgent\b\s*:?/gi, '')
    .replace(/\bplease allocate\b.*$/gi, '')
    .replace(/\ballocate to\b.*$/gi, '')
    .replace(/\bassign(?:ed)? to\b.*$/gi, '')
    .replace(/\bhandover completed\b.*$/gi, '')
    .replace(/\bsubmitted by\b.*$/gi, '')
    .replace(/\btoday'?s date is\b.*$/gi, '')
    .replace(/\bname is\b.*$/gi, '')
    .replace(/\bemail\b.*$/gi, '')
    .replace(/\bphone\b.*$/gi, '')
    .replace(/\bmobile\b.*$/gi, '')
    .replace(/\bpriority\b.*$/gi, '')
    .replace(/\binternal\b.*$/gi, '')
    .replace(/\bgroup id\b.*$/gi, '')
    .replace(/\bagent id\b.*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned;
}

function summarizeCustomerUpdate(text) {
  const cleaned = sanitizeCustomerUpdate(text);
  if (!cleaned) return '';
  if (cleaned.length <= 160) return cleaned;
  const shortened = cleaned.slice(0, 160);
  const lastSentence = shortened.lastIndexOf('.');
  if (lastSentence > 80) return shortened.slice(0, lastSentence + 1).trim();
  return `${shortened.slice(0, shortened.lastIndexOf(' ')).trim()}...`;
}

function buildSpokenSummary(displayId, customerStatusLabel, subject, latestUpdate, matchMethod, requesterName) {
  const parts = [`Here are the details of your request.`];
  if (requesterName && matchMethod !== 'ticket_id') {
    parts.push(`I've matched this to the account for ${requesterName}.`);
  }
  parts.push(`Ticket ${displayId} is currently ${customerStatusLabel}.`);
  if (subject && subject !== 'No subject recorded') parts.push(`This is regarding ${subject}.`);
  parts.push(latestUpdate ? `The latest update is: ${latestUpdate}` : `Our team is currently working on it.`);
  return parts.join(' ');
}

function getCustomerVisibleCustomFields(ticket, ticketFields) {
  return (Array.isArray(ticketFields) ? ticketFields.filter(f => f.name?.startsWith('cf_')) : [])
    .filter(f => f.displayed_to_customers)
    .map(f => ({
      name: f.name,
      label_for_agents: f.label,
      label_for_customers: f.label_for_customers || f.label,
      value: ticket.custom_fields?.[f.name] ?? null
    }))
    .filter(f => f.value !== null && f.value !== '');
}

async function getLatestCustomerUpdate(ticketId) {
  const res = await fdFetch(`/api/v2/tickets/${ticketId}/conversations`);
  if (!res.ok || !Array.isArray(res.data)) return '';
  for (const convo of [...res.data].reverse()) {
    if (convo.private) continue;
    const raw = convo.body_text || convo.plain_text_body || convo.body || '';
    const cleaned = summarizeCustomerUpdate(raw);
    if (cleaned) return cleaned;
  }
  return '';
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
        lookup_attempted: false,
        spoken_summary: 'I need at least one of the following to find your request: a ticket number, name, email address, phone number, or street address.'
      });
    }

    const result = await resolveTicket({ ticket_id, email, phone, name, address });

    if (!result) {
      const attempted = [
        ticket_id && 'ticket number',
        email     && 'email address',
        phone     && 'phone number',
        name      && 'name',
        address   && 'address'
      ].filter(Boolean).join(', ');

      return res.status(200).json({
        found: false,
        lookup_attempted: true,
        lookup_fields_tried: attempted,
        spoken_summary: `I couldn't find a request matching the ${attempted} provided. Please double-check the details, or I can transfer you to our team for help.`
      });
    }

    const { ticket, match_method, matched_contact } = result;
    const ticketFields = await fdGet('/api/v2/admin/ticket_fields');

    const statusField      = Array.isArray(ticketFields) ? ticketFields.find(f => f.name === 'status')      : null;
    const subjectField     = Array.isArray(ticketFields) ? ticketFields.find(f => f.name === 'subject')     : null;
    const descriptionField = Array.isArray(ticketFields) ? ticketFields.find(f => f.name === 'description') : null;

    const agentStatusLabel    = mapStatusAgent(ticket.status);
    const customerStatusLabel = mapStatusCustomer(agentStatusLabel);

    const subject     = ticket.subject?.trim() || 'No subject recorded';
    const description = stripHtml(ticket.description_text || ticket.description || '') || 'No description recorded';
    const displayId   = ticket.display_id || ticket.id;

    // Use cf_customer_name if available (more accurate than requester which may be retailer)
    const customerName = ticket.custom_fields?.cf_customer_name
      || ticket.custom_fields?.cf_contact_person
      || matched_contact?.name
      || ticket.requester?.name
      || '';

    const requester = ticket.requester || matched_contact || {};
    const company   = ticket.company || {};

    const customerVisibleCustomFields = getCustomerVisibleCustomFields(ticket, ticketFields);
    const conversationUpdate = await getLatestCustomerUpdate(ticket.id).catch(() => '');
    const descriptionUpdate  = description !== 'No description recorded' ? summarizeCustomerUpdate(description) : '';
    const latestUpdate       = conversationUpdate || descriptionUpdate || '';

    const brief_summary  = latestUpdate
      ? `Ticket ${displayId} is currently ${customerStatusLabel}. Latest update: ${latestUpdate}`
      : `Ticket ${displayId} is currently ${customerStatusLabel}.`;

    const spoken_summary = buildSpokenSummary(
      displayId, customerStatusLabel, subject, latestUpdate, match_method, customerName
    );

    return res.status(200).json({
      found: true,
      match_method,
      ticket_id: ticket.id,
      display_id: displayId,
      status: {
        raw_value: ticket.status,
        agent_label: agentStatusLabel,
        customer_field_label: statusField?.label_for_customers || 'Status',
        customer_value_label: customerStatusLabel
      },
      subject: {
        value: subject,
        customer_label: subjectField?.label_for_customers || 'Subject'
      },
      description: {
        value: description,
        customer_label: descriptionField?.label_for_customers || 'Description'
      },
      requester: {
        id:    requester.id    || null,
        name:  customerName,
        email: requester.email || '',
        phone: ticket.custom_fields?.cf_phone_number || requester.phone || requester.mobile || ''
      },
      company: {
        id:   company.id   || null,
        name: company.name || ticket.custom_fields?.cf_company || ''
      },
      custom_fields_for_customers: customerVisibleCustomFields,
      latest_update: latestUpdate,
      brief_summary,
      spoken_summary,
      raw_ticket: ticket
    });

  } catch (err) {
    console.error('lookup-ticket error', err);
    return res.status(500).json({
      found: false,
      spoken_summary: "I couldn't retrieve the details right now. Please try again or I can connect you with our team."
    });
  }
}
