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

// --- robust digit grabber (handles different page structures) ---
async function fetchDigits(url, howMany) {
  const html = (await axios.get(url, { timeout: 15000 })).data;
  const $ = cheerio.load(html);

  // Try 1: the “Latest numbers” list block (common across LotteryUSA)
  let digits = $('h2:contains("Latest numbers")')
    .closest('section')
    .find('ul li')
    .map((_, li) => $(li).text().trim().replace(/[^0-9]/g, ''))
    .get();

  // Try 2: any <p> or <span> that looks like a 3/4 digit draw
  if (!digits || digits.length < 2) {
    digits = $('p, span, strong')
      .map((_, el) => $(el).text().trim())
      .get()
      .map(t => (t || '').replace(/[^0-9]/g, ''))
      .filter(t => t.length === howMany);
  }

  return digits.filter(Boolean);
}

// ---- State getters ----
const getters = {
  async ny() {
    const day = await fetchDigits('https://www.lotteryusa.com/new-york/pick-3/', 3);
    const night = await fetchDigits('https://www.lotteryusa.com/new-york/win-4/', 4);
    return { dateISO: dayjs().format('YYYY-MM-DD'), midday: day[0] || null, evening: night[0] || null };
  },
  async nj() {
    const day = await fetchDigits('https://www.lotteryusa.com/new-jersey/pick-3/', 3);
    const night = await fetchDigits('https://www.lotteryusa.com/new-jersey/pick-4/', 4);
    return { dateISO: dayjs().format('YYYY-MM-DD'), midday: day[0] || null, evening: night[0] || null };
  },
  async ct() {
    const day = await fetchDigits('https://www.lotteryusa.com/connecticut/play-3-day/', 3);
    const night = await fetchDigits('https://www.lotteryusa.com/connecticut/play-3-night/', 3);
    return { dateISO: dayjs().format('YYYY-MM-DD'), midday: day[0] || null, evening: night[0] || null };
  },
  async fl() {
    const day = await fetchDigits('https://www.lotteryusa.com/florida/pick-3/', 3);
    const night = await fetchDigits('https://www.lotteryusa.com/florida/pick-4/', 4);
    return { dateISO: dayjs().format('YYYY-MM-DD'), midday: day[0] || null, evening: night[0] || null };
  },
};

// API routes
app.get('/api/:state/latest', async (req, res) => {
  const fn = getters[req.params.state];
  if (!fn) return res.status(404).json({ error: 'unknown_state' });
  try { res.json(await fn()); }
  catch (e) { res.status(502).json({ error: 'scrape_failed', detail: String(e?.message || e) }); }
});

// Back-compat alias for NY
app.get('/api/ny/latest', async (_req, res) => {
  try { res.json(await getters.ny()); }
  catch (e) { res.status(502).json({ error: 'scrape_failed', detail: String(e?.message || e) }); }
});

// --- Serve static UI (same-origin) ---
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/healthz', (_req, res) => res.send('ok'));

// Fallback to index.html for "/" (and any unknown route that isn't /api/*)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bridge up on :' + PORT));
