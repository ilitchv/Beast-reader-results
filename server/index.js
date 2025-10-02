// server/index.js
// Express + scraper for Pick-3 / Pick-4 latest numbers, single-origin serving
// Includes debug endpoint and the "paired-date" fix, CT label robustness, and safer digit extraction.

const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const dayjs = require('dayjs');

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const USE_PLAYWRIGHT = process.env.USE_PLAYWRIGHT === '1';

app.use(cors());

// Serve static frontend
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// ---------- HTTP fetch layer with browser-like headers ----------
async function fetchHtml(url) {
  // Optional hardened path via Playwright (off by default)
  if (USE_PLAYWRIGHT) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Small settle
    await page.waitForTimeout(250);
    const html = await page.content();
    await browser.close();
    return html;
  }

  const resp = await axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Connection': 'keep-alive',
    },
    timeout: 30000,
    validateStatus: (s) => s >= 200 && s < 500, // allow 404s for fallback
  });
  if (resp.status >= 400) {
    const err = new Error(`HTTP ${resp.status}`);
    err.response = resp;
    throw err;
  }
  return resp.data;
}

// ---------- Helpers ----------
function cleanTextBlocks(txt) {
  return (txt || '')
    .replace(/\s+/g, ' ')
    .replace(/[$,]/g, '')
    .trim();
}

// Exclude being a substring of longer digit runs.
// This implements the stricter lookaround requested in the patch.
function pickNDigitsFromTextSafe($, $container, n) {
  const txt = cleanTextBlocks($container.text());
  const re = new RegExp(`(?<!\\d)\\d{${n}}(?!\\d)`);
  const m = txt.match(re);
  return m ? m[0] : null;
}

// Heuristic: climb to a nearby container that actually includes n-digit content.
function nearestContainerWithNDigits($, $start, n, $section) {
  let node = $start;
  for (let i = 0; i < 6 && node && node.length; i++) {
    const hasN = pickNDigitsFromTextSafe($, node, n);
    if (hasN) return node;
    node = node.parent();
    if (!$section || (node && node.is($section))) break;
  }
  // Fallback: search descendants in the section for an element around here
  // that contains exactly n digits.
  let near = null;
  $section.find('*').each((_, el) => {
    if (near) return;
    const $el = $(el);
    const d = pickNDigitsFromTextSafe($, $el, n);
    if (d) near = $el;
  });
  return near || $start;
}

// Extract numbers and date anchored to a draw label (Midday / Evening / Day / Night)
// Patch widens the container scope and label search (CT robustness).
function extractByLabel($, label, n) {
  // Find a "Latest numbers" like section, but be generous.
  let $section = $('section, main, article').filter((_, el) => {
    const h = $(el).find('h1,h2,h3').first().text().trim().toLowerCase();
    return h.includes('latest') && (h.includes('number') || h.includes('result'));
  }).first();
  if (!$section.length) $section = $.root();

  const re = new RegExp(`\\b${label.toLowerCase()}\\b`, 'i');
  let $labelEl = $section
    .find('[aria-label], [role], h4, h5, strong, b, p, li, div, span')
    .filter((_, el) => {
      const t = ($(el).attr('aria-label') || $(el).text() || '').trim().toLowerCase();
      return re.test(t);
    })
    .first();

  if (!$labelEl.length) return { digits: null, date: null };

  const $container = nearestContainerWithNDigits($, $labelEl, n, $section);

  // Try strict digit-per-span pattern first (e.g., <span>0</span><span>9</span><span>2</span>).
  let digits = null;
  const spans = $container.find('span, div, b, strong').filter((_, el) => /^\d$/.test($(el).text().trim()));
  if (spans.length >= n) {
    const parts = [];
    spans.each((i, el) => {
      if (parts.length < n) {
        const t = $(el).text().trim();
        if (/^\d$/.test(t)) parts.push(t);
      }
    });
    if (parts.length === n) digits = parts.join('');
  }

  // Fallback: clean text scan, but keep it as exactly n digits (safer regex applied earlier).
  if (!digits) digits = pickNDigitsFromTextSafe($, $container, n);

  // Date extraction: look nearby.
  let rawDate = null;
  const dateCand = [];
  const around = $container.closest('section, article, div').first();
  around.find('*').each((_, el) => {
    const t = cleanTextBlocks($(el).text());
    if (!t) return;
    // "September 10, 2025" or "9/10/2025" or "2025-09-10"
    const m1 = t.match(/\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/);
    const m2 = t.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
    const m3 = t.match(/\b(\d{4})\-(\d{2})\-(\d{2})\b/);
    if (m1) {
      dateCand.push(dayjs(m1[0]));
    } else if (m2) {
      const [mm, dd, yy] = [parseInt(m2[1], 10), parseInt(m2[2], 10), parseInt(m2[3], 10)];
      const yyyy = yy < 100 ? 2000 + yy : yy;
      dateCand.push(dayjs(`${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`));
    } else if (m3) {
      dateCand.push(dayjs(m3[0]));
    }
  });
  if (dateCand.length) rawDate = dateCand.sort((a, b) => a - b).pop();

  return { digits, date: rawDate || null };
}

