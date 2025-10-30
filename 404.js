// --- 404S detection core ---
(async function detect404S(){
    const allowedPath = '/error-v2.html';
    let isBlocked = false;
    let monitorId = null;

    function ensureOnErrorPage() {
        if (location.pathname !== allowedPath) {
            try { location.replace(allowedPath); } catch (e) {}
        }
    }

    async function parseTopCode(text) {
        if (!text) return '';
        const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const codeLine = lines.find(l => /^CODE:/i.test(l));
        return codeLine ? (codeLine.split(':')[1] || '').trim() : '';
    }

    async function checkNow() {
        if (!navigator.onLine) return;
        try {
            // FIXED: remove duplicated https:// in URL
            const url = 'https://nice.code-faction.gleeze.com/info.txt?ts=' + Date.now();

            // Use AbortController to timeout the fetch if it hangs
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 8000);

            const res = await fetch(url, {
                cache: 'no-store',
                headers: { 'Accept': 'text/plain' },
                mode: 'cors', // default, explicit for clarity
                signal: controller.signal
            });

            clearTimeout(timeout);

            // If the server doesn't allow CORS for your origin this fetch will throw
            if (!res.ok) return;

            const text = await res.text();
            const code = await parseTopCode(text);

            if (code === '404S') {
                if (!isBlocked) {
                    isBlocked = true;
                    console.warn('[404S] Site restriction activated.');
                }
                // Immediately ensure user is on the error page and start a short monitor
                ensureOnErrorPage();
                if (!monitorId) {
                    monitorId = setInterval(ensureOnErrorPage, 500);
                }
            } else {
                if (isBlocked) {
                    isBlocked = false;
                    console.log('[404S] Restriction cleared.');
                }
                if (monitorId) {
                    clearInterval(monitorId);
                    monitorId = null;
                }
            }
        } catch (e) {
            // A TypeError can indicate a CORS failure or network error
            if (e.name === 'AbortError') {
                console.error('[404S check error] request timed out');
            } else {
                console.error('[404S check error]', e);
            }
        }
    }

    (function pollLoop(){
        checkNow().finally(()=>{
            const next = 5000 + Math.random() * 5000;
            setTimeout(pollLoop, next);
        });
    })();
})();
