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

async function fetchHtml(url){ const {data}=await axios.get(url,HTTP); return data; }

// ── helpers to parse date strings we see on pages ──────────────────────────────
function parseDateFromText(text){
  const y = dayjs().year();
  const t = (text||'').replace(/\s+/g,' ');
  // Month-name format: "September 10, 2025" or "Sep 10"
  const m1 = t.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (m1){
    const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const M = monthNames.findIndex(x => m1[1].toLowerCase().startsWith(x))+1;
    const D = parseInt(m1[2],10);
    const Y = m1[3]? parseInt(m1[3],10): y;
    return dayjs(`${Y}-${String(M).padStart(2,'0')}-${String(D).padStart(2,'0')}`);
  }
  // Numeric format: 9/10/2025 or 9/10
  const m2 = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m2){
    const M = parseInt(m2[1],10), D = parseInt(m2[2],10);
    let Y = m2[3]? parseInt(m2[3],10): y;
    if (Y<100) Y = 2000+Y;
    return dayjs(`${Y}-${String(M).padStart(2,'0')}-${String(D).padStart(2,'0')}`);
  }
  return null;
}

// ── digit extraction (structural first, then safe text) ────────────────────────
function pickConsecutiveSingleDigitNodes($,$container,n){
  const nodes = $container.find('span,div,li,p').toArray()
    .map(el=>$(el).text().trim())
    .map(t=> t && /^[0-9]$/.test(t) ? t : null);
  for(let i=0;i<=nodes.length-n;i++){
    const slice = nodes.slice(i,i+n);
    if (slice.every(x=>x!==null)) return slice.join('');
  }
  return null;
}
function pickNDigitsFromTextSafe($,$container,n){
  let txt = $container.text().replace(/\s+/g,' ');
  txt = txt.replace(/\$[0-9][0-9,.]*/g,' ');
  txt = txt.replace(/\b(prize|top prize|payout|how to|odds)\b[^|]*/gi,' ');
  txt = txt.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^.]+/gi,' ');
  const m = txt.match(new RegExp(`\\b\\d{${n}}\\b`));
  return m? m[0] : null;
}
function extractByLabel($, label, n){
  let $section = $('section').filter((_,el)=>{
    const h=$(el).find('h1,h2,h3').first().text().trim().toLowerCase();
    return h.includes('latest') && h.includes('number');
  }).first();
  if(!$section.length) $section=$.root();

  let $labelEl = $section.find('*').filter((_,el)=>
    $(el).text().trim().toLowerCase().includes(label.toLowerCase())
  ).first();
  if(!$labelEl.length) return {digits:null,date:null};

  let $container = $labelEl.closest('li,article,div'); if(!$container.length) $container=$labelEl;

  // digits
  const viaNodes = pickConsecutiveSingleDigitNodes($,$container,n);
  const digits = viaNodes || pickNDigitsFromTextSafe($,$container,n);

  // date (look near the same container)
  const around = $container.text();
  const date = parseDateFromText(around) || parseDateFromText($section.text());

  return { digits, date };
}

// ── try a list of URLs; return {digits,date} without throwing ─────────────────
async function tryUrls(urls,label,n,tag){
  for(const u of urls){
    try{
      const html = await fetchHtml(u);
      const $ = cheerio.load(html);
      const {digits,date} = extractByLabel($,label,n);
      if(digits) return {digits,date};
    }catch(e){
      console.log(`[WARN] ${tag} ${u} -> ${e?.response?.status || e.message}`);
    }
  }
  return {digits:null,date:null};
}

