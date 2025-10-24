import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);
// Make all "current time" fallbacks Eastern Time, not UTC
dayjs.tz.setDefault('America/New_York');
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

async function fetchHtml(url){
  const {data} = await axios.get(url, { ...HTTP, params: { t: Date.now() }});
  return data;
}


// ── helpers to parse date strings we see on pages ──────────────────────────────
// Extract "the first n-digit result" from the main results area (no label needed)
function extractFirstInLatest($, n) {
  // try a narrow container first (table/list/section under main/article)
  const scopes = ['main', 'article', 'section', '.results', 'table', 'ul', 'ol'];
  for (const sel of scopes) {
    const $blk = $(sel).first();
    if ($blk.length) {
      const bySpans = pickConsecutiveSingleDigitNodes($, $blk, n);
      if (bySpans) return bySpans;
      const byText = pickNDigitsFromTextSafe($, $blk, n);
      if (byText) return byText;
    }
  }
  // fall back to whole doc
  const bySpans = pickConsecutiveSingleDigitNodes($, $.root(), n);
  if (bySpans) return bySpans;
  return pickNDigitsFromTextSafe($, $.root(), n);
}

// Accept "Day", "Daytime" for Day and just "Night" for night.
 const CT_LABEL_RE = {
  Day: /(day(?:time)?)/i,
  Night: /(night)/i,
  Midday: /(midday|day(?:time)?)/i,     // allow 'Midday' or 'Day/Daytime'
  Evening: /(evening|night)/i           // allow 'Evening' or 'Night'
};
 function extractRowByLabel($, label, n) {
   const labelRe = CT_LABEL_RE[label] || new RegExp(label, 'i');
   // Don’t rely on a specific heading; use the whole doc but prefer small blocks that contain both the label and n digits.
   const rowSel = 'tr, li, .row, .result, .draw, .results-row, .c-results-card, section, article, div';
   let best = null, bestSize = Infinity;
   $(rowSel).each((_, el) => {
     const $el = $(el);
     const text = $el.text();
     if (!labelRe.test(text)) return;
     // must contain at least n digits somewhere
     const hasNDigits = new RegExp(`\\d[^\\d]*`.repeat(n)).test(text);
     if (!hasNDigits) return;
     // Prefer the smallest node that satisfies both conditions
     const size = $el.text().length;
     if (size < bestSize) { best = $el; bestSize = size; }
   });
   if (!best) return { digits: null, date: null };
   const d1 = pickConsecutiveSingleDigitNodes($, best, n);
   const d2 = d1 || pickNDigitsFromTextSafe($, best, n);
   const date = parseDateFromText(best.text()) || parseDateFromText($.root().text());
   return d2 ? { digits: d2, date } : { digits: null, date: null };
 }
function parseDateFromText(text){
  const y = dayjs.tz(Date.now(), 'America/New_York').year();
  const t = (text||'').replace(/\s+/g,' ');

  // Fast-path: "today" / "tonight" → use current date
  if (/\b(today|tonight|this (?:evening|afternoon|morning))\b/i.test(t)) {
    return dayjs.tz(Date.now(), 'America/New_York'); // for "today/tonight"
  }

  // Month-name format: "September 10, 2025" or "Sep 10"
  const m1 = t.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,\s*(\d{4}))?/i);
  if (m1){
    const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const M = monthNames.findIndex(x => m1[1].toLowerCase().startsWith(x))+1;
    const D = parseInt(m1[2],10);
    const Y = m1[3]? parseInt(m1[3],10): y;
    return dayjs.tz(`${Y}-${String(M).padStart(2,'0')}-${String(D).padStart(2,'0')}`, 'America/New_York');
  }

  // Numeric format: 9/10/2025 or 9/10
  const m2 = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (m2){
    const M = parseInt(m2[1],10), D = parseInt(m2[2],10);
    let Y = m2[3]? parseInt(m2[3],10): y;
    if (Y<100) Y = 2000+Y;
    return dayjs.tz(`${Y}-${String(M).padStart(2,'0')}-${String(D).padStart(2,'0')}`, 'America/New_York');
  }
  return null; // let caller default to "today" instead of scanning the whole section
}

