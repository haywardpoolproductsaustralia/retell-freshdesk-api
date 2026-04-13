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

// ─── Format date for spoken output ───────────────────────────────────────────
function formatSpokenDate(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date)) return null;

  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays <= 6) return `${diffDays} days ago`;

  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ─── Get all conversations for a ticket (excluding private notes) ─────────────
async function getPublicConversations(ticketId) {
  const res = await fdFetch(`/api/v2/tickets/${ticketId}/conversations`);
  if (!res.ok || !Array.isArray(res.data)) return [];
  return res.data.filter(c => !c.private);
}

// ─── Extract plain text from conversation ────────────────────────────────────
function extractConversationText(convo) {
  return stripHtml(convo.body_text || convo.plain_text_body || convo.body || '');
}

// ─── Get latest meaningful public update ─────────────────────────────────────
async function getLatestUpdate(ticketId, description) {
  const conversations = await getPublicConversations(ticketId);

  // Most recent public conversation first
  const ordered = [...conversations].reverse();
  for (const convo of ordered) {
    const text = extractConversationText(convo);
    if (text && text.length > 10) {
      return {
        text: text.slice(0, 500),
        date: convo.created_at,
        source: 'conversation'
      };
    }
  }

  // Fall back to description
  const descText = stripHtml(description || '');
  if (descText && descText.length > 5) {
    return { text: descText.slice(0, 500), date: null, source: 'description' };
  }

  return null;
}

// ─── Build the smart spoken summary ──────────────────────────────────────────
async function buildSmartSpokenSummary(ticket, customerStatusLabel, agentStatusLabel) {
  const cf = ticket.custom_fields || {};

  // Customer name — prefer custom field over requester (retailer may be requester)
  const customerName = cf.cf_customer_name || cf.cf_contact_person || ticket.requester?.name || '';

  // Product details
  const productLine = cf.cf_product_line248059 || cf.cf_product_line || '';
  const productModel = cf.cf_model760094 || cf.cf_model365636 || cf.cf_model289096 || '';
  const productDesc = [productLine, productModel].filter(Boolean).join(' ');

  // Dates
  const createdDate = formatSpokenDate(ticket.created_at);
  const updatedDate = formatSpokenDate(ticket.updated_at);

  // Issue description from subject or description_text
  const issueText = ticket.subject?.trim() ||
    stripHtml(ticket.description_text || ticket.description || '').slice(0, 120) || '';

  // Latest update
  const latestUpdate = await getLatestUpdate(
    ticket.id,
    ticket.description_text || ticket.description
  );

  // Parts replaced
  const partsReplaced = cf.cf_parts_replaced || '';

  // Build the summary naturally
  const parts = [];

  // Opening
  parts.push(`Alright, I've found your request.`);

  // Ticket creation context
  if (createdDate && issueText && issueText !== 'No subject recorded') {
    if (productDesc) {
      parts.push(`Your ticket was created ${createdDate} regarding an issue with your ${productDesc}${issueText ? ' — ' + issueText.toLowerCase() : ''}.`);
    } else {
      parts.push(`Your ticket was created ${createdDate}${issueText ? ' regarding ' + issueText.toLowerCase() : ''}.`);
    }
  } else if (productDesc) {
    parts.push(`This request relates to your ${productDesc}.`);
  }

  // Current status
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

  // Latest update context
  if (latestUpdate) {
    const updateDateStr = latestUpdate.date ? formatSpokenDate(latestUpdate.date) : null;
    const updateIntro = updateDateStr ? `The last update was ${updateDateStr}` : `The latest update`;

    // Summarise the update intelligently rather than reading it verbatim
    const updateText = latestUpdate.text;

    if (partsReplaced && agentStatusLabel !== 'Resolved' && agentStatusLabel !== 'Closed') {
      parts.push(`${updateIntro} — parts ${partsReplaced} have been identified for this repair.`);
    } else if (updateText.toLowerCase().includes('waiting') || updateText.toLowerCase().includes('part')) {
      parts.push(`${updateIntro} — the team is waiting on parts or a supplier response before they can proceed.`);
    } else if (updateText.toLowerCase().includes('scheduled') || updateText.toLowerCase().includes('appointment') || updateText.toLowerCase().includes('booked')) {
      parts.push(`${updateIntro} — a technician appointment has been scheduled.`);
    } else if (updateText.toLowerCase().includes('complete') || updateText.toLowerCase().includes('resolved') || updateText.toLowerCase().includes('fixed')) {
      parts.push(`${updateIntro} — the repair has been completed.`);
    } else if (updateText.toLowerCase().includes('review') || updateText.toLowerCase().includes('assess')) {
      parts.push(`${updateIntro} — the team has reviewed your case and is determining the next steps.`);
    } else if (updateText.length > 20) {
      // Trim and clean for spoken output
      const spoken = updateText.slice(0, 200).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      parts.push(`${updateIntro} — ${spoken}`);
    }
  }

  // Next steps / what caller should do
  if (agentStatusLabel === 'Resolved' || agentStatusLabel === 'Closed') {
    parts.push(`If you have any further concerns about this issue, please don't hesitate to call us back.`);
  } else if (customerStatusLabel === 'Waiting for more information') {
    parts.push(`Our team will need some additional information from you. Someone from Hayward will be in touch shortly.`);
  } else {
    parts.push(`There's nothing you need to do right now. As soon as there's an update, someone from the Hayward team will reach out to you directly.`);
  }

  return parts.join(' ');
}

