/**
 * AI Editor — Preview Tier 2 + Tier 3a shim (2.7.0 / 2.10.0).
 *
 * Plain script (not an ES module). Loaded by `service-worker.js` via
 * `importScripts('./preview-shim.js')` at SW startup. Defines a single
 * global `self.PREVIEW_SHIM_SOURCE` containing the actual IIFE as a
 * string — the SW prepends that string inside a `<script>` tag at the
 * top of every HTML response so it runs **before** any workspace
 * `<script>` tag and seals its captured `console` / `window` / DOM
 * references before user code can reassign them.
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
 *   - **Tier 3a (2.10.0):** listens for inbound `dir: 'req'` envelopes
 *     and dispatches click / fill / inspect / snapshot handlers against
 *     reference-sealed DOM primitives (`Element.prototype.querySelector`,
 *     `getComputedStyle`, etc.), replying with `dir: 'res'` correlated
 *     by `requestId`. Workspace JS cannot poison the driving path —
 *     reassigning `console.log` / `Element.prototype.querySelector`
 *     after the shim runs has no effect on captured references.
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

    /* === Tier 3a (2.10.0) — driveable preview === */

    // Reference-seal DOM primitives at IIFE init. Workspace JS that later
    // overrides Element.prototype.querySelector / window.getComputedStyle
    // cannot poison the driving path because we hold a captured reference
    // before user code runs.
    var realDocQuerySelector = Document.prototype.querySelector;
    var realGetComputedStyle = window.getComputedStyle.bind(window);
    var realAddEventListener = window.addEventListener.bind(window);
    var realObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    var realObjectGetPrototypeOf = Object.getPrototypeOf;
    var realLocation = window.location;

    function safeFindOne(selector) {
        try { return realDocQuerySelector.call(document, selector); }
        catch (_) { return null; }
    }

    function bbox(el) {
        try {
            var r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        } catch (_) { return { x: 0, y: 0, w: 0, h: 0 }; }
    }

    function isVisible(el) {
        try {
            var r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return false;
            var cs = realGetComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
            return true;
        } catch (_) { return false; }
    }

    function handleClick(req) {
        var el = safeFindOne(req.selector);
        if (!el) return { ok: false, error: 'not_found', message: "selector '" + req.selector + "' matched no element" };
        try {
            if (req.doubleClick) {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
            } else if (typeof el.click === 'function') {
                el.click();
            } else {
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
            return { ok: true, clicked: true, tag: el.tagName ? el.tagName.toLowerCase() : '' };
        } catch (e) {
            return { ok: false, error: 'click_failed', message: String(e && e.message || e) };
        }
    }

    function handleFill(req) {
        var el = safeFindOne(req.selector);
        if (!el) return { ok: false, error: 'not_found', message: "selector '" + req.selector + "' matched no element" };
        if (!('value' in el)) return { ok: false, error: 'not_fillable', message: 'element <' + (el.tagName || '').toLowerCase() + '> has no value property' };
        try {
            // Native setter on the prototype — bypasses framework-rebound
            // input setters (React etc.) that skip events on plain assignment.
            var proto = realObjectGetPrototypeOf(el);
            var desc = proto ? realObjectGetOwnPropertyDescriptor(proto, 'value') : null;
            if (desc && typeof desc.set === 'function') desc.set.call(el, req.value);
            else el.value = req.value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, filled: true, value: String(req.value) };
        } catch (e) {
            return { ok: false, error: 'fill_failed', message: String(e && e.message || e) };
        }
    }

    function handleInspect(req) {
        var el = safeFindOne(req.selector);
        if (!el) return { ok: false, error: 'not_found', message: "selector '" + req.selector + "' matched no element" };
        try {
            var cs = realGetComputedStyle(el);
            var styleKeys = (req.styles && req.styles.length)
                ? req.styles
                : ['display', 'visibility', 'opacity', 'color', 'backgroundColor', 'fontSize', 'fontFamily'];
            var computedStyle = {};
            for (var i = 0; i < styleKeys.length; i++) {
                try { computedStyle[styleKeys[i]] = String(cs[styleKeys[i]]); } catch (_) {}
            }
            var text = el.textContent ? truncate(el.textContent) : '';
            return {
                ok: true,
                tagName: el.tagName ? el.tagName.toLowerCase() : '',
                id: el.id || '',
                className: typeof el.className === 'string' ? el.className : '',
                textContent: text,
                computedStyle: computedStyle,
                boundingBox: bbox(el),
            };
        } catch (e) {
            return { ok: false, error: 'inspect_failed', message: String(e && e.message || e) };
        }
    }

    function handleSnapshot(req) {
        try {
            var MAX = 500;
            var visibleOnly = req.visibleOnly !== false;  // default true
            var elements = [];
            var counter = 0;
            var skipTags = { script: 1, style: 1, meta: 1, link: 1, head: 1, title: 1, noscript: 1 };

            function visit(el) {
                if (elements.length >= MAX) return;
                var tag = el.tagName ? el.tagName.toLowerCase() : '';
                if (skipTags[tag]) return;
                var visible = isVisible(el);
                if (visibleOnly && !visible) return;
                var uid = 'u_' + (counter++);
                try { el.setAttribute('data-preview-uid', uid); } catch (_) {}
                var role = (el.getAttribute && el.getAttribute('role')) || '';
                var name = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title'))) || '';
                // Direct child-text only — child elements emit their own text.
                var text = '';
                for (var c = 0; c < el.childNodes.length; c++) {
                    var cn = el.childNodes[c];
                    if (cn.nodeType === 3) text += cn.nodeValue;
                }
                text = text.replace(/\\s+/g, ' ').trim();
                if (text.length > 200) text = text.slice(0, 200) + '\u2026';

                var entry = {
                    uid: uid, tag: tag, role: role, name: name, text: text, visible: visible, bbox: bbox(el),
                };
                if (tag === 'input' || tag === 'textarea' || tag === 'select') {
                    entry.value = String(el.value || '').slice(0, 100);
                    entry.type = el.type || '';
                    entry.disabled = !!el.disabled;
                } else if (tag === 'a') {
                    entry.href = el.getAttribute('href') || '';
                } else if (tag === 'button') {
                    entry.disabled = !!el.disabled;
                }
                elements.push(entry);

                // Don't recurse into nested iframes — emit the outer frame only.
                if (tag === 'iframe') return;
                if (!el.children) return;
                for (var k = 0; k < el.children.length; k++) {
                    if (elements.length >= MAX) break;
                    visit(el.children[k]);
                }
            }
            var root = document.body || document.documentElement;
            if (root) visit(root);
            return {
                ok: true,
                elements: elements,
                truncated: elements.length >= MAX,
                url: realLocation && realLocation.href ? String(realLocation.href) : '',
                title: document.title || '',
            };
        } catch (e) {
            return { ok: false, error: 'snapshot_failed', message: String(e && e.message || e) };
        }
    }

    realAddEventListener('message', function (event) {
        var data = event.data;
        if (!data || typeof data !== 'object' || data.__preview !== true) return;
        if (data.dir !== 'req' || typeof data.requestId !== 'string') return;
        var result;
        var t = data.type;
        if (t === 'click') result = handleClick(data);
        else if (t === 'fill') result = handleFill(data);
        else if (t === 'inspect') result = handleInspect(data);
        else if (t === 'snapshot') result = handleSnapshot(data);
        else result = { ok: false, error: 'unknown_type', message: 'preview shim does not handle type=' + String(t) };
        var reply = { __preview: true, dir: 'res', requestId: data.requestId };
        for (var k in result) {
            if (Object.prototype.hasOwnProperty.call(result, k)) reply[k] = result[k];
        }
        post(reply);
    }, true);
})();`;
