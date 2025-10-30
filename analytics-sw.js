// Service worker to support offline game bundles and inject 404.js into HTML pages.
//
// Features:
// - Pre-caches /index.html and /404.js on install.
// - Provides a message API so the page can ask the SW to cache additional game files.
//   (Clients should postMessage({type: 'CACHE_URLS', urls: [...]}) )
// - For navigation requests (HTML), attempts network-first then falls back to cache.
//   When serving an HTML response from the cache, it will inject a <script src="/404.js"> into the <head>.
// - For other requests, serves from cache first, then network and populates cache dynamically.
// - Exposes a helper endpoint via fetch to list cached game manifest stored in IndexedDB-like localStorage fallback
//   (Because SW can't directly access page localStorage, we store manifest in cache as JSON at /__sw_manifest).
//
// Notes:
// - This file aims to be robust: it times out network fetches, gracefully handles non-HTML content,
//   and avoids breaking binary responses when attempting to inject.
// - The script-injection is conservative: it only injects into responses that look like HTML text and have a <head> tag.

const CACHE_NAME = 'site-offline-cache-v1';
const PRECACHE_URLS = [
  '/index.html',
  '/404.js' // ensure 404.js is available for injection
];

const MANIFEST_CACHE_URL = '/__sw_manifest'; // stored as a cached JSON response representing cached manifest

// Network timeout helper (returns fetch or rejects with AbortError)
function fetchWithTimeout(request, ms = 8000) {
  const controller = new AbortController();
  const signal = controller.signal;
  const p = fetch(request, { signal });
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return p.finally(() => clearTimeout(timeoutId));
}

// Utility: detect if response is HTML-like
function isHtmlResponse(response) {
  if (!response || !response.headers) return false;
  const ct = response.headers.get('content-type') || '';
  return ct.includes('text/html') || ct.includes('application/xhtml+xml');
}

// Inject a script tag into the <head> of an HTML string
function injectScriptIntoHtmlString(htmlStr, scriptTag) {
  try {
    const lower = htmlStr.toLowerCase();
    const headIndex = lower.indexOf('<head');
    if (headIndex === -1) {
      // No head tag — try injecting after <html> if present
      const htmlIndex = lower.indexOf('<html');
      if (htmlIndex !== -1) {
        const closeHtmlTag = lower.indexOf('>', htmlIndex);
        if (closeHtmlTag !== -1) {
          // insert after closing <html ...>
          const idx = closeHtmlTag + 1;
          return htmlStr.slice(0, idx) + scriptTag + htmlStr.slice(idx);
        }
      }
      // fallback: prepend
      return scriptTag + htmlStr;
    }
    // find the end of the opening <head...> tag
    const headOpenClose = lower.indexOf('>', headIndex);
    if (headOpenClose === -1) return scriptTag + htmlStr;
    const insertIdx = headOpenClose + 1;
    return htmlStr.slice(0, insertIdx) + scriptTag + htmlStr.slice(insertIdx);
  } catch (e) {
    return scriptTag + htmlStr;
  }
}

// Store manifest JSON in cache as a Response so SW and clients can fetch it.
async function saveManifestObject(obj) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const body = JSON.stringify(obj || {});
    const resp = new Response(body, { headers: { 'Content-Type': 'application/json' } });
    await cache.put(MANIFEST_CACHE_URL, resp);
  } catch (e) {
    // swallow
  }
}

async function readManifestObject() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const r = await cache.match(MANIFEST_CACHE_URL);
    if (!r) return {};
    const text = await r.text();
    return JSON.parse(text || '{}');
  } catch (e) {
    return {};
  }
}

self.addEventListener('install', (ev) => {
  ev.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Precache key files (index + 404.js)
    await cache.addAll(PRECACHE_URLS.map(u => new Request(u, {cache: 'reload'})).catch(()=>[]));
    // ensure manifest exists
    await saveManifestObject({});
    // Activate immediately
    try { await self.skipWaiting(); } catch (e) {}
  })());
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil((async () => {
    // Claim clients so pages are controlled immediately
    try { await self.clients.claim(); } catch (e) {}
  })());
});

