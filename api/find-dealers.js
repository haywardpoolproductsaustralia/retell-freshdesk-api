// Dealer locator — finds nearest Hayward dealers by postcode
// Data files are loaded from /data/ folder in the same repo

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load data files — bundled with the deployment
let DEALERS = null;
let POSTCODES = null;

function loadData() {
  if (DEALERS && POSTCODES) return;
  try {
    DEALERS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/dealers.json'), 'utf8'));
    POSTCODES = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/postcode_coords.json'), 'utf8'));
  } catch (e) {
    console.error('Failed to load dealer data:', e.message);
    DEALERS = [];
    POSTCODES = {};
  }
}

// ─── Haversine distance (km) ──────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Clean phone — take first number only ────────────────────────────────────
function cleanPhone(phone) {
  if (!phone) return '';
  return phone.trim().split(/\s{2,}/)[0].trim();
}

// ─── Find nearest dealers ─────────────────────────────────────────────────────
function findNearestDealers(callerPostcode, count = 5) {
  const callerCoords = POSTCODES[callerPostcode];
  if (!callerCoords) return null;

  const [callerLat, callerLng] = callerCoords;

  return DEALERS
    .map(dealer => {
      const coords = POSTCODES[dealer.postcode];
      if (!coords) return null;
      const km = haversineKm(callerLat, callerLng, coords[0], coords[1]);
      return { ...dealer, distance_km: Math.round(km) };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, count);
}

// ─── Spoken summary (top 3 read aloud) ───────────────────────────────────────
function buildSpokenSummary(dealers, postcode) {
  if (!dealers.length) {
    return `I wasn't able to find any dealers near postcode ${postcode}. Please visit the Hayward Australia website and use the Dealer Locator.`;
  }

  const top3 = dealers.slice(0, 3);
  const parts = [`I found ${dealers.length} dealers near you. Here are the closest ones.`];

  top3.forEach((d, i) => {
    const phone = cleanPhone(d.phone);
    const dist = d.distance_km < 5 ? 'very close to you' : `about ${d.distance_km} kilometres away`;
    const phoneText = phone ? ` Their phone number is ${phone}.` : '';
    parts.push(`Number ${i + 1}: ${d.name}, located in ${d.suburb}, ${dist}.${phoneText}`);
  });

  parts.push(`Would you like me to send the full list with addresses to your mobile as a text message?`);

  return parts.join(' ');
}

// ─── SMS text ─────────────────────────────────────────────────────────────────
function buildSmsText(dealers, postcode) {
  const lines = [`Hayward dealers near ${postcode}:`];
  dealers.forEach((d, i) => {
    const phone = cleanPhone(d.phone);
    lines.push(`${i + 1}. ${d.name}`);
    lines.push(`   ${d.address}, ${d.suburb} ${d.postcode}`);
    if (phone) lines.push(`   Ph: ${phone}`);
    lines.push(`   (${d.distance_km}km away)`);
  });
  lines.push(`More at the Hayward Australia website.`);
  return lines.join('\n');
}

// ─── Vercel Handler ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    loadData();

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const postcode = String(body?.postcode || '').trim().replace(/\D/g, '');

    if (!postcode || postcode.length !== 4) {
      return res.status(200).json({
        found: false,
        spoken_summary: "I need a valid four digit Australian postcode to find dealers near you. Could you give me your postcode?"
      });
    }

    const dealers = findNearestDealers(postcode, 5);

    if (!dealers) {
      return res.status(200).json({
        found: false,
        spoken_summary: `I wasn't able to find postcode ${postcode} in my records. Could you double check?`
      });
    }

    return res.status(200).json({
      found: true,
      postcode,
      dealer_count: dealers.length,
      dealers,
      spoken_summary: buildSpokenSummary(dealers, postcode),
      sms_text: buildSmsText(dealers, postcode),
      nearest_dealer: dealers[0] || null
    });

  } catch (err) {
    console.error('find-dealers error', err);
    return res.status(500).json({
      found: false,
      spoken_summary: "I wasn't able to search for dealers right now. Please visit the Hayward Australia website and use the Dealer Locator."
    });
  }
}
