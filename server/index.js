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

// --- Request options: behave like a real browser (prevents soft blocks) ---
const HTTP = {
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
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

/**
 * Given a container, try to extract a sequence of N single-digit nodes in DOM order.
 * This matches the typical "digit per <span>" rendering and avoids picking dates and prizes.
 */
function pickConsecutiveSingleDigitNodes($, $container, n) {
  // flatten into a linear list of candidate nodes (<span>, <div>, <li>, <p>) with single-digit text
  const nodes = $container.find('span, div, li, p').toArray()
    .map(el => ($(el).text().trim()))
    .map(t => t && /^[0-9]$/.test(t) ? t : null);

  // scan for n consecutive single-digit entries
  for (let i = 0; i <= nodes.length - n; i++) {
    const slice = nodes.slice(i, i + n);
    if (slice.every(x => x !== null)) return slice.join('');
  }
  return null;
}

/**
 * As a careful fallback: pull the first clean N-digit token from text inside container,
 * but ignore currency/prize/date lines.
 */
function pickNDigitsFromTextSafe($, $container, n) {
  let txt = $container.text().replace(/\s+/g, ' ');
  // strip money/prize language to avoid "500" / "5000"
  txt = txt.replace(/\$[0-9][0-9,.]*/g, ' ');
  txt = txt.replace(/\b(prize|top prize|payout|how to|odds)\b[^|]*/gi, ' ');
  // avoid mm/dd/yy style dates: drop tokens with slash or month names nearby
  txt = txt.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^.]+/gi, ' ');

  const m = txt.match(new RegExp(`\\b\\d{${n}}\\b`));
  return m ? m[0] : null;
}

/**
 * Find the "Latest numbers" section; then locate the block that contains the draw label (Midday/Evening/Day/Night).
 * From that block, first try DOM-based consecutive single-digit extraction; then a safe text fallback.
 */
function extractByLabel($, label, n) {
  // scope: the section that has "Latest numbers" in a heading
  let $section = $('section').filter((_, el) => {
    const h = $(el).find('h1,h2,h3').first().text().trim().toLowerCase();
    return h.includes('latest') && h.includes('number');
  }).first();
  if (!$section.length) $section = $.root();

  // find the smallest container that mentions the label
  let $labelEl = $section.find('*').filter((_, el) =>
    $(el).text().trim().toLowerCase().includes(label.toLowerCase())
  ).first();
  if (!$labelEl.length) return null;

  // choose a nearby container (li/article/div) that should hold the digits for that draw
  let $container = $labelEl.closest('li, article, div');
  if (!$container.length) $container = $labelEl;

  // 1) prefer structural "one <span> per digit"
  const viaNodes = pickConsecutiveSingleDigitNodes($, $container, n);
  if (viaNodes) return viaNodes;

  // 2) safe text scan inside the same container
  const viaText = pickNDigitsFromTextSafe($, $container, n);
  if (viaText) return viaText;

  // 3) as a last resort, broaden to section (still label-anchored) to catch odd markup
  const viaSection = pickNDigitsFromTextSafe($, $section, n);
  return viaSection;
}

// Try URL(s) for a given (label, n); never throw—return null if all fail
async function tryUrls(urls, label, n, tag) {
  for (const u of urls) {
    try {
      const html = await fetchHtml(u);
      const $ = cheerio.load(html);
      const val = extractByLabel($, label, n);
      if (val) return val;
    } catch (e) {
      console.log(`[WARN] ${tag} ${u} -> ${e?.response?.status || e.message}`);
    }
  }
  return null;
}

// URLs and draw labels (Midday/Evening or Day/Night)
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
    midday:  (mid3 && mid4) ? `${mid3}-${mid4}` : null,
    evening: (eve3 && eve4) ? `${eve3}-${eve4}` : null
  };
}

// --- API: never 502 on scrape trouble; send nulls so UI can show dashes ---
app.get('/api/:state/latest', async (req, res) => {
  const key = req.params.state;
  if (!U[key]) return res.status(404).json({ error: 'unknown_state' });
  try {
    const data = await combinedPair(key);
    res.status(200).json(data);
  } catch (e) {
    console.log('[ERROR]', key, e?.response?.status || e.message);
    res.status(200).json({ dateISO: dayjs().format('YYYY-MM-DD'), midday: null, evening: null });
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
