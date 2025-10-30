// Service Worker (analyics-sw.js)
// - Pre-caches /index.html and /404.js
// - Provides offline support for downloaded game files (via PRECACHE_GAMES message)
// - For navigation (HTML) responses: network-first with timeout, fall back to cache, and when serving cached HTML
//   it injects <script src="/404.js"></script> into the <head> (or best available insertion point).
// - Exposes a small message API: PRECACHE_GAMES, CLEAR_MANIFEST, LIST_MANIFEST
//
// NOTE: This file intentionally uses the name "analyics-sw.js" to match pages that register that path.
// If other clients register "/analytics-sw.js" instead, deploy a copy with that filename too.

const CACHE_NAME = 'site-offline-cache-v1';
const PRECACHE_URLS = ['/index.html', '/404.js'];
const MANIFEST_CACHE_KEY = '/__sw_manifest.json';
const NETWORK_TIMEOUT_MS = 8000;

// Utility: network fetch with timeout
function fetchWithTimeout(request, ms = NETWORK_TIMEOUT_MS) {
  const controller = new AbortController();
  const signal = controller.signal;
  const promise = fetch(request, { signal });
  const t = setTimeout(() => controller.abort(), ms);
  return promise.finally(() => clearTimeout(t));
}

// Helpers for manifest persistence (store as JSON response in cache)
async function readManifest() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const r = await cache.match(MANIFEST_CACHE_KEY);
    if (!r) return {};
    const text = await r.text();
    return JSON.parse(text || '{}');
  } catch (e) {
    return {};
  }
}
async function writeManifest(manifest) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const resp = new Response(JSON.stringify(manifest || {}), {
      headers: { 'Content-Type': 'application/json' }
    });
    await cache.put(MANIFEST_CACHE_KEY, resp);
  } catch (e) {
    // ignore
  }
}

// Simple content-type check
function isHtmlContent(response) {
  try {
    if (!response || !response.headers) return false;
    const ct = response.headers.get('content-type') || '';
    return ct.includes('text/html') || ct.includes('application/xhtml+xml');
  } catch (e) {
    return false;
  }
}

// Insert script tag into HTML string's <head>. Conservative and robust.
function inject404ScriptToHtml(htmlText) {
  const scriptTag = '<script src="/404.js"></script>';
  try {
    const lower = htmlText.toLowerCase();
    const headIdx = lower.indexOf('<head');
    if (headIdx === -1) {
      // no head: try after <html ...>
      const htmlIdx = lower.indexOf('<html');
      if (htmlIdx !== -1) {
        const endOpen = lower.indexOf('>', htmlIdx);
        if (endOpen !== -1) {
          const insertPos = endOpen + 1;
          return htmlText.slice(0, insertPos) + scriptTag + htmlText.slice(insertPos);
        }
      }
      // fallback: prepend
      return scriptTag + htmlText;
    }
    // find end of opening <head ...> tag
    const headClose = lower.indexOf('>', headIdx);
    if (headClose === -1) return scriptTag + htmlText;
    const insertPos = headClose + 1;
    return htmlText.slice(0, insertPos) + scriptTag + htmlText.slice(insertPos);
  } catch (e) {
    return scriptTag + htmlText;
  }
}

// Normalize URL to root-relative or absolute as needed
function normalizeUrl(u) {
  if (!u) return null;
  try {
    // absolute:
    if (/^https?:\/\//i.test(u) || u.startsWith('//')) return u;
    return '/' + u.replace(/^\/+/, '');
  } catch (e) {
    return null;
  }
}

// Precache core assets on install
self.addEventListener('install', (evt) => {
  evt.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      await Promise.all(PRECACHE_URLS.map(u => cache.add(new Request(u, { cache: 'reload' }))).catch(()=>[]));
    } catch (e) {
      // ignore individual failures
    }
    // ensure manifest exists
    await writeManifest(await readManifest());
    // activate promptly
    try { await self.skipWaiting(); } catch (e) {}
  })());
});

// Claim clients on activation
self.addEventListener('activate', (evt) => {
  evt.waitUntil((async () => {
    try { await self.clients.claim(); } catch (e) {}
  })());
});

