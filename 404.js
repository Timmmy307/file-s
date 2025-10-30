// --- 404S detection core with 401 popup & access handling ---
// This file registers the analytics service worker at "/analyics-sw.js" (note the filename per request)
// and communicates with it to precache /index.html and any locally saved game files so offline navigation
// serves cached game pages and the SW can inject /404.js into HTML responses.
//
// Behaviour added:
// - Register '/analyics-sw.js' (best-effort).
// - On SW ready, send a message asking it to precache /index.html and any games saved in localStorage under
//   'game_dictionary_downloads' (same manifest key used by the client UI).
// - When blocking state changes we notify the SW.
// - Listen for messages from SW (REQUEST_CHECK_NOW, PERFORM_CLEAR_BLOCK, etc.).
// - Does not block existing logic; all SW interactions are best-effort and wrapped in try/catch.

(async function detect404S(){
    const allowedPaths = ['/error-v2.html', '/404.html'];
    const errorPagePath = '/error-v2.html';
    let isBlocked = false;
    let monitorId = null;

    // Keep references so we can restore original behavior when clearing block
    const originals = {};
    let handlersInstalled = false;

    // Try to register the analytics service worker (note: filename intentionally 'analyics-sw.js' per request)
    async function registerAnalyticsSW() {
        if (!('serviceWorker' in navigator)) return;
        try {
            // register the SW; don't await too long - best-effort
            const regPromise = navigator.serviceWorker.register('/analyics-sw.js').catch(()=>null);
            const reg = await regPromise;
            // Wait until ready (gives us a controller to message in many cases)
            try { await navigator.serviceWorker.ready; } catch (e) {}

            // When controller changes, we can resend manifest
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                try { sendPrecacheManifestToSW(); } catch (e) {}
            });

            // Send allowedPaths and ask SW to precache index + known games
            try {
                const msg = { type: 'SET_ALLOWED_PATHS', allowedPaths: allowedPaths.slice() };
                if (navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage(msg);
                } else if (reg && reg.active) {
                    reg.active.postMessage(msg);
                }
            } catch (e) {}

            // Ask SW to precache index.html explicitly and any saved games
            try { await sendPrecacheManifestToSW(); } catch (e) {}

        } catch (e) {
            // swallow errors; registration is best-effort
            // console.warn('Failed to register analyics-sw.js', e);
        }
    }

    // Read game manifest from localStorage (same key used by game UI)
    function readLocalGameManifest() {
        try {
            const raw = localStorage.getItem('game_dictionary_downloads') || localStorage.getItem('game_dictionary_downloads_v1') || '{}';
            const obj = JSON.parse(raw || '{}');
            // obj expected to be { gameName: [ '/path/a', '/path/b' ], ... }
            const games = [];
            for (const name of Object.keys(obj)) {
                const files = Array.isArray(obj[name]) ? obj[name].slice() : [];
                if (files.length === 0) {
                    files.push('/' + name.replace(/^\/+/, '') + '/index.html');
                }
                games.push({ name, files: files.map(f => normalizeFileUrl(f)) });
            }
            return games;
        } catch (e) {
            return [];
        }
    }

    function normalizeFileUrl(f) {
        if (!f) return null;
        try {
            // If absolute URL, keep as-is; otherwise make root-relative
            if (/^https?:\/\//i.test(f) || f.startsWith('//')) return f;
            return '/' + f.replace(/^\/+/, '');
        } catch (e) {
            return null;
        }
    }

    // Ask the SW to precache index and game files
    async function sendPrecacheManifestToSW() {
        if (!('serviceWorker' in navigator)) return;
        try {
            const games = readLocalGameManifest();
            const payload = { type: 'PRECACHE_GAMES', games: [] };

            // always include index.html
            payload.games.push({ name: '__index__', files: ['/index.html', '/404.js'] });

            // Add real games
            for (const g of games) {
                // filter nulls
                const validFiles = (g.files || []).map(normalizeFileUrl).filter(Boolean);
                if (validFiles.length === 0) continue;
                payload.games.push({ name: g.name || ('game-' + Math.random().toString(36).slice(2,8)), files: validFiles });
            }

            // post message to controller (prefer) or active registration
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage(payload);
            } else {
                const reg = await navigator.serviceWorker.getRegistration();
                if (reg && reg.active) reg.active.postMessage(payload);
            }
        } catch (e) {
            // ignore
        }
    }

    // Helper to post simple messages to SW (best-effort)
    function postToSW(msg) {
        try {
            if (!('serviceWorker' in navigator)) return;
            if (navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage(msg);
            } else {
                // attempt to get registration and message active worker
                navigator.serviceWorker.getRegistration().then(reg => {
                    if (reg && reg.active) {
                        try { reg.active.postMessage(msg); } catch (e) {}
                    }
                }).catch(()=>{});
            }
        } catch (e) {}
    }

    // attempt registration now, do not block flow
    registerAnalyticsSW().catch(()=>{});

    function ensureOnErrorPage() {
        if (location.pathname !== errorPagePath) {
            try { location.replace(errorPagePath); } catch (e) {}
        }
    }

    function parseTopCode(text) {
        if (!text) return '';
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return '';
        let codeLine = null;
        if (/^CODE:/i.test(lines[0])) codeLine = lines[0];
        else codeLine = lines.find(l => /^CODE:/i.test(l));
        if (!codeLine) return '';
        return (codeLine.split(':')[1] || '').trim();
    }

    // Parse extended info file for CODE, WHY, WHEN fields (best-effort)
    function parseInfo(text) {
        const out = { code: '', why: '', when: '' };
        if (!text) return out;
        try {
            const codeMatch = text.match(/CODE:\s*(.+)/i);
            if (codeMatch) out.code = (codeMatch[1] || '').trim();

            const whyMatch = text.match(/WHY:\s*([\s\S]*?)(?:\r?\n[A-Z]+:|$)/i);
            if (whyMatch) out.why = (whyMatch[1] || '').trim();

            const whenMatch = text.match(/WHEN:\s*(.+)/i);
            if (whenMatch) out.when = (whenMatch[1] || '').trim();
        } catch (e) {
            // parsing best-effort; ignore errors
        }
        return out;
    }

    // Named helper to check access cookie/localStorage "access" value equals "1"
    function hasAccess() {
        try {
            const m = document.cookie.match(/(?:^|;\s*)access=([^;]+)/);
            if (m && m[1] === '1') return true;
        } catch (e) {}
        try {
            if (localStorage.getItem('access') === '1') return true;
        } catch (e) {}
        return false;
    }

    // --- Navigation & form/click interception to enforce block ---
    function clickHandler(ev) {
        try {
            const a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
            if (!a || !a.href) return;
            const urlObj = new URL(a.href, location.href);
            if (urlObj.origin !== location.origin) return; // allow external links
            if (isBlocked && !allowedPaths.includes(urlObj.pathname)) {
                ev.preventDefault();
                ev.stopPropagation();
            }
        } catch (e) { /* ignore */ }
    }

    function submitHandler(ev) {
        try {
            const form = ev.target;
            const action = (form && form.getAttribute && form.getAttribute('action')) || location.pathname;
            const urlObj = new URL(action, location.href);
            if (urlObj.origin !== location.origin) return;
            if (isBlocked && !allowedPaths.includes(urlObj.pathname)) {
                ev.preventDefault();
                ev.stopPropagation();
            }
        } catch (e) { /* ignore */ }
    }

    function wrapNavigationOnce() {
        try {
            if (!originals.assign) originals.assign = window.location.assign;
            window.location.assign = function(href) {
                try {
                    const urlObj = new URL(href + '', location.href);
                    if (isBlocked && urlObj.origin === location.origin && !allowedPaths.includes(urlObj.pathname)) return;
                } catch (e) {}
                return originals.assign.apply(this, arguments);
            };
        } catch (e) { /* ignore */ }

        try {
            if (!originals.replace) originals.replace = window.location.replace;
            window.location.replace = function(href) {
                try {
                    const urlObj = new URL(href + '', location.href);
                    if (isBlocked && urlObj.origin === location.origin && !allowedPaths.includes(urlObj.pathname)) return;
                } catch (e) {}
                return originals.replace.apply(this, arguments);
            };
        } catch (e) { /* ignore */ }

        try {
            if (!originals.pushState) originals.pushState = history.pushState;
            history.pushState = function(state, title, url) {
                try {
                    const u = new URL((url === undefined || url === null) ? location.href : url + '', location.href);
                    if (isBlocked && u.origin === location.origin && !allowedPaths.includes(u.pathname)) return;
                } catch (e) {}
                return originals.pushState.apply(this, arguments);
            };
        } catch (e) { /* ignore */ }

        try {
            if (!originals.replaceState) originals.replaceState = history.replaceState;
            history.replaceState = function(state, title, url) {
                try {
                    const u = new URL((url === undefined || url === null) ? location.href : url + '', location.href);
                    if (isBlocked && u.origin === location.origin && !allowedPaths.includes(u.pathname)) return;
                } catch (e) {}
                return originals.replaceState.apply(this, arguments);
            };
        } catch (e) { /* ignore */ }
    }

    function installHandlers() {
        if (handlersInstalled) return;
        document.addEventListener('click', clickHandler, true);
        document.addEventListener('submit', submitHandler, true);
        wrapNavigationOnce();
        handlersInstalled = true;
    }

    function removeHandlers() {
        try {
            document.removeEventListener('click', clickHandler, true);
            document.removeEventListener('submit', submitHandler, true);
        } catch (e) { /* ignore */ }

        // Restore originals if we have them
        try { if (originals.assign) window.location.assign = originals.assign; } catch (e) {}
        try { if (originals.replace) window.location.replace = originals.replace; } catch (e) {}
        try { if (originals.pushState) history.pushState = originals.pushState; } catch (e) {}
        try { if (originals.replaceState) history.replaceState = originals.replaceState; } catch (e) {}

        handlersInstalled = false;
    }

    function applyBlock() {
        isBlocked = true;
        window.__SITE_404S_BLOCK = true;
        installHandlers();
        // Inform service worker about blocking state if possible
        try {
            postToSW({ type: 'SITE_BLOCKED', blocked: true, allowedPaths: allowedPaths.slice() });
        } catch (e) {}
    }

    function clearBlock() {
        isBlocked = false;
        window.__SITE_404S_BLOCK = false;
        removeHandlers();
        try {
            postToSW({ type: 'SITE_BLOCKED', blocked: false });
        } catch (e) {}
    }

    // --- 401 admin popup (shown only to users who have access==1) ---
    function show401Popup(reason, when) {
        try {
            if (document.getElementById('__popup_401')) return;
            const overlay = document.createElement('div');
            overlay.id = '__popup_401';
            overlay.style.position = 'fixed';
            overlay.style.left = '0';
            overlay.style.top = '0';
            overlay.style.width = '100%';
            overlay.style.height = '100%';
            overlay.style.background = 'rgba(0,0,0,0.45)';
            overlay.style.display = 'flex';
            overlay.style.alignItems = 'center';
            overlay.style.justifyContent = 'center';
            overlay.style.zIndex = '2147483647';

            const box = document.createElement('div');
            box.style.maxWidth = '540px';
            box.style.width = '90%';
            box.style.background = '#fff';
            box.style.color = '#111';
            box.style.padding = '18px';
            box.style.borderRadius = '8px';
            box.style.boxShadow = '0 8px 26px rgba(0,0,0,0.3)';
            box.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
            box.style.lineHeight = '1.3';

            const title = document.createElement('div');
            title.textContent = "Message from admin";
            title.style.fontWeight = '700';
            title.style.marginBottom = '8px';
            box.appendChild(title);

            // Quote the reason if present
            if (reason) {
                const q = document.createElement('div');
                q.textContent = '"' + reason + '"';
                q.style.background = '#f6f6f6';
                q.style.padding = '10px';
                q.style.borderRadius = '6px';
                q.style.whiteSpace = 'pre-wrap';
                box.appendChild(q);
            } else {
                const q = document.createElement('div');
                q.textContent = '(No reason provided)';
                q.style.color = '#666';
                box.appendChild(q);
            }

            if (when) {
                const whenDiv = document.createElement('div');
                whenDiv.textContent = 'Time: ' + when;
                whenDiv.style.marginTop = '10px';
                whenDiv.style.fontSize = '12px';
                whenDiv.style.color = '#444';
                box.appendChild(whenDiv);
            }

            const btnRow = document.createElement('div');
            btnRow.style.display = 'flex';
            btnRow.style.justifyContent = 'flex-end';
            btnRow.style.marginTop = '12px';

            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.textContent = 'Close';
            closeBtn.style.padding = '8px 12px';
            closeBtn.style.border = 'none';
            closeBtn.style.borderRadius = '6px';
            closeBtn.style.cursor = 'pointer';
            closeBtn.style.background = '#0070f3';
            closeBtn.style.color = '#fff';
            closeBtn.addEventListener('click', function() {
                try {
                    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                } catch (e) {}
                try {
                    if (when) {
                        localStorage.setItem('popup401', when);
                    } else {
                        // store a marker so we don't repeatedly spam if when missing
                        localStorage.setItem('popup401', 'shown');
                    }
                } catch (e) {}
            });

            btnRow.appendChild(closeBtn);
            box.appendChild(btnRow);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
        } catch (e) {
            // don't break the rest of the script
        }
    }

    // --- Core check function (polls info.txt on remote host) ---
    async function checkNow() {
        if (!navigator.onLine) return;
        try {
            // Target info URL (kept as explicit host as in original)
            const url = 'https://nice.code-faction.gleeze.com/info.txt?ts=' + Date.now();

            // Use AbortController to timeout the fetch if it hangs
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);

            const res = await fetch(url, {
                cache: 'no-store',
                headers: { 'Accept': 'text/plain' },
                mode: 'cors',
                signal: controller.signal
            });

            clearTimeout(timeout);

            // If the server doesn't allow CORS for your origin this fetch will throw
            if (!res || !res.ok) return;

            const text = await res.text();

            // Parse extended info
            const info = parseInfo(text);
            const code = info.code || parseTopCode(text);

            // Existing 404S behavior
            if (code === '404S') {
                if (!isBlocked) applyBlock();
                // immediate redirect if current path not allowed
                if (!allowedPaths.includes(window.location.pathname)) {
                    try { window.location.replace('/index.html'); } catch (e) {}
                }
                // ensure user stays on the designated error page as a short-term monitor
                ensureOnErrorPage();
                if (!monitorId) {
                    monitorId = setInterval(ensureOnErrorPage, 500);
                }
            } else {
                if (isBlocked) clearBlock();
                if (monitorId) {
                    clearInterval(monitorId);
                    monitorId = null;
                }
            }

            // New: if CODE: 401 is present, show admin popup only for users with access=1
            try {
                const has401 = /^401$/i.test((info.code || '').trim()) || /CODE:\s*401/i.test(text);
                if (has401) {
                    // Only proceed if user has the access cookie/localStorage value set to "1"
                    if (!hasAccess()) {
                        // user lacks access flag; do not show popup
                    } else {
                        const when = (info.when || '').trim();
                        const why = (info.why || '').trim();

                        let skip = false;
                        try {
                            const stored = localStorage.getItem('popup401');
                            if (stored && when && stored === when) skip = true;
                        } catch (e) {
                            // localStorage may be unavailable; treat as not skipped
                            skip = false;
                        }

                        if (!skip) {
                            show401Popup(why || 'Message from admin', when);
                        }
                    }
                }
            } catch (e) {
                // ignore popup errors
            }

        } catch (e) {
            // network or parsing errors -> log limited info but continue polling
            if (e && e.name === 'AbortError') {
                // timed out; ignore
            } else {
                // Could be CORS or network error; ignore to avoid breaking site
            }
        }
    }

    // Listen for messages from service worker (if controlled) to react to SW events
    if ('serviceWorker' in navigator && navigator.serviceWorker.addEventListener) {
        navigator.serviceWorker.addEventListener('message', (ev) => {
            const data = ev && ev.data;
            if (!data) return;
            try {
                if (data.type === 'REQUEST_CHECK_NOW') {
                    // SW asks client to re-run the info.txt check
                    checkNow().catch(()=>{});
                } else if (data.type === 'SET_ALLOWED_PATHS' && Array.isArray(data.allowedPaths)) {
                    // allow SW to suggest adjustments to allowedPaths, but only accept array
                    try {
                        // Replace allowedPaths but ensure errorPagePath stays allowed
                        const incoming = data.allowedPaths.slice();
                        if (!incoming.includes(errorPagePath)) incoming.push(errorPagePath);
                        // mutate local allowedPaths variable safely
                        while (allowedPaths.length) allowedPaths.pop();
                        incoming.forEach(p => allowedPaths.push(p));
                    } catch (e) {}
                } else if (data.type === 'PERFORM_CLEAR_BLOCK') {
                    // SW requests that the client clear block UI
                    clearBlock();
                } else if (data.type === 'PRECACHE_COMPLETE') {
                    // SW reports it's precached resources; nothing required but we might refresh UI
                    // re-send manifest next time manifest changes; no-op here
                }
            } catch (e) {
                // ignore message handling errors
            }
        });
    }

    // Immediate check and then poll every 5-10s (randomized)
    (function pollLoop() {
        checkNow().finally(() => {
            const next = 5000 + Math.floor(Math.random() * 5001); // 5000-10000 ms
            setTimeout(pollLoop, next);
        });
    })();

    // Also check once before unload/navigation to ensure decisions are current
    window.addEventListener('beforeunload', function() {
        try { navigator.sendBeacon && checkNow(); } catch (e) {}
    });

})();