// ---------- State URL map ----------
// Each state defines Pick-3 and Pick-4, Midday/Evening (or Day/Night) with fallback URLs.
const U = {};

// New York
U.ny = {
  p3: {
    mid: { urls: ['https://www.lotteryusa.com/new-york/pick-3-midday/', 'https://www.lotteryusa.com/new-york/pick-3/'], label: 'Midday' },
    eve: { urls: ['https://www.lotteryusa.com/new-york/pick-3/'], label: 'Evening' },
  },
  p4: {
    mid: { urls: ['https://www.lotteryusa.com/new-york/pick-4-midday/', 'https://www.lotteryusa.com/new-york/pick-4/'], label: 'Midday' },
    eve: { urls: ['https://www.lotteryusa.com/new-york/pick-4/'], label: 'Evening' },
  },
};

// New Jersey
U.nj = {
  p3: {
    mid: { urls: ['https://www.lotteryusa.com/new-jersey/pick-3-midday/', 'https://www.lotteryusa.com/new-jersey/pick-3/'], label: 'Midday' },
    eve: { urls: ['https://www.lotteryusa.com/new-jersey/pick-3/'], label: 'Evening' },
  },
  p4: {
    mid: { urls: ['https://www.lotteryusa.com/new-jersey/pick-4-midday/', 'https://www.lotteryusa.com/new-jersey/pick-4/'], label: 'Midday' },
    eve: { urls: ['https://www.lotteryusa.com/new-jersey/pick-4/'], label: 'Evening' },
  },
};

// Connecticut (Day/Night labels on many pages)
U.ct = {
  p3: {
    mid: { urls: ['https://www.lotteryusa.com/connecticut/pick-3-day/', 'https://www.lotteryusa.com/connecticut/pick-3/'], label: 'Day' },
    eve: { urls: ['https://www.lotteryusa.com/connecticut/pick-3-night/', 'https://www.lotteryusa.com/connecticut/pick-3/'], label: 'Night' },
  },
  p4: {
    mid: { urls: ['https://www.lotteryusa.com/connecticut/pick-4-day/', 'https://www.lotteryusa.com/connecticut/pick-4/'], label: 'Day' },
    eve: { urls: ['https://www.lotteryusa.com/connecticut/pick-4-night/', 'https://www.lotteryusa.com/connecticut/pick-4/'], label: 'Night' },
  },
};

// Florida (Midday/Evening)
U.fl = {
  p3: {
    mid: { urls: ['https://www.lotteryusa.com/florida/pick-3-midday/', 'https://www.lotteryusa.com/florida/pick-3/'], label: 'Midday' },
    eve: { urls: ['https://www.lotteryusa.com/florida/pick-3/'], label: 'Evening' },
  },
  p4: {
    mid: { urls: ['https://www.lotteryusa.com/florida/pick-4-midday/', 'https://www.lotteryusa.com/florida/pick-4/'], label: 'Midday' },
    eve: { urls: ['https://www.lotteryusa.com/florida/pick-4/'], label: 'Evening' },
  },
};

async function tryUrls(urls, label, n, tag) {
  for (const u of urls) {
    try {
      const html = await fetchHtml(u);
      const $ = cheerio.load(html);
      const { digits, date } = extractByLabel($, label, n);
      if (digits) return { digits, date };
    } catch (e) {
      console.log(`[WARN] ${tag} ${u} -> ${e?.response?.status || e.message}`);
    }
  }
  return { digits: null, date: null };
}