// Message API
// - { type: 'PRECACHE_GAMES', games: [ { name, files: ['/a','/b'] }, ... ] }
// - { type: 'CLEAR_MANIFEST' }
// - { type: 'LIST_MANIFEST' }
self.addEventListener('message', (ev) => {
  const data = ev.data || {};
  if (!data || !data.type) return;

  (async () => {
    try {
      if (data.type === 'PRECACHE_GAMES' && Array.isArray(data.games)) {
        const cache = await caches.open(CACHE_NAME);
        const manifest = await readManifest();
        for (const g of data.games) {
          if (!g || !Array.isArray(g.files)) continue;
          const key = g.name || ('game-' + Math.random().toString(36).slice(2,8));
          manifest[key] = manifest[key] || [];
          for (let f of g.files) {
            const nf = normalizeUrl(f);
            if (!nf) continue;
            try {
              const req = new Request(nf, { cache: 'no-store' });
              const resp = await fetchWithTimeout(req).catch(()=>null);
              if (resp && resp.ok) {
                await cache.put(req, resp.clone());
                if (!manifest[key].includes(nf)) manifest[key].push(nf);
              }
            } catch (e) {
              // ignore per-file error
            }
          }
        }
        await writeManifest(manifest);
        // Notify sender
        try { ev.source && ev.source.postMessage && ev.source.postMessage({ type: 'PRECACHE_COMPLETE', games: data.games.map(g => g.name) }); } catch (e) {}
      } else if (data.type === 'CLEAR_MANIFEST') {
        await writeManifest({});
        try { ev.source && ev.source.postMessage && ev.source.postMessage({ type: 'MANIFEST_CLEARED' }); } catch (e) {}
      } else if (data.type === 'LIST_MANIFEST') {
        const manifest = await readManifest();
        try { ev.source && ev.source.postMessage && ev.source.postMessage({ type: 'MANIFEST_LIST', manifest }); } catch (e) {}
      } else if (data.type === 'SITE_BLOCKED') {
        // noop for now; client informs SW that site was blocked/unblocked
        // potential to adjust behavior; keep as placeholder
      } else if (data.type === 'SET_ALLOWED_PATHS') {
        // optional: could be used to restrict precaching or navigation handling
      }
    } catch (e) {
      // swallow
    }
  })();
});

// Main fetch handler
self.addEventListener('fetch', (evt) => {
  const req = evt.request;

  // allow bypass by '?sw_bypass' query param
  try {
    const url = new URL(req.url);
    if (url.searchParams.has('sw_bypass')) return; // let default browser fetch happen
  } catch (e) {}

  // Manifest query endpoint
  try {
    const pathname = new URL(req.url).pathname;
    if (pathname === '/__sw_manifest.json') {
      evt.respondWith((async () => {
        const manifest = await readManifest();
        return new Response(JSON.stringify(manifest || {}), {
          headers: { 'Content-Type': 'application/json' }
        });
      })());
      return;
    }
  } catch (e) {
    // ignore
  }

  // Handle navigation requests (HTML)
  if (req.mode === 'navigate') {
    evt.respondWith((async () => {
      // Try network-first with timeout
      try {
        const netResp = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
        if (netResp && netResp.ok) {
          // Cache a copy for offline fallback (store under request URL so route-specific cached pages work)
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(req, netResp.clone()).catch(()=>{});
          } catch (e) {}
          return netResp;
        }
      } catch (e) {
        // network failed or timed out -> fall back
      }

      const cache = await caches.open(CACHE_NAME);

      // 1) Try exact cached page
      try {
        const match = await cache.match(req);
        if (match && isHtmlContent(match)) {
          const text = await match.text();
          const injected = inject404ScriptToHtml(text);
          return new Response(injected, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } else if (match) {
          return match;
        }
      } catch (e) {}

      // 2) Try index.html (precached)
      try {
        const idx = await cache.match('/index.html');
        if (idx && isHtmlContent(idx)) {
          const txt = await idx.text();
          const injected = inject404ScriptToHtml(txt);
          return new Response(injected, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } else if (idx) {
          return idx;
        }
      } catch (e) {}

      // 3) Try any cached HTML resource (scan keys)
      try {
        const keys = await cache.keys();
        for (const r of keys) {
          if (!r || !r.url) continue;
          if (r.url.endsWith('.html')) {
            const rr = await cache.match(r);
            if (rr) {
              if (isHtmlContent(rr)) {
                const t = await rr.text();
                const inj = inject404ScriptToHtml(t);
                return new Response(inj, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
              }
              return rr;
            }
          }
        }
      } catch (e) {}

      // 4) No cached HTML available: return an offline page that includes injected 404.js
      const offlineHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><script src="/404.js"></script></head><body><main style="font-family:system-ui, -apple-system, Roboto, Arial, sans-serif;padding:28px;"><h1>Offline</h1><p>The site is offline and no cached content is available.</p></main></body></html>`;
      return new Response(offlineHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    })());
    return;
  }

  // For other requests: cache-first then network fallback
  evt.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) {
      return cached;
    }

    // Try network, cache on success
    try {
      const netResp = await fetchWithTimeout(req, NETWORK_TIMEOUT_MS);
      if (netResp && netResp.ok) {
        // Only cache safe responses (same-origin or CORS allowed)
        try { await cache.put(req, netResp.clone()); } catch (e) {}
        return netResp;
      }
    } catch (e) {
      // network failed
    }

    // As a last resort, try to resolve via manifest mapping
    try {
      const manifest = await readManifest();
      const reqPath = new URL(req.url).pathname;
      for (const k of Object.keys(manifest || {})) {
        const arr = manifest[k];
        if (!Array.isArray(arr)) continue;
        for (const candidate of arr) {
          try {
            const candPath = new URL(candidate, self.location.origin).pathname;
            if (candPath === reqPath) {
              const c = await cache.match(candidate) || await cache.match(candPath);
              if (c) return c;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    // final fallback: 504
    return new Response('Gateway Timeout', { status: 504, statusText: 'Gateway Timeout' });
  })());
});

// Expose a simple endpoint to clear old caches if client requests
self.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'CLEAR_OLD_CACHES') {
    (async () => {
      const keys = await caches.keys();
      for (const k of keys) {
        if (k !== CACHE_NAME) {
          await caches.delete(k);
        }
      }
    })();
  }
});
