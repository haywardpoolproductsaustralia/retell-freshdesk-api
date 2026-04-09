const FRESHDESK_DOMAIN = process.env.FRESHDESK_DOMAIN;
const FRESHDESK_API_KEY = process.env.FRESHDESK_API_KEY;

function authHeader() {
  return 'Basic ' + Buffer.from(`${FRESHDESK_API_KEY}:X`).toString('base64');
}

function stripHtml(html) {
  return html ? html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function mapStatusAgent(status) {
  return {
    2: 'Open',
    3: 'Pending',
    4: 'Resolved',
    5: 'Closed'
  }[status] || `Status ${status}`;
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
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json'
    }
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return { ok: res.ok, status: res.status, data };
}

async function fdGet(path) {
  const res = await fdFetch(path);
  if (!res.ok) {
    throw new Error(`Freshdesk API error ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

async function resolveTicket(ticketInput) {
  const normalized = String(ticketInput || '').trim();
  if (!normalized) return null;

  const direct = await fdFetch(`/api/v2/tickets/${encodeURIComponent(normalized)}?include=requester,company`);
  if (direct.ok && direct.data) return direct.data;

  const search = await fdFetch(
    `/api/v2/search/tickets?query=${encodeURIComponent(`"display_id:${normalized}"`)}`
  );

  if (!search.ok || !search.data || !Array.isArray(search.data.results) || search.data.results.length === 0) {
    return null;
  }

  const internalId = search.data.results[0].id;
  if (!internalId) return null;

  return await fdGet(`/api/v2/tickets/${internalId}?include=requester,company`);
}

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
  const lastSpace = shortened.lastIndexOf(' ');
  return `${shortened.slice(0, lastSpace).trim()}...`;
}

function buildCustomerSpokenSummary(ticketId, customerStatusLabel, subject, latestUpdate) {
  const parts = [
    `I've found your request.`,
    `Ticket ${ticketId} is currently ${customerStatusLabel}.`
  ];
  if (subject && subject !== 'No subject recorded') {
    parts.push(`This is regarding ${subject}.`);
  }
  if (latestUpdate) {
    parts.push(`The latest update is: ${latestUpdate}`);
  } else {
    parts.push(`Our team is currently working on it.`);
  }
  return parts.join(' ');
}

function getCustomerVisibleCustomFields(ticket, ticketFields) {
  const customFieldMeta = Array.isArray(ticketFields)
    ? ticketFields.filter(f => f.name?.startsWith('cf_'))
    : [];

  return customFieldMeta
    .filter(f => f.displayed_to_customers)
    .map(f => {
      const value = ticket.custom_fields?.[f.name];
      return {
        name: f.name,
        label_for_agents: f.label,
        label_for_customers: f.label_for_customers || f.label,
        value: value ?? null
      };
    })
    .filter(f => f.value !== null && f.value !== '');
}

async function getLatestCustomerUpdate(ticketId) {
  const res = await fdFetch(`/api/v2/tickets/${ticketId}/conversations`);
  if (!res.ok || !Array.isArray(res.data)) return '';

  const ordered = [...res.data].reverse();
  for (const convo of ordered) {
    if (convo.private === true) continue;
    const raw = convo.body_text || convo.plain_text_body || convo.body || '';
    const cleaned = summarizeCustomerUpdate(raw);
    if (cleaned) return cleaned;
  }
  return '';
}

// ─── Vercel Serverless Handler ────────────────────────────────────────────────
export default async function handler(req, res) {
  // Allow Retell (and browsers) to call this endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const ticketInput = body?.ticket_id;

    if (!ticketInput) {
      return res.status(200).json({
        found: false,
        spoken_summary: 'Please provide a ticket number.'
      });
    }

    const ticket = await resolveTicket(ticketInput);

    if (!ticket) {
      return res.status(200).json({
        found: false,
        spoken_summary: "I couldn't find that ticket. Please check the number and try again."
      });
    }

    const ticketFields = await fdGet('/api/v2/admin/ticket_fields');

    const statusField = Array.isArray(ticketFields)
      ? ticketFields.find(f => f.name === 'status') : null;
    const subjectField = Array.isArray(ticketFields)
      ? ticketFields.find(f => f.name === 'subject') : null;
    const descriptionField = Array.isArray(ticketFields)
      ? ticketFields.find(f => f.name === 'description') : null;

    const agentStatusLabel = mapStatusAgent(ticket.status);
    const customerStatusLabel = mapStatusCustomer(agentStatusLabel);

    const subject = ticket.subject?.trim() || 'No subject recorded';
    const description =
      stripHtml(ticket.description_text || ticket.description || '') ||
      'No description recorded';

    const requester = ticket.requester || {};
    const company = ticket.company || {};

    const customerVisibleCustomFields = getCustomerVisibleCustomFields(ticket, ticketFields);

    const conversationUpdate = await getLatestCustomerUpdate(ticket.id).catch(() => '');
    const descriptionUpdate =
      description !== 'No description recorded'
        ? summarizeCustomerUpdate(description)
        : '';

    const latestUpdate = conversationUpdate || descriptionUpdate || '';

    const brief_summary = latestUpdate
      ? `Ticket ${ticket.display_id || ticket.id} is currently ${customerStatusLabel}. Latest update: ${latestUpdate}`
      : `Ticket ${ticket.display_id || ticket.id} is currently ${customerStatusLabel}.`;

    const spoken_summary = buildCustomerSpokenSummary(
      ticket.display_id || ticket.id,
      customerStatusLabel,
      subject,
      latestUpdate
    );

    return res.status(200).json({
      found: true,
      ticket_id: ticket.id,
      display_id: ticket.display_id || null,
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
        id: requester.id || null,
        name: requester.name || '',
        email: requester.email || '',
        phone: requester.phone || requester.mobile || ''
      },
      company: {
        id: company.id || null,
        name: company.name || ''
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
      spoken_summary: "I couldn't retrieve the ticket details right now."
    });
  }
}