// Handle messages from clients to cache additional URLs
// Expected message shapes:
// { type: 'CACHE_URLS', urls: ['...','...'] }  -> cache the listed urls (PUT into cache) and record them in manifest
// { type: 'UNCACHE_URLS', urls: [...] } -> remove from cache and manifest
// { type: 'CLEAR_MANIFEST' } -> clear recorded manifest (does not necessarily remove all cached files)
self.addEventListener('message', (ev) => {
  const data = ev.data || {};
  if (!data || !data.type) return;

  (async () => {
    try {
      if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
        const cache = await caches.open(CACHE_NAME);
        const manifest = await readManifestObject();
        for (let u of data.urls) {
          if (!u) continue;
          // normalize (ensure absolute path for same-origin)
          try {
            // allow absolute URLs too
            const req = new Request(u, {cache: 'no-store'});
            const resp = await fetchWithTimeout(req).catch(()=>null);
            if (resp && resp.ok) {
              await cache.put(req, resp.clone());
              // record in manifest under a special bucket 'manual'
              manifest.manual = manifest.manual || [];
              if (!manifest.manual.includes(u)) manifest.manual.push(u);
            }
          } catch (e) {
            // ignore per-url errors
          }
        }
        await saveManifestObject(manifest);
        // optionally reply to client
        try {
          ev.source && ev.source.postMessage && ev.source.postMessage({ type: 'CACHE_COMPLETE', urls: data.urls });
        } catch (e) {}
      } else if (data.type === 'UNCACHE_URLS' && Array.isArray(data.urls)) {
        const cache = await caches.open(CACHE_NAME);
        const manifest = await readManifestObject();
        for (let u of data.urls) {
          try {
            await cache.delete(u);
            if (manifest.manual) {
              manifest.manual = manifest.manual.filter(x => x !== u);
            }
            // Also remove from other manifest buckets if present
            for (const k of Object.keys(manifest)) {
              if (Array.isArray(manifest[k])) manifest[k] = manifest[k].filter(x => x !== u);
            }
          } catch (e) {}
        }
        await saveManifestObject(manifest);
        try { ev.source && ev.source.postMessage && ev.source.postMessage({ type: 'UNCACHE_COMPLETE', urls: data.urls }); } catch (e) {}
      } else if (data.type === 'CLEAR_MANIFEST') {
        await saveManifestObject({});
        try { ev.source && ev.source.postMessage && ev.source.postMessage({ type: 'MANIFEST_CLEARED' }); } catch (e) {}
      } else if (data.type === 'PRECACHE_GAMES' && Array.isArray(data.games)) {
        // Accepts an array of {name: 'gameName', files: ['/a','/b']} and caches each file and records under manifest[name]
        const cache = await caches.open(CACHE_NAME);
        const manifest = await readManifestObject();
        for (const game of data.games) {
          if (!game || !game.name || !Array.isArray(game.files)) continue;
          manifest[game.name] = manifest[game.name] || [];
          for (let f of game.files) {
            if (!f) continue;
            try {
              const req = new Request(f, {cache: 'no-store'});
              const resp = await fetchWithTimeout(req).catch(()=>null);
              if (resp && resp.ok) {
                await cache.put(req, resp.clone());
                if (!manifest[game.name].includes(f)) manifest[game.name].push(f);
              }
            } catch (e) {}
          }
        }
        await saveManifestObject(manifest);
        try { ev.source && ev.source.postMessage && ev.source.postMessage({ type: 'PRECACHE_COMPLETE', games: data.games.map(g => g.name) }); } catch (e) {}
      }
    } catch (e) {
      // ignore
    }
  })();
});