// ─── Scan tickets page by page with a match function ─────────────────────────
async function scanAllTickets(matchFn, maxPages = 10) {
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

// ─── Deep search: scan ticket + its conversations for any text ───────────────
async function deepSearchTickets(needle, maxPages = 10) {
  if (!needle || needle.length < 4) return null;
  const lower = needle.trim().toLowerCase();
  let page = 1;

  while (page <= maxPages) {
    const res = await fdFetch(
      `/api/v2/tickets?per_page=100&page=${page}&order_by=created_at&order_type=desc&include=requester,company`
    );
    if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) break;

    for (const ticket of res.data) {
      // Search all text fields on the ticket
      const searchableText = [
        ticket.subject || '',
        stripHtml(ticket.description_text || ticket.description || ''),
        ticket.requester?.email || '',
        ticket.requester?.phone || '',
        ticket.requester?.mobile || '',
        ticket.requester?.name || '',
        // Custom fields
        ticket.custom_fields?.cf_customer_name || '',
        ticket.custom_fields?.cf_contact_person || '',
        ticket.custom_fields?.cf_phone_number || '',
        ticket.custom_fields?.cf_retailer_email || '',
        ticket.custom_fields?.cf_job_address || '',
        ticket.custom_fields?.cf_company || '',
        ticket.custom_fields?.cf_serial_number || '',
      ].join(' ').toLowerCase();

      if (searchableText.includes(lower)) return ticket;
    }

    if (res.data.length < 100) break;
    page++;
  }
  return null;
}

// ─── Deep search including conversations (slower, used as last resort) ────────
async function deepSearchWithConversations(needle, maxPages = 5) {
  if (!needle || needle.length < 4) return null;
  const lower = needle.trim().toLowerCase();
  let page = 1;

  while (page <= maxPages) {
    const res = await fdFetch(
      `/api/v2/tickets?per_page=100&page=${page}&order_by=created_at&order_type=desc`
    );
    if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) break;

    for (const ticket of res.data) {
      // Fetch conversations for each ticket and search them
      const convRes = await fdFetch(`/api/v2/tickets/${ticket.id}/conversations`);
      if (convRes.ok && Array.isArray(convRes.data)) {
        for (const convo of convRes.data) {
          if (convo.private) continue; // skip private notes
          const text = extractConversationText(convo).toLowerCase();
          if (text.includes(lower)) {
            // Get full ticket with requester
            return await fdGet(`/api/v2/tickets/${ticket.id}?include=requester,company`);
          }
        }
      }
    }

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

  // 1. Standard contact lookup
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

  // 3. Deep scan all ticket fields including custom fields
  const byDeep = await deepSearchTickets(lower);
  if (byDeep) return { ticket: byDeep, match_method: 'email' };

  // 4. Last resort: search conversations too
  const byConversation = await deepSearchWithConversations(lower);
  if (byConversation) return { ticket: byConversation, match_method: 'email' };

  return null;
}

