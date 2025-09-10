// server/index.js
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(cors());

// --- Request options: look like a real browser ---
const HTTP = {
  timeout: 20000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  },
  maxRedirects: 5
};

async function fetchHtml(url) {
  const { data } = await axios.get(url, HTTP);
  return data;
}

// Utility: take a short window of text *after* a label and pull exactly N digits.
// Skips currency/prize lines.
function takeNDigitsAfterLabel(text, label, n) {
  const L = (label || '').toLowerCase();
  const full = (text || '').replace(/\s+/g, ' ');
  const low  = full.toLowerCase();

  const idx = low.indexOf(L);
  if (idx < 0) return null;

  // look at the next ~200 chars after the label
  let window = full.slice(idx, idx + 200);

  // quick guards: ignore typical non-result wording
  if (/\$|\bprize\b|\bpayout\b|\bhow to\b/i.test(window)) {
    // trim those lines out crudely
    window = window.replace(/\$[0-9,]+/g, ' ');
    window = window.replace(/\b(prize|payout|how to)[^|]*/gi, ' ');
  }

  // collect digits until we hit N of them
  const digits = (window.match(/\d/g) || []).join('');
  const out = digits.slice(0, n);
  return out.length === n ? out : null;
}

// Parse the "Latest numbers" section and try to extract by label (Midday/Evening/Day/Night)
function extractFromLatestNumbers(html, label, n) {
  const $ = cheerio.load(html);

  // Find a section that has a heading like "Latest numbers"
  const section = $('section').filter((_, el) => {
    const h = $(el).find('h1,h2,h3').first().text().trim().toLowerCase();
    return h.includes('latest') && h.includes('number');
  }).first();

  // Fallback: whole page
  const scopeText = section.length ? section.text() : $.root().text();

  // 1) Best effort: take first N digits following the label inside the scope
  let val = takeNDigitsAfterLabel(scopeText, label, n);
  if (val) return val;

  // 2) Look through likely result rows that contain the label
  const rows = section.find('li, article, div').filter((_, el) =>
    $(el).text().toLowerCase().includes(label.toLowerCase())
  );
  for (const el of rows.toArray()) {
    const t = $(el).text().replace(/\s+/g, ' ');
    if (/\$|\bprize\b|\bpayout\b|\bhow to\b/i.test(t)) continue;
    const d = (t.match(/\d/g) || []).join('');
    if (d.length >= n) return d.slice(0, n);
  }

  // 3) As a last resort, scan the section for the first clean N-digit token
  const m = scopeText.match(new RegExp(`(?<!\\$)\\b\\d{${n}}\\b`));
  return m ? m[0] : null;
}

// Try each URL variant until one gives a value (no throws)
async function tryUrls(urls, label, n, tag) {
  for (const u of urls) {
    try {
      const html = await fetchHtml(u);
      const digits = extractFromLatestNumbers(html, label, n);
      if (digits) return digits;
    } catch (e) {
      console.log(`[WARN] ${tag} failed ${u} -> ${e?.response?.status || e.message}`);
    }
  }
  return null;
}

// URL map + labels for each draw per state
const U = {
  ny: {
    p3: { mid: { urls: ['https://www.lotteryusa.com/new-york/pick-3-midday/'], label: 'Midday' },
          eve: { urls: ['https://www.lotteryusa.com/new-york/pick-3/'],        label: 'Evening' } },
    p4: { mid: { urls: ['https://www.lotteryusa.com/new-york/win-4-midday/'],  label: 'Midday' },
          eve: { urls: ['https://www.lotteryusa.com/new-york/win-4/'],         label: 'Evening' } }
  },
  nj: {
    p3: { mid: { urls: ['https://www.lotteryusa.com/new-jersey/pick-3-midday/'], label: 'Midday' },
          eve: { urls: ['https://www.lotteryusa.com/new-jersey/pick-3/'],        label: 'Evening' } },
    p4: { mid: { urls: ['https://www.lotteryusa.com/new-jersey/pick-4-midday/'], label: 'Midday' },
          eve: { urls: ['https://www.lotteryusa.com/new-jersey/pick-4/'],        label: 'Evening' } }
  },
  ct: {
    // CT uses Day/Night
    p3: { mid: { urls: ['https://www.lotteryusa.com/connecticut/play-3-day/'],   label: 'Day'   },
          eve: { urls: ['https://www.lotteryusa.com/connecticut/play-3-night/'], label: 'Night' } },
    p4: { mid: { urls: ['https://www.lotteryusa.com/connecticut/play-4-day/'],   label: 'Day'   },
          eve: { urls: ['https://www.lotteryusa.com/connecticut/play-4-night/'], label: 'Night' } }
  },
  fl: {
    p3: { mid: { urls: ['https://www.lotteryusa.com/florida/pick-3-midday/'], label: 'Midday' },
          eve: { urls: ['https://www.lotteryusa.com/florida/pick-3/'],        label: 'Evening' } },
    p4: { mid: { urls: ['https://www.lotteryusa.com/florida/pick-4-midday/'], label: 'Midday' },
          eve: { urls: ['https://www.lotteryusa.com/florida/pick-4/'],        label: 'Evening' } }
  }
};

async function combinedPair(stateKey) {
  const S = U[stateKey];
  const [mid3, eve3, mid4, eve4] = await Promise.all([
    tryUrls(S.p3.mid.urls, S.p3.mid.label, 3, `${stateKey}.p3.mid`),
    tryUrls(S.p3.eve.urls, S.p3.eve.label, 3, `${stateKey}.p3.eve`),
    tryUrls(S.p4.mid.urls, S.p4.mid.label, 4, `${stateKey}.p4.mid`),
    tryUrls(S.p4.eve.urls, S.p4.eve.label, 4, `${stateKey}.p4.eve`)
  ]);
  return {
    dateISO: dayjs().format('YYYY-MM-DD'),
    midday:  mid3 && mid4 ? `${mid3}-${mid4}` : null,
    evening: eve3 && eve4 ? `${eve3}-${eve4}` : null
  };
}

// --- API (never 502 just for scrape trouble) ---
app.get('/api/:state/latest', async (req, res) => {
  const key = req.params.state;
  if (!U[key]) return res.status(404).json({ error: 'unknown_state' });
  try {
    const data = await combinedPair(key);
    return res.status(200).json(data);
  } catch (e) {
    console.log('[ERROR]', key, e?.response?.status || e.message);
    return res.status(200).json({ dateISO: dayjs().format('YYYY-MM-DD'), midday: null, evening: null });
  }
});

// --- Static UI + health ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bridge up on :' + PORT));