// Combine P3 and P4 per draw, *and* keep dates paired to their digits (patch A).
async function combinedPair(stateKey) {
  const S = U[stateKey];
  if (!S) return { dateISO: dayjs().format('YYYY-MM-DD'), midday: null, evening: null };

  const [mid3, eve3, mid4, eve4] = await Promise.all([
    tryUrls(S.p3.mid.urls, S.p3.mid.label, 3, `${stateKey}.p3.mid`),
    tryUrls(S.p3.eve.urls, S.p3.eve.label, 3, `${stateKey}.p3.eve`),
    tryUrls(S.p4.mid.urls, S.p4.mid.label, 4, `${stateKey}.p4.mid`),
    tryUrls(S.p4.eve.urls, S.p4.eve.label, 4, `${stateKey}.p4.eve`),
  ]);

  const middayDigits = (mid3.digits && mid4.digits) ? `${mid3.digits}-${mid4.digits}` : null;
  const eveningDigits = (eve3.digits && eve4.digits) ? `${eve3.digits}-${eve4.digits}` : null;

  const today = dayjs();
  const middayDate = [mid3.date, mid4.date].filter(Boolean).sort((a, b) => a - b).pop() || today;
  const eveningDate = [eve3.date, eve4.date].filter(Boolean).sort((a, b) => a - b).pop() || today;

  const dateCandidates = [];
  if (middayDigits) dateCandidates.push(middayDate);
  if (eveningDigits) dateCandidates.push(eveningDate);
  const dateISO = (dateCandidates.sort((a, b) => a - b).pop() || today).format('YYYY-MM-DD');

  return { dateISO, midday: middayDigits, evening: eveningDigits };
}

// ---------- API Routes ----------
app.get('/api/:state/latest', async (req, res) => {
  const key = (req.params.state || '').toLowerCase();
  if (!U[key]) return res.status(404).json({ error: 'unknown_state' });
  try {
    const out = await combinedPair(key);
    res.json(out);
  } catch (e) {
    console.log('[ERROR] /api/:state/latest', key, e.message);
    res.json({ dateISO: dayjs().format('YYYY-MM-DD'), midday: null, evening: null });
  }
});

// Tiny debug endpoint to preview the exact text we parse near labels.
app.get('/api/_debug/:state', async (req, res) => {
  const key = (req.params.state || '').toLowerCase();
  const S = U[key];
  if (!S) return res.status(404).json({ error: 'unknown_state' });
  async function peek(urls, label, n, tag) {
    for (const u of urls) {
      try {
        const html = await fetchHtml(u);
        const $ = cheerio.load(html);

        let $section = $('section, main, article').filter((_, el) => {
          const h = $(el).find('h1,h2,h3').first().text().trim().toLowerCase();
          return h.includes('latest') && (h.includes('number') || h.includes('result'));
        }).first();
        if (!$section.length) $section = $.root();

        const re = new RegExp(`\\b${label.toLowerCase()}\\b`, 'i');
        const $label = $section
          .find('[aria-label], [role], h4, h5, strong, b, p, li, div, span')
          .filter((_, el) => {
            const t = ($(el).attr('aria-label') || $(el).text() || '').trim().toLowerCase();
            return re.test(t);
          })
          .first();
        if (!$label.length) continue;

        const $cont = nearestContainerWithNDigits($, $label, n, $section);
        return {
          url: u,
          label,
          n,
          preview: cleanTextBlocks($cont.text()).slice(0, 2000),
        };
      } catch (e) {
        console.log(`[WARN] debug ${tag} ${u} -> ${e?.response?.status || e.message}`);
      }
    }
    return { url: null, label, n, preview: null };
  }

  try {
    const out = {
      p3: {
        mid: await peek(S.p3.mid.urls, S.p3.mid.label, 3, `${key}.p3.mid`),
        eve: await peek(S.p3.eve.urls, S.p3.eve.label, 3, `${key}.p3.eve`),
      },
      p4: {
        mid: await peek(S.p4.mid.urls, S.p4.mid.label, 4, `${key}.p4.mid`),
        eve: await peek(S.p4.eve.urls, S.p4.eve.label, 4, `${key}.p4.eve`),
      },
    };
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fallback to index.html (for single-page style)
app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