// ── URL map with robust fallbacks: specific page first, then generic page ─────
const U = {
  ny: {
    p3: {
      mid: { urls: [
        'https://www.lotteryusa.com/new-york/midday-numbers/',
        'https://www.lotteryusa.com/new-york/numbers/'
      ], label: 'Midday' },
      eve: { urls: [
        'https://www.lotteryusa.com/new-york/numbers/'
      ], label: 'Evening' }
    },
    p4: {
      mid: { urls: [
        'https://www.lotteryusa.com/new-york/midday-win-4/',
        'https://www.lotteryusa.com/new-york/win-4/'
      ], label: 'Midday' },
      eve: { urls: [
        'https://www.lotteryusa.com/new-york/win-4/'
      ], label: 'Evening' }
    }
  },

  nj: {
    p3: {
      mid: { urls: [
        'https://www.lotteryusa.com/new-jersey/midday-pick-3/',
        'https://www.lotteryusa.com/new-jersey/midday-numbers/',
        'https://www.lotteryusa.com/new-jersey/pick-3/'
      ], label: 'Midday' },
      eve: { urls: [
        'https://www.lotteryusa.com/new-jersey/pick-3/',
        'https://www.lotteryusa.com/new-jersey/numbers/'
      ], label: 'Evening' }
    },
    p4: {
      mid: { urls: [
        'https://www.lotteryusa.com/new-jersey/midday-pick-4/',
        'https://www.lotteryusa.com/new-jersey/midday-win-4/',
        'https://www.lotteryusa.com/new-jersey/pick-4/'
      ], label: 'Midday' },
      eve: { urls: [
        'https://www.lotteryusa.com/new-jersey/pick-4/',
        'https://www.lotteryusa.com/new-jersey/win-4/'
      ], label: 'Evening' }
    }
  },

  // CT and FL: keep as-is, but adding day/night-number fallbacks is fine too
  ct: {
    p3: { mid: { urls:['https://www.lotteryusa.com/connecticut/play-3-day/','https://www.lotteryusa.com/connecticut/play-3/'], label:'Day' },
          eve: { urls:['https://www.lotteryusa.com/connecticut/play-3-night/','https://www.lotteryusa.com/connecticut/play-3/'], label:'Night' } },
    p4: { mid: { urls:['https://www.lotteryusa.com/connecticut/play-4-day/','https://www.lotteryusa.com/connecticut/play-4/'], label:'Day' },
          eve: { urls:['https://www.lotteryusa.com/connecticut/play-4-night/','https://www.lotteryusa.com/connecticut/play-4/'], label:'Night' } }
  },

  fl: {
    p3: { mid: { urls:['https://www.lotteryusa.com/florida/pick-3-midday/','https://www.lotteryusa.com/florida/pick-3/'], label:'Midday' },
          eve: { urls:['https://www.lotteryusa.com/florida/pick-3/'], label:'Evening' } },
    p4: { mid: { urls:['https://www.lotteryusa.com/florida/pick-4-midday/','https://www.lotteryusa.com/florida/pick-4/'], label:'Midday' },
          eve: { urls:['https://www.lotteryusa.com/florida/pick-4/'], label:'Evening' } }
  }
};

// ── build "p3-p4" per draw and a trustworthy dateISO ──────────────────────────
async function combinedPair(stateKey){
  const S=U[stateKey];
  const [mid3, eve3, mid4, eve4] = await Promise.all([
    tryUrls(S.p3.mid.urls, S.p3.mid.label, 3, `${stateKey}.p3.mid`),
    tryUrls(S.p3.eve.urls, S.p3.eve.label, 3, `${stateKey}.p3.eve`),
    tryUrls(S.p4.mid.urls, S.p4.mid.label, 4, `${stateKey}.p4.mid`),
    tryUrls(S.p4.eve.urls, S.p4.eve.label, 4, `${stateKey}.p4.eve`)
  ]);

  const midday  = (mid3.digits && mid4.digits) ? `${mid3.digits}-${mid4.digits}` : null;
  const evening = (eve3.digits && eve4.digits) ? `${eve3.digits}-${eve4.digits}` : null;

  // prefer the freshest non-null date we observed near either label
  const dates = [mid3.date, mid4.date, eve3.date, eve4.date].filter(Boolean);
  const latest = dates.length ? dates.sort((a,b)=>a.valueOf()-b.valueOf()).pop() : null;

  return {
    dateISO: (latest || dayjs()).format('YYYY-MM-DD'),
    midday,
    evening
  };
}

// API
app.get('/api/:state/latest', async (req,res)=>{
  const key=req.params.state;
  if(!U[key]) return res.status(404).json({error:'unknown_state'});
  try{
    const data = await combinedPair(key);
    res.status(200).json(data);
  }catch(e){
    console.log('[ERROR]', key, e?.response?.status || e.message);
    res.status(200).json({ dateISO: dayjs().format('YYYY-MM-DD'), midday:null, evening:null });
  }
});

// Static UI + health
app.use(express.static(path.join(__dirname,'public')));
app.get('/healthz', (_req,res)=>res.send('ok'));
app.get('*', (req,res,next)=>{ if(req.path.startsWith('/api/')) return next(); res.sendFile(path.join(__dirname,'public','index.html')); });

const PORT=process.env.PORT||3000;
app.listen(PORT, ()=>console.log('Bridge up on :'+PORT));
