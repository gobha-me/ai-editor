/**
 * AI Editor — Preview Tier 2 console + error capture shim (2.7.0).
 *
 * Plain script (not an ES module). Loaded by `service-worker.js` via
 * `importScripts('./preview-shim.js')` at SW startup. Defines a single
 * global `self.PREVIEW_SHIM_SOURCE` containing the actual capture IIFE
 * as a string — the SW prepends that string inside a `<script>` tag at
 * the top of every HTML response so it runs **before** any workspace
 * `<script>` tag and seals its captured `console` / `window` references
 * before user code can reassign them.
 *
 * The shim posts events to `window.parent` (same-origin in Tier 1's
 * single-origin posture — see [`preview-host.js:259-285`](./preview-host.js)
 * for the trust-boundary trade-off). The host's message listener
 * validates `event.source` against the registered iframe's
 * `contentWindow` before routing the event into a per-`serverId` ring
 * buffer. The shim has no idea which `serverId` it belongs to; the
 * host attributes the event by source.
 *
 * Per `docs/DESIGN-preview.md` §"Worker shim load order":
 *   - The shim runs first.
 *   - Captures `console.{log, info, warn, error, debug}` references in
 *     `const`s and reinstalls them as non-writable / non-configurable
 *     properties — `Object.defineProperty` with `writable: false` so
 *     workspace JS cannot unhook by `console.log = …`.
 *   - Hooks `window.onerror` (capture phase) AND `unhandledrejection`.
 *
 * @since 2.7.0
 */

self.PREVIEW_SHIM_SOURCE = `(function previewShim() {
    if (window.__previewShimInstalled) return;
    try {
        Object.defineProperty(window, '__previewShimInstalled', {
            value: true, writable: false, configurable: false, enumerable: false,
        });
    } catch (_) { window.__previewShimInstalled = true; }

    var MAX_LEN = 4096;
    var realConsole = console;
    var realParent = window.parent;
    var realPost = realParent && realParent.postMessage ? realParent.postMessage.bind(realParent) : null;
    var realDateNow = Date.now.bind(Date);
    if (!realPost) return;

    function truncate(s) {
        if (typeof s !== 'string') return s;
        if (s.length <= MAX_LEN) return s;
        return s.slice(0, MAX_LEN) + '\u2026[truncated]';
    }

    function stringify(a) {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message || String(a);
        if (a === null || a === undefined) return String(a);
        try { return JSON.stringify(a); } catch (_) { return String(a); }
    }

    function post(payload) {
        try { realPost(payload, '*'); } catch (_) { /* swallow */ }
    }

    var levels = ['log', 'info', 'warn', 'error', 'debug'];
    for (var i = 0; i < levels.length; i++) {
        (function (level) {
            var orig = realConsole[level];
            var origBound = (orig && typeof orig.bind === 'function') ? orig.bind(realConsole) : null;
            function wrapped() {
                try {
                    var args = new Array(arguments.length);
                    for (var k = 0; k < arguments.length; k++) args[k] = arguments[k];
                    var message = truncate(args.map(stringify).join(' '));
                    post({ __preview: true, type: 'console', level: level, message: message, ts: realDateNow() });
                } catch (_) { /* swallow */ }
                if (origBound) {
                    try { origBound.apply(null, arguments); } catch (_) {}
                }
            }
            try {
                Object.defineProperty(realConsole, level, {
                    value: wrapped, writable: false, configurable: false,
                });
            } catch (_) {
                try { realConsole[level] = wrapped; } catch (__) {}
            }
        })(levels[i]);
    }

    window.addEventListener('error', function (e) {
        try {
            post({
                __preview: true,
                type: 'error',
                message: truncate(e.message || ''),
                source: e.filename || '',
                line: typeof e.lineno === 'number' ? e.lineno : null,
                col: typeof e.colno === 'number' ? e.colno : null,
                stack: e.error && e.error.stack ? truncate(e.error.stack) : null,
                ts: realDateNow(),
            });
        } catch (_) {}
    }, true);

    window.addEventListener('unhandledrejection', function (e) {
        try {
            var reason = e.reason;
            var msg = (reason && reason.message) ? String(reason.message) : (reason === undefined ? 'undefined' : String(reason));
            var stack = (reason && reason.stack) ? String(reason.stack) : null;
            post({
                __preview: true,
                type: 'error',
                message: 'Unhandled rejection: ' + truncate(msg),
                source: '',
                line: null,
                col: null,
                stack: stack ? truncate(stack) : null,
                ts: realDateNow(),
            });
        } catch (_) {}
    });
})();`;