// ─── Lookup by phone ──────────────────────────────────────────────────────────
async function resolveByPhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/[\s\-().+]/g, '');
  if (cleaned.length < 6) return null;

  const variants = [cleaned];
  if (cleaned.startsWith('0')) variants.push('61' + cleaned.slice(1));
  if (cleaned.startsWith('61')) variants.push('0' + cleaned.slice(2));
  const last8 = cleaned.slice(-8);

  // 1. Standard contact lookup
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

  // 2. Deep scan all ticket fields for phone number variants
  for (const variant of [last8, ...variants]) {
    const byDeep = await deepSearchTickets(variant);
    if (byDeep) return { ticket: byDeep, match_method: 'phone' };
  }

  // 3. Search conversations
  const byConversation = await deepSearchWithConversations(last8);
  if (byConversation) return { ticket: byConversation, match_method: 'phone' };

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

  // 2. Freshdesk search
  const search = await fdFetch(
    `/api/v2/search/tickets?query="${encodeURIComponent(`requester:"${trimmed}"`)}"`
  );
  if (search.ok && search.data?.results?.length > 0) {
    const t = await fdGet(`/api/v2/tickets/${search.data.results[0].id}?include=requester,company`);
    return { ticket: t, match_method: 'name' };
  }

  // 3. Deep scan custom fields cf_customer_name and cf_contact_person
  const byDeep = await deepSearchTickets(lower);
  if (byDeep) return { ticket: byDeep, match_method: 'name' };

  return null;
}

// ─── Lookup by address ────────────────────────────────────────────────────────
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

  // 2. Deep scan cf_job_address
  const byDeep = await deepSearchTickets(lower);
  if (byDeep) return { ticket: byDeep, match_method: 'address' };

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
        spoken_summary: `I wasn't able to find a request matching the ${attempted} you provided. It's possible the details were submitted under a different name or contact. I can transfer you to our support team who can look into this further — would that help?`
      });
    }

    const { ticket, match_method, matched_contact } = result;
    const ticketFields = await fdGet('/api/v2/admin/ticket_fields').catch(() => []);

    const agentStatusLabel    = mapStatusAgent(ticket.status);
    const customerStatusLabel = mapStatusCustomer(agentStatusLabel);
    const displayId           = ticket.display_id || ticket.id;
    const cf                  = ticket.custom_fields || {};

    const customerName = cf.cf_customer_name || cf.cf_contact_person
      || matched_contact?.name || ticket.requester?.name || '';

    const requester = ticket.requester || matched_contact || {};
    const company   = ticket.company || {};

    // Build smart spoken summary
    const spoken_summary = await buildSmartSpokenSummary(ticket, customerStatusLabel, agentStatusLabel);

    // Brief text summary for logging/debugging
    const brief_summary = `Ticket ${displayId} — ${customerStatusLabel}. Customer: ${customerName}.`;

    // Customer-visible custom fields
    const customFieldMeta = Array.isArray(ticketFields)
      ? ticketFields.filter(f => f.name?.startsWith('cf_') && f.displayed_to_customers)
      : [];
    const custom_fields_for_customers = customFieldMeta.map(f => ({
      name: f.name,
      label: f.label_for_customers || f.label,
      value: cf[f.name] ?? null
    })).filter(f => f.value !== null && f.value !== '');

    return res.status(200).json({
      found: true,
      match_method,
      ticket_id: ticket.id,
      display_id: displayId,
      status: {
        raw_value: ticket.status,
        agent_label: agentStatusLabel,
        customer_value_label: customerStatusLabel
      },
      subject: ticket.subject?.trim() || '',
      requester: {
        id:    requester.id    || null,
        name:  customerName,
        email: requester.email || '',
        phone: cf.cf_phone_number || requester.phone || requester.mobile || ''
      },
      company: {
        id:   company.id   || null,
        name: company.name || cf.cf_company || ''
      },
      product: {
        line:  cf.cf_product_line248059 || cf.cf_product_line || '',
        model: cf.cf_model760094 || cf.cf_model365636 || cf.cf_model289096 || '',
        serial: cf.cf_serial_number || ''
      },
      job: {
        id:      cf.cf_job_id || '',
        address: cf.cf_job_address || ''
      },
      custom_fields_for_customers,
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
