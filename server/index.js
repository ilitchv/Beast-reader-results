// server/index.js
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());

// Grab the first N-digit string from a page (LotteryUSA)
async function grabFirstDigits(url, howMany) {
  const html = (await axios.get(url, { timeout: 15000 })).data;
  const $ = cheerio.load(html);

  // Try "Latest numbers" section first
  let vals = $('h2:contains("Latest numbers")')
    .closest('section')
    .find('ul li')
    .map((_, li) => $(li).text().trim().replace(/[^0-9]/g, ''))
    .get()
    .filter(Boolean)
    .filter(t => t.length === howMany);

  // Fallback: scan text nodes
  if (!vals.length) {
    vals = $('p, span, strong, li')
      .map((_, el) => $(el).text().trim().replace(/[^0-9]/g, ''))
      .get()
      .filter(t => t.length === howMany);
  }

  return vals[0] || null;
}

// URL map that explicitly separates Midday/Evening (or Day/Night) per state
const U = {
  ny: {
    p3: { mid: 'https://www.lotteryusa.com/new-york/pick-3-midday/',  eve: 'https://www.lotteryusa.com/new-york/pick-3/' },
    p4: { mid: 'https://www.lotteryusa.com/new-york/win-4-midday/',   eve: 'https://www.lotteryusa.com/new-york/win-4/' }
  },
  nj: {
    p3: { mid: 'https://www.lotteryusa.com/new-jersey/pick-3-midday/', eve: 'https://www.lotteryusa.com/new-jersey/pick-3/' },
    p4: { mid: 'https://www.lotteryusa.com/new-jersey/pick-4-midday/', eve: 'https://www.lotteryusa.com/new-jersey/pick-4/' }
  },
  ct: {
    // CT uses Day/Night + Play 3/Play 4
    p3: { mid: 'https://www.lotteryusa.com/connecticut/play-3-day/',   eve: 'https://www.lotteryusa.com/connecticut/play-3-night/' },
    p4: { mid: 'https://www.lotteryusa.com/connecticut/play-4-day/',   eve: 'https://www.lotteryusa.com/connecticut/play-4-night/' }
  },
  fl: {
    p3: { mid: 'https://www.lotteryusa.com/florida/pick-3-midday/',    eve: 'https://www.lotteryusa.com/florida/pick-3/' },
    p4: { mid: 'https://www.lotteryusa.com/florida/pick-4-midday/',    eve: 'https://www.lotteryusa.com/florida/pick-4/' }
  }
};

// Helper to build "p3-p4" for Midday and Evening
async function combinedPair({ p3, p4 }) {
  const [mid3, eve3, mid4, eve4] = await Promise.all([
    grabFirstDigits(p3.mid, 3),
    grabFirstDigits(p3.eve, 3),
    grabFirstDigits(p4.mid, 4),
    grabFirstDigits(p4.eve, 4),
  ]);
  return {
    dateISO: dayjs().format('YYYY-MM-DD'),
    midday:  (mid3 && mid4) ? `${mid3}-${mid4}` : null,
    evening: (eve3 && eve4) ? `${eve3}-${eve4}` : null,
  };
}

// ---- State getters (now return combined p3-p4 strings) ----
const getters = {
  ny: () => combinedPair(U.ny),
  nj: () => combinedPair(U.nj),
  ct: () => combinedPair(U.ct),
  fl: () => combinedPair(U.fl),
};

// API routes
app.get('/api/:state/latest', async (req, res) => {
  const fn = getters[req.params.state];
  if (!fn) return res.status(404).json({ error: 'unknown_state' });
  try { res.json(await fn()); }
  catch (e) { res.status(502).json({ error: 'scrape_failed', detail: String(e?.message || e) }); }
});

// (optional) Back-compat NY alias
app.get('/api/ny/latest', async (_req, res) => {
  try { res.json(await getters.ny()); }
  catch (e) { res.status(502).json({ error: 'scrape_failed', detail: String(e?.message || e) }); }
});

// Serve static UI
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bridge up on :' + PORT));
