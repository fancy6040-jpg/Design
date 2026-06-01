#!/usr/bin/env node
/**
 * AI Weekly Content Collector
 * Fetches RSS feeds from P0/P1/P2 sources, filters last 30 days,
 * and outputs to data/weekly.json for the AI 周报 section.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');

const FEEDS_PATH = path.join(__dirname, 'feeds.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'weekly.json');
const DAYS_BACK = 30;
const REQUEST_TIMEOUT_MS = 12000;
const MAX_ITEMS_PER_SOURCE = 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

// RSS proxy services (tried in order when direct fetch fails)
const PROXY_TEMPLATES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}&count=${MAX_ITEMS_PER_SOURCE}`,
];

const BROWSER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

let agentIdx = 0;

function fetch(url, attempt = 0) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const ua = BROWSER_AGENTS[agentIdx++ % BROWSER_AGENTS.length];
    const req = mod.get(url, {
      headers: {
        'User-Agent': ua,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308)
          && res.headers.location) {
        return fetch(res.headers.location, attempt).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// rss2json.com returns JSON — parse that separately
function parseRss2JsonResponse(json, source) {
  let data;
  try { data = JSON.parse(json); } catch { return []; }
  if (!data.items) return [];
  return data.items.slice(0, MAX_ITEMS_PER_SOURCE).map(item => ({
    title: stripHtml(item.title || ''),
    link: item.link || item.guid || '',
    date: parseDate(item.pubDate),
    excerpt: truncate(stripHtml(item.description || item.content || ''), 160),
    source,
  })).filter(i => i.title);
}

async function fetchViaProxy(rssUrl, source) {
  for (const tmpl of PROXY_TEMPLATES) {
    const proxyUrl = tmpl(rssUrl);
    try {
      const body = await fetch(proxyUrl);
      // rss2json returns JSON; allorigins returns raw XML
      if (proxyUrl.includes('rss2json')) {
        const items = parseRss2JsonResponse(body, source);
        if (items.length > 0) return items;
      } else {
        const items = parseRSS(body, source);
        if (items.length > 0) return items;
      }
    } catch (e) {
      console.warn(`    proxy ${new URL(proxyUrl).hostname}: ${e.message}`);
    }
  }
  return [];
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function textOf(el, tagName) {
  if (!el) return '';
  const nodes = el.getElementsByTagName(tagName);
  if (!nodes || nodes.length === 0) return '';
  const node = nodes[0];
  return (node.textContent || node.innerHTML || '').trim();
}

function attrOf(el, tagName, attr) {
  if (!el) return '';
  const nodes = el.getElementsByTagName(tagName);
  if (!nodes || nodes.length === 0) return '';
  return (nodes[0].getAttribute(attr) || '').trim();
}

// Strip HTML tags for excerpt
function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function truncate(str, len) {
  if (!str || str.length <= len) return str || '';
  return str.slice(0, len).replace(/\s+\S*$/, '') + '…';
}

// ── RSS / Atom Parsers ────────────────────────────────────────────────────────

function parseRSS(xml, source) {
  const parser = new DOMParser();
  let doc;
  try {
    doc = parser.parseFromString(xml, 'text/xml');
  } catch (e) {
    throw new Error(`XML parse error: ${e.message}`);
  }

  const items = doc.getElementsByTagName('item');
  const entries = doc.getElementsByTagName('entry'); // Atom
  const nodes = items.length > 0 ? items : entries;
  const results = [];

  for (let i = 0; i < Math.min(nodes.length, MAX_ITEMS_PER_SOURCE); i++) {
    const item = nodes[i];
    const title = stripHtml(textOf(item, 'title'));
    if (!title) continue;

    // Link: try <link> text, then <link href="...">, then <guid>
    let link = textOf(item, 'link');
    if (!link) link = attrOf(item, 'link', 'href');
    if (!link) link = textOf(item, 'guid');

    // Date: pubDate (RSS) or published/updated (Atom)
    const dateStr = textOf(item, 'pubDate') || textOf(item, 'published') || textOf(item, 'updated');
    const date = parseDate(dateStr);

    // Description / summary / content
    const rawDesc = textOf(item, 'description') || textOf(item, 'summary') || textOf(item, 'content');
    const excerpt = truncate(stripHtml(rawDesc), 160);

    results.push({ title, link, date, excerpt, source });
  }
  return results;
}

// ── Per-source fetch with fallback ───────────────────────────────────────────

async function fetchSource(src) {
  const urls = [src.url, src.fallback].filter(Boolean);
  let lastErr;

  // Try direct fetch first
  for (const url of urls) {
    try {
      console.log(`  Fetching ${src.name}: ${url}`);
      const xml = await fetch(url);
      const items = parseRSS(xml, src);
      if (items.length > 0) {
        console.log(`  ✓ ${src.name}: ${items.length} items (direct)`);
        return items;
      }
    } catch (e) {
      console.warn(`  ✗ ${src.name} (${url}): ${e.message}`);
      lastErr = e;
    }
  }

  // Fallback: proxy services
  console.log(`  ↻ ${src.name}: trying proxy fallback...`);
  for (const url of urls) {
    const items = await fetchViaProxy(url, src);
    if (items.length > 0) {
      console.log(`  ✓ ${src.name}: ${items.length} items (via proxy)`);
      return items;
    }
  }

  console.error(`  ✗✗ ${src.name}: all methods failed`);
  return [];
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { sources } = JSON.parse(fs.readFileSync(FEEDS_PATH, 'utf8'));
  const cutoff = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);

  console.log(`\nCollecting feeds (last ${DAYS_BACK} days, cutoff: ${cutoff.toISOString().slice(0, 10)})\n`);

  // Fetch all sources (with concurrency cap of 4)
  const results = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch = sources.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(s => fetchSource(s)));
    results.push(...batchResults.flat());
  }

  // Build source metadata map
  const sourceMeta = Object.fromEntries(sources.map(s => [s.id, s]));

  // Filter to last 30 days, sort by priority then date desc
  const filtered = results
    .filter(item => item.date && item.date >= cutoff)
    .sort((a, b) => {
      const pa = sourceMeta[a.source.id]?.priority ?? 9;
      const pb = sourceMeta[b.source.id]?.priority ?? 9;
      if (pa !== pb) return pa - pb;
      return (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0);
    });

  // Serialise
  const output = {
    generated: new Date().toISOString(),
    cutoff: cutoff.toISOString(),
    total: filtered.length,
    sources_attempted: sources.length,
    items: filtered.map(item => ({
      title: item.title,
      link: item.link,
      excerpt: item.excerpt,
      date: item.date?.toISOString() ?? null,
      source_id: item.source.id,
      source_name: item.source.name,
      priority: sourceMeta[item.source.id]?.priority ?? 9,
      tags: sourceMeta[item.source.id]?.tags ?? [],
    })),
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nDone: ${filtered.length} items written to ${OUTPUT_PATH}`);

  // Print summary by source
  const bySource = {};
  for (const item of filtered) {
    bySource[item.source.name] = (bySource[item.source.name] ?? 0) + 1;
  }
  console.log('\nItems per source:');
  for (const [name, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${count}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