// Main fetch handler:
// - For navigations: try network first (fast), if fails -> serve cached index.html or other cached HTML and inject /404.js
// - For other requests: try cache, else network (and cache response)
self.addEventListener('fetch', (ev) => {
  const req = ev.request;

  // Allow bypassing service worker when client requests '?sw_bypass'
  try {
    const urlObj = new URL(req.url);
    if (urlObj.searchParams.has('sw_bypass')) {
      return; // let browser do default fetch
    }
  } catch (e) {}

  // Special: respond to manifest fetch
  if (new URL(req.url).pathname === '/__sw_manifest') {
    ev.respondWith((async () => {
      const manifest = await readManifestObject();
      return new Response(JSON.stringify(manifest || {}), {
        headers: { 'Content-Type': 'application/json' }
      });
    })());
    return;
  }

  // Navigation requests (user typing URL or SPA navigations)
  if (req.mode === 'navigate') {
    ev.respondWith((async () => {
      // Try network-first but with timeout so slow networks don't hang
      try {
        const networkResp = await fetchWithTimeout(req, 8000);
        // If we got a valid HTML response, optionally cache a copy of the navigation result
        if (networkResp && networkResp.ok) {
          // put a copy into cache for offline fallback
          try {
            const cache = await caches.open(CACHE_NAME);
            // store network response clone as route-specific fallback if desired
            // (do not clobber INDEX.HTML; keep a separate key)
            await cache.put(req, networkResp.clone()).catch(()=>{});
          } catch (e) {}
          return networkResp;
        }
      } catch (e) {
        // network failed or timeout -> fallback to cache
      }

      // Fallback strategy: prefer /index.html then any cached HTML matching request
      const cache = await caches.open(CACHE_NAME);

      // First try to serve exact cached entry
      let cached = await cache.match(req);
      if (cached && isHtmlResponse(cached)) {
        // inject script if needed
        try {
          const text = await cached.text();
          const injected = injectScriptIntoHtmlString(text, '<script src="/404.js"></script>');
          return new Response(injected, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        } catch (e) {
          return cached;
        }
      }

      // Then try index.html (precached)
      cached = await cache.match('/index.html');
      if (cached && isHtmlResponse(cached)) {
        try {
          const text = await cached.text();
          const injected = injectScriptIntoHtmlString(text, '<script src="/404.js"></script>');
          return new Response(injected, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        } catch (e) {
          return cached;
        }
      }

      // As a last resort, try any cached HTML entry
      const keys = await cache.keys();
      for (const r of keys) {
        try {
          if (r.url && r.url.endsWith('.html')) {
            const rr = await cache.match(r);
            if (rr) {
              if (isHtmlResponse(rr)) {
                try {
                  const text = await rr.text();
                  const injected = injectScriptIntoHtmlString(text, '<script src="/404.js"></script>');
                  return new Response(injected, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
                } catch (e) { return rr; }
              } else {
                return rr;
              }
            }
          }
        } catch (e) {}
      }

      // No cache available; return an offline fallback HTML constructed here
      const offlineHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><script src="/404.js"></script></head><body><h1>Offline</h1><p>The site is offline and no cached content is available.</p></body></html>`;
      return new Response(offlineHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    })());
    return;
  }

  // For non-navigation requests:
  ev.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) {
      // Return cached copy (use clone to allow body consumption)
      return cached;
    }

    // Attempt network fetch and cache result (but skip opaque responses for security unless necessary)
    try {
      const networkResp = await fetchWithTimeout(req, 8000);
      if (networkResp && networkResp.ok) {
        // Clone and cache for subsequent offline use
        try {
          // Only cache same-origin or CORS-allowed responses
          await cache.put(req, networkResp.clone()).catch(() => {});
        } catch (e) {}
        return networkResp;
      }
      // If network returned non-ok, try to read cached manifest for file mapping
    } catch (e) {
      // network failed; fall through
    }

    // final fallback: if request looks for a game file and manifest maps it to another cached resource,
    // attempt to resolve from manifest
    try {
      const manifest = await readManifestObject();
      // manifest expected structure: { "<gameName>": ["/path/a","/path/b"], manual: [...] }
      // Try to find any entry that endsWith the requested pathname and return that cached entry
      const reqPath = new URL(req.url).pathname;
      for (const key of Object.keys(manifest || {})) {
        const arr = manifest[key];
        if (!Array.isArray(arr)) continue;
        for (const candidate of arr) {
          try {
            const candPath = new URL(candidate, location.origin).pathname;
            if (candPath === reqPath) {
              const c = await cache.match(candidate) || await cache.match(candPath);
              if (c) return c;
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    // Finally, return a network error response
    return new Response('Network error', { status: 504, statusText: 'Gateway Timeout' });
  })());
});

// Optional: cleanup old caches if you change CACHE_NAME in future versions
self.addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'CLEAR_OLD_CACHES') {
    (async () => {
      const keys = await caches.keys();
      for (const k of keys) {
        if (k !== CACHE_NAME) await caches.delete(k);
      }
    })();
  }
});