function cleanTextBlocks(txt){
  let t = (txt || '').replace(/\s+/g, ' ');
  // strip money, times, and boilerplate that creates false positives
  t = t.replace(/\$[0-9][0-9,.]*/g, ' ');
  t = t.replace(/\b\d{1,2}:\d{2}(\s?[ap]m)?\b/gi, ' ');  // 12:59, 9:45pm
  t = t.replace(/\b(prize|top prize|payout|how to|odds|draws? at)\b[^.!?\n]*/gi, ' ');
  return t;
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
// Allow digits separated by spaces/spans; then collapse to the first n digits.
 function pickNDigitsFromTextSafe($,$container,n){
   const txt = cleanTextBlocks($container.text());
   // e.g., "6 4 1" (P3) or "0 2 7 0" (P4) when spans flatten oddly.
   const mSpan = txt.match(new RegExp(`(?:\\d\\D*){${n}}`));
   if (mSpan) {
     const d = mSpan[0].replace(/\D+/g,'').slice(0,n);
     if (d.length === n) return d;
   }
   const mTight = txt.match(new RegExp(`\\d{${n}}`));
   return mTight ? mTight[0] : null;
 }

function nearestContainerWithNDigits($,$start,n,$limit){
  // climb to the smallest ancestor that actually contains n-digit numbers
  let $node = $start;
  for (let i=0; i<6; i++){
    let $cand = $node.closest('li,article,div,section');
    if (!$cand.length) break;
    const has = new RegExp(`\\b\\d{${n}}\\b`).test(cleanTextBlocks($cand.text()));
    if (has) return $cand;
    $node = $cand.parent();
    if ($limit && $node.is($limit)) break;
  }
  return $start;
}

function extractByLabel($, label, n) {
  // 1) Limit scope to the "Latest numbers" section if present
  let $section = $('section').filter((_, el) => {
    const h = $(el).find('h1,h2,h3').first().text().trim().toLowerCase();
    return h.includes('latest') && h.includes('number');
  }).first();
  if (!$section.length) $section = $.root();

  // 2) Strict, whole-word label match (e.g., Day / Night / Midday / Evening)
  const re = CT_LABEL_RE[label] || new RegExp(label, 'i');
  const $labelEl = $section.find('*').filter((_, el) =>
    re.test($(el).text().trim().toLowerCase())
  ).first();
  if (!$labelEl.length) return { digits: null, date: null };

  // 3) Walk *forward* from the label (siblings-first) and stop if we hit the next label.
  const NEXT_LABEL_RE = /\b(day|night|midday|evening)\b/i;

  // Build a list of candidate nodes near the label, in DOM order
  const candidates = [];
  let walker = $labelEl;
  for (let steps = 0; steps < 40; steps++) {
    // Start with the label node, then explore its immediate next siblings,
    // then descend one level (avoids jumping to a wide ancestor that contains both draws)
    const $next = walker.next();
    if (!$next.length) break;
    walker = $next;

    const text = walker.text();
    if (steps > 0 && NEXT_LABEL_RE.test(text) && !re.test(text)) break; // we reached the other draw's block

    candidates.push(walker);
    // also consider small blocks inside this node
    candidates.push(...walker.find('li,div,p,span').toArray().map(el => $(el)));
    if (candidates.length > 80) break;
  }

  // 4) Prefer digit-by-digit nodes; fall back to safe text
  for (const $cand of candidates) {
    const d1 = pickConsecutiveSingleDigitNodes($, $cand, n);
      if (d1) {
    const d = parseDateFromText($cand.text()) ||
              parseDateFromText($labelEl.text()) ||
              parseDateFromText($.root().text());    // NEW: page-wide fallback
    return { digits: d1, date: d };
  }
    const d2 = pickNDigitsFromTextSafe($, $cand, n);
    if (d2) {
      const d = parseDateFromText($cand.text()) ||
                parseDateFromText($labelEl.text()) ||
                parseDateFromText($.root().text());    // NEW: page-wide fallback
      return { digits: d2, date: d };
    }
  }

  // 5) Last resort: use the label element itself
  const d3 = pickConsecutiveSingleDigitNodes($, $labelEl, n) || pickNDigitsFromTextSafe($, $labelEl, n);
  const d  = parseDateFromText($labelEl.text()) || parseDateFromText($.root().text()); // NEW fallback
  return { digits: d3, date: d };
}
// ── try a list of URLs; return {digits,date} without throwing ─────────────────
async function tryUrls(urls, label, n, tag){
  for (const u of urls){
    try{
      const html = await fetchHtml(u);
      const $    = cheerio.load(html);

      const isCT = /\/connecticut\//i.test(u);
      const isCtDedicated =
        /\/connecticut\/(midday|night)-[34]\//i.test(u) ||
        (label === 'Night' && /\/connecticut\/play-[34]\//i.test(u)); // Night lives on play-3/4

      const isGA = /\/georgia\//i.test(u);
      // Dedicated GA pages: midday-3/4, cash-3/4-evening, cash-3/4 (night)
      const isGaDedicated = /\/georgia\/(midday-[34]|cash-[34](?:-evening)?\/?)$/i.test(u);

      const isPA = /\/pennsylvania\//i.test(u);
      // Dedicated PA pages: midday-pick-3/4 and pick-3/4
      const isPaDedicated = /\/pennsylvania\/(midday-pick-[34]|pick-[34]\/?)$/i.test(u);

      let digits = null, date = null;

      if (isCT && isCtDedicated) {
        // CT dedicated draw pages – numbers appear without an adjacent draw label
        digits = extractFirstInLatest($, n);
        date   = parseDateFromText($.root().text()) || null;   // no forced “now”
      } else if (isCT) {
        // CT generic pages – use label-aware row extraction
        ({ digits, date } = extractRowByLabel($, label, n));
      } else if (isGA && isGaDedicated) {
        // GA dedicated pages (midday-3/4, cash-3/4-evening, cash-3/4)
        digits = extractFirstInLatest($, n);
        date   = parseDateFromText($.root().text()) || null;   // no forced “now”
      } else {
        // Generic case: look for a row near the label inside "Latest numbers"
        ({ digits, date } = extractByLabel($, label, n));
      }

      if (digits) return { digits, date };

    }catch(e){
      console.log(`[WARN] ${tag} ${u} -> ${e?.response?.status || e.message}`);
    }
  }
  return {digits:null, date:null};
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
  p3: {
    mid: { urls: [
      'https://www.lotteryusa.com/connecticut/midday-3/',   // dedicated CT Midday P3
      'https://www.lotteryusa.com/connecticut/play-3/'
    ], label: 'Midday' },
    eve: { urls: [
      'https://www.lotteryusa.com/connecticut/play-3/'
    ], label: 'Night' }
  },
  p4: {
    mid: { urls: [
      'https://www.lotteryusa.com/connecticut/midday-4/',   // dedicated CT Midday P4
      'https://www.lotteryusa.com/connecticut/play-4/'
    ], label: 'Midday' },
    eve: { urls: [
      'https://www.lotteryusa.com/connecticut/play-4/'
    ], label: 'Night' }
  }
},

  fl: {
    p3: { mid: { urls:[
                    'https://www.lotteryusa.com/florida/midday-pick-3/',
                    'https://www.lotteryusa.com/florida/pick-3/'
                  ], label:'Midday' },
          eve: { urls:[
                    'https://www.lotteryusa.com/florida/evening-pick-3/',
                    'https://www.lotteryusa.com/florida/pick-3/'
                  ], label:'Evening' } },
    p4: { mid: { urls:[
                    'https://www.lotteryusa.com/florida/midday-pick-4/',
                    'https://www.lotteryusa.com/florida/pick-4/'
                  ], label:'Midday' },
          eve: { urls:[
                    'https://www.lotteryusa.com/florida/evening-pick-4/',
                    'https://www.lotteryusa.com/florida/pick-4/'
                  ], label:'Evening' } }
  },
 ga: {
  p3: {
    mid: { urls: [
      'https://www.lotteryusa.com/georgia/midday-3/',
      'https://www.lotteryusa.com/georgia/'
    ], label: 'Midday' },
    eve: { urls: [
      'https://www.lotteryusa.com/georgia/cash-3-evening/',
      'https://www.lotteryusa.com/georgia/'
    ], label: 'Evening' },
    ngt: { urls: [
      'https://www.lotteryusa.com/georgia/cash-3/',
      'https://www.lotteryusa.com/georgia/'
    ], label: 'Night' }
  },
  p4: {
    mid: { urls: [
      'https://www.lotteryusa.com/georgia/midday-4/',
      'https://www.lotteryusa.com/georgia/'
    ], label: 'Midday' },
    eve: { urls: [
      'https://www.lotteryusa.com/georgia/cash-4-evening/',
      'https://www.lotteryusa.com/georgia/'
    ], label: 'Evening' },
    ngt: { urls: [
      'https://www.lotteryusa.com/georgia/cash-4/',
      'https://www.lotteryusa.com/georgia/'
    ], label: 'Night' }
  }
 },
pa: {
  p3: {
    mid: { urls: [
      'https://www.lotteryusa.com/pennsylvania/midday-pick-3/',
      'https://www.lotteryusa.com/pennsylvania/'
    ], label: 'Day' },        // PA calls this “Day”
    eve: { urls: [
      'https://www.lotteryusa.com/pennsylvania/pick-3/',
      'https://www.lotteryusa.com/pennsylvania/'
    ], label: 'Evening' }
  },
  p4: {
    mid: { urls: [
      'https://www.lotteryusa.com/pennsylvania/midday-pick-4/',
      'https://www.lotteryusa.com/pennsylvania/'
    ], label: 'Day' },
    eve: { urls: [
      'https://www.lotteryusa.com/pennsylvania/pick-4/',
      'https://www.lotteryusa.com/pennsylvania/'
    ], label: 'Evening' }
  }
},
  
};

// ── build "p3-p4" per draw and a trustworthy dateISO ──────────────────────────
async function combinedPair(stateKey){
  const S = U[stateKey];

  const jobs = [
    tryUrls(S.p3.mid.urls, S.p3.mid.label, 3, `${stateKey}.p3.mid`),
    tryUrls(S.p3.eve.urls, S.p3.eve.label, 3, `${stateKey}.p3.eve`),
    tryUrls(S.p4.mid.urls, S.p4.mid.label, 4, `${stateKey}.p4.mid`),
    tryUrls(S.p4.eve.urls, S.p4.eve.label, 4, `${stateKey}.p4.eve`)
  ];

  // Optional Night
  let hasNight = S.p3.ngt && S.p4.ngt;
  if (hasNight) {
    jobs.push(
      tryUrls(S.p3.ngt.urls, S.p3.ngt.label, 3, `${stateKey}.p3.ngt`),
      tryUrls(S.p4.ngt.urls, S.p4.ngt.label, 4, `${stateKey}.p4.ngt`)
    );
  }

  const results = await Promise.all(jobs);

  const ok = (s, n) => typeof s === 'string' && /^\d+$/.test(s) && s.length === n;

  const [mid3, eve3, mid4, eve4, n3, n4] =
    hasNight ? results : [...results, {digits:null,date:null}, {digits:null,date:null}];

  const m3 = ok(mid3.digits, 3) ? mid3.digits : null;
  const m4 = ok(mid4.digits, 4) ? mid4.digits : null;
  const e3 = ok(eve3.digits, 3) ? eve3.digits : null;
  const e4 = ok(eve4.digits, 4) ? eve4.digits : null;
  const nn3 = ok(n3.digits, 3) ? n3.digits : null;
  const nn4 = ok(n4.digits, 4) ? n4.digits : null;

  const midday  = (m3  && m4)  ? `${m3}-${m4}`   : null;
  const evening = (e3  && e4)  ? `${e3}-${e4}`   : null;
  const night   = (nn3 && nn4) ? `${nn3}-${nn4}` : null;

  // choose dates only from the halves we actually used
  const pickLatest = (a, b) => {
    if (a && b) return a.valueOf() >= b.valueOf() ? a : b;
    return a || b || null;
  };

  const middayDate  = midday  ? pickLatest(mid3.date, mid4.date) : null;
  const eveningDate = evening ? pickLatest(eve3.date, eve4.date) : null;
  const nightDate   = night   ? pickLatest(n3?.date,  n4?.date)  : null;

  const latest = [middayDate, eveningDate, nightDate].filter(Boolean)
    .sort((a,b)=>a.valueOf()-b.valueOf())
    .pop() || null;

  return {
    dateISO: (latest ? latest.tz('America/New_York')
                     : dayjs.tz(Date.now(), 'America/New_York')
            ).format('YYYY-MM-DD'),
    midday, evening, night
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
    res.status(200).json({
  dateISO: dayjs.tz(Date.now(), 'America/New_York').format('YYYY-MM-DD'),
  midday:null, evening:null, night:null
});
  }
});

// Static UI + health
app.use(express.static(path.join(__dirname,'public')));
app.get('/healthz', (_req,res)=>res.send('ok'));
app.get('*', (req,res,next)=>{ if(req.path.startsWith('/api/')) return next(); res.sendFile(path.join(__dirname,'public','index.html')); });

const PORT=process.env.PORT||3000;
app.listen(PORT, ()=>console.log('Bridge up on :'+PORT));
