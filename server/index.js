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

// ---- HTTP options: act like a real browser ----
const HTTP = {
  timeout: 20000,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
  },
  // follow redirects by default
  maxRedirects: 5,
};

const USE_PLAYWRIGHT = process.env.USE_PLAYWRIGHT === '1';
let chromium;
async function fetchHtml(url) {
  try {
    const { data } = await axios.get(url, HTTP);
    return data;
  } catch (e) {
    if (!USE_PLAYWRIGHT) throw e;
    // ---- Fallback: Playwright (optional) ----
    if (!chromium) ({ chromium } = await import('playwright'));
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage({ userAgent: HTTP.headers['User-Agent'] });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = await page.content();
    await browser.close();
    return html;
  }
}

// Pull the FIRST N-digit string from the page
function firstDigits(html, n) {
  const $ = cheerio.load(html);
  // Common “Latest numbers” section on LotteryUSA
  let vals = $('h2:contains("Latest numbers")')
    .closest('section')
    .find('ul li')
    .map((_, li) => $(li).text().trim().replace(/[^0-9]/g, ''))
    .get()
    .filter(t => t && t.length === n);

  if (!vals.length) {
    vals = $('p, span, strong, li, div')
      .map((_, el) => $(el).text().trim().replace(/[^0-9]/g, ''))
      .get()
      .filter(t => t && t.length === n);
  }

  return vals[0] || null;
}

// Try a list of URLs until one yields a number of length N (no throw)
async function tryUrls(urls, n, tag) {
  for (const u of urls) {
    try {
      const html = await fetchHtml(u);
      const d = firstDigits(html, n);
      if (d) return d;
    } catch (e) {
      console.log(`[SCRAPE WARN] ${tag} failed ${u} -> ${e?.response?.status || e.message}`);
      continue;
    }
  }
  return null;
}

// Explicit Midday/Evening URLs for P3/P4 per state
const U = {
  ny: {
    p3: { mid: ['https://www.lotteryusa.com/new-york/pick-3-midday/'],
          eve: ['https://www.lotteryusa.com/new-york/pick-3/'] },
    p4: { mid: ['https://www.lotteryusa.com/new-york/win-4-midday/'],
          eve: ['https://www.lotteryusa.com/new-york/win-4/'] }
  },
  nj: {
    p3: { mid: ['https://www.lotteryusa.com/new-jersey/pick-3-midday/'],
          eve: ['https://www.lotteryusa.com/new-jersey/pick-3/'] },
    p4: { mid: ['https://www.lotteryusa.com/new-jersey/pick-4-midday/'],
          eve: ['https://www.lotteryusa.com/new-jersey/pick-4/'] }
  },
  ct: {
    // CT uses Play 3/Play 4 Day/Night
    p3: { mid: ['https://www.lotteryusa.com/connecticut/play-3-day/'],
          eve: ['https://www.lotteryusa.com/connecticut/play-3-night/'] },
    p4: { mid: ['https://www.lotteryusa.com/connecticut/play-4-day/'],
          eve: ['https://www.lotteryusa.com/connecticut/play-4-night/'] }
  },
  fl: {
    p3: { mid: ['https://www.lotteryusa.com/florida/pick-3-midday/'],
          eve: ['https://www.lotteryusa.com/florida/pick-3/'] },
    p4: { mid: ['https://www.lotteryusa.com/florida/pick-4-midday/'],
          eve: ['https://www.lotteryusa.com/florida/pick-4/'] }
  },
};

// Build "p3-p4" pair per draw. Never throw; return nulls if missing.
async function combinedPair(stateKey) {
  const S = U[stateKey];
  const [mid3, eve3, mid4, eve4] = await Promise.all([
    tryUrls(S.p3.mid, 3, `${stateKey}.p3.mid`),
    tryUrls(S.p3.eve, 3, `${stateKey}.p3.eve`),
    tryUrls(S.p4.mid, 4, `${stateKey}.p4.mid`),
    tryUrls(S.p4.eve, 4, `${stateKey}.p4.eve`),
  ]);

  return {
    dateISO: dayjs().format('YYYY-MM-DD'),
    midday:  (mid3 && mid4) ? `${mid3}-${mid4}` : null,
    evening: (eve3 && eve4) ? `${eve3}-${eve4}` : null,
  };
}

// API (don’t 502 just because one site was grumpy)
app.get('/api/:state/latest', async (req, res) => {
  const key = req.params.state;
  if (!U[key]) return res.status(404).json({ error: 'unknown_state' });
  try {
    const data = await combinedPair(key);
    // if *both* draws are null, it really failed
    if (!data.midday && !data.evening) {
      return res.status(200).json(data); // send nulls; UI can show dashes
    }
    res.json(data);
  } catch (e) {
    console.log('[SCRAPE ERROR]', key, e?.response?.status || e.message);
    res.status(200).json({ dateISO: dayjs().format('YYYY-MM-DD'), midday: null, evening: null });
  }
});

// Static UI + health
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bridge up on :' + PORT, 'Playwright:', USE_PLAYWRIGHT ? 'on' : 'off'));
