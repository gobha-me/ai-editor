// @ts-check
/**
 * AI Editor — Preview host (1.22.0).
 *
 * Owns the per-session lifecycle for in-editor preview Tier 1
 * (`docs/DESIGN-preview.md`):
 *   - Registers the workspace-resolving Service Worker once per session
 *     (idempotent). Both the script URL and registration scope are
 *     derived from `import.meta.url` so they honor `BASE_PATH` — root
 *     deploys see `/js/preview/`, `/dev` deploys see `/dev/js/preview/`,
 *     etc. Iframe URLs constructed under the same prefix are
 *     intercepted by the SW.
 *   - Maintains the in-memory `serverId → entry` registry that backs the
 *     `preview_start` / `preview_stop` / `preview_list` tool handlers.
 *   - Mounts the iframe in the preview slide-over panel
 *     (`html/preview-slideout.html`) — distinct from the existing
 *     `togglePreviewPane()` static-HTML preview at
 *     `js/secondary-pane.js:42` to avoid the name collision called out
 *     in the implementation plan.
 *   - Probes the active workspace for a `package.json` with `scripts.dev`
 *     and returns a `{requires_build_step: true}` envelope for build-step
 *     projects (Cogfall etc.). Tier 1 cannot serve those; Tier 3 sidecar
 *     does.
 *
 * **Module-level posture.** No DOM or SW reads happen at import time —
 * everything is gated inside function bodies. That keeps this module
 * import-safe for `node --test` runs (the tests in
 * `tests/test-preview-tools.mjs` stub the registry and never invoke the
 * lifecycle entry points).
 *
 * @since 1.22.0
 * @module preview/preview-host
 */

import { State } from '../core.js';
import { Git } from '../git.js';
import { initSwBridge } from './sw-bridge.js';

/** SW URL + scope — derived from `import.meta.url` so the registration
 *  honors the editor's `BASE_PATH` (root, `/dev`, `/test`, etc.). At
 *  root deploy these resolve to `/js/preview/service-worker.js` and
 *  scope `/js/preview/`; at `/dev` they resolve to
 *  `/dev/js/preview/service-worker.js` and scope `/dev/js/preview/`.
 *  The absolute-path constants this replaces (`/js/preview/...`) silently
 *  bypassed BASE_PATH and pointed the SW probe at root regardless of where
 *  the editor was loaded — gitea#338 Firefox + Chrome dogfood evidence.
 *  Default scope (the SW's directory) requires no Service-Worker-Allowed
 *  response header, which we cannot set in the static-deploy posture.
 */
const SW_URL = new URL('./service-worker.js', import.meta.url).pathname;
const SW_SCOPE = new URL('./', import.meta.url).pathname;

/** @type {Map<string, {serverId: string, path: string, url: string, createdAt: number}>} */
const _servers = new Map();

/** @type {ServiceWorkerRegistration|null} */
let _swRegistration = null;
/** @type {Promise<ServiceWorkerRegistration>|null} */
let _swPending = null;
/** Init guard for the slide-over wiring. */
let _slideOutWired = false;

/**
 * Tier 2 (2.7.0) — per-`serverId` ring buffers for the four capture
 * surfaces. Keys are `serverId`; values are arrays of capture entries
 * appended on receipt and shifted when length exceeds `BUFFER_CAP`.
 * Buffers are cleared on `previewStop` so a re-started server doesn't
 * inherit stale capture from the prior run.
 *
 * @type {Map<string, Array<{level: string, message: string, ts: number}>>}
 */
const _consoleBuffers = new Map();
/** @type {Map<string, Array<{message: string, source: string, line: number|null, col: number|null, stack: string|null, ts: number}>>} */
const _errorBuffers = new Map();
/** @type {Map<string, Array<{stage: string, path?: string, ts: number, [k: string]: any}>>} */
const _routeBuffers = new Map();
/** @type {Map<string, Array<{path: string, ok: boolean, status: number|null, stage: string, ts: number}>>} */
const _networkBuffers = new Map();
const BUFFER_CAP = 200;
let _captureListenersAttached = false;

/**
 * Generate a short, URL-safe server id. Shape: `srv_<8 hex>`.
 * Using `crypto.getRandomValues` if available, falling back to
 * `Math.random` — collision risk is irrelevant given the in-memory
 * registry's session lifetime.
 *
 * @returns {string}
 */
function _generateServerId() {
    const buf = new Uint8Array(4);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(buf);
    } else {
        for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    }
    let hex = '';
    for (const b of buf) hex += b.toString(16).padStart(2, '0');
    return `srv_${hex}`;
}

/**
 * Build the iframe URL for a given (serverId, path) tuple. Always
 * starts with the SW scope so the SW intercepts the navigation.
 *
 * @param {string} serverId
 * @param {string} path
 * @returns {string}
 */
function _buildPreviewUrl(serverId, path) {
    const cleanPath = path.replace(/^\/+/, '');
    return `${SW_SCOPE}${serverId}/${cleanPath}`;
}

/**
 * Push an entry into a per-`serverId` ring buffer, dropping the oldest
 * entry when capacity is exceeded.
 *
 * @template T
 * @param {Map<string, Array<T>>} bufferMap
 * @param {string} serverId
 * @param {T} entry
 */
function _pushBuffer(bufferMap, serverId, entry) {
    let buf = bufferMap.get(serverId);
    if (!buf) {
        buf = [];
        bufferMap.set(serverId, buf);
    }
    buf.push(entry);
    while (buf.length > BUFFER_CAP) buf.shift();
}

/**
 * Drop all Tier 2 capture state for a given `serverId`. Called on
 * `previewStop` so a subsequent `preview_start` for the same path
 * doesn't surface stale logs from the prior run.
 *
 * @param {string} serverId
 */
function _dropBuffers(serverId) {
    _consoleBuffers.delete(serverId);
    _errorBuffers.delete(serverId);
    _routeBuffers.delete(serverId);
    _networkBuffers.delete(serverId);
}

/**
 * Look up the `serverId` for a given iframe `contentWindow`. The slide-
 * over mounts iframes with `dataset.previewServerId` set; matching the
 * `event.source` against an iframe's `contentWindow` is the load-bearing
 * authentication that the message came from a registered preview iframe
 * and not from some other window on the page. Returns `null` if no
 * matching iframe is found.
 *
 * @param {WindowProxy|null} source
 * @returns {string|null}
 */
function _resolveServerIdFromSource(source) {
    if (!source || typeof document === 'undefined') return null;
    const iframes = document.querySelectorAll('iframe[data-preview-server-id]');
    for (const el of iframes) {
        const iframe = /** @type {HTMLIFrameElement} */ (el);
        if (iframe.contentWindow === source) {
            return iframe.dataset.previewServerId || null;
        }
    }
    return null;
}

/**
 * Attach the page-side listeners that feed the Tier 2 buffers.
 * Idempotent — `_captureListenersAttached` guards re-entry.
 *
 *   - `window.message` events with `data.__preview === true` come from
 *     the in-iframe shim (`js/preview/preview-shim.js`). Routed by
 *     `event.source` → iframe `dataset.previewServerId`. Messages from
 *     unknown sources are silently dropped (defense against arbitrary
 *     `postMessage` from any other window on the page).
 *   - `navigator.serviceWorker.message` events with `data.type === 'preview:debug'`
 *     come from the SW's `_broadcastDebug`. The SW stamps `serverId`
 *     into every broadcast (since 2.7.0 — see service-worker.js
 *     `_servePreview` signature change) so the host attributes by id.
 */
function _attachCaptureListeners() {
    if (_captureListenersAttached) return;
    if (typeof window === 'undefined') return;
    _captureListenersAttached = true;

    window.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || typeof data !== 'object' || data.__preview !== true) return;
        const serverId = _resolveServerIdFromSource(/** @type {WindowProxy} */ (event.source));
        if (!serverId) return;
        if (data.type === 'console') {
            _pushBuffer(_consoleBuffers, serverId, {
                level: typeof data.level === 'string' ? data.level : 'log',
                message: typeof data.message === 'string' ? data.message : String(data.message ?? ''),
                ts: typeof data.ts === 'number' ? data.ts : Date.now(),
            });
        } else if (data.type === 'error') {
            _pushBuffer(_errorBuffers, serverId, {
                message: typeof data.message === 'string' ? data.message : String(data.message ?? ''),
                source: typeof data.source === 'string' ? data.source : '',
                line: typeof data.line === 'number' ? data.line : null,
                col: typeof data.col === 'number' ? data.col : null,
                stack: typeof data.stack === 'string' ? data.stack : null,
                ts: typeof data.ts === 'number' ? data.ts : Date.now(),
            });
        }
    });

    if (navigator && navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('message', (event) => {
            const data = event.data;
            if (!data || data.type !== 'preview:debug') return;
            const serverId = typeof data.serverId === 'string' ? data.serverId : null;
            if (!serverId) return;
            const ts = Date.now();
            const stage = typeof data.stage === 'string' ? data.stage : 'unknown';
            const path = typeof data.path === 'string' ? data.path : undefined;
            // Route log: every stage gets recorded.
            const routeEntry = { stage, path, ts };
            // Carry through any extra fields the SW broadcast (status, ext, error, mode, destination, etc.)
            for (const k of Object.keys(data)) {
                if (k === 'type' || k === 'serverId' || k === 'stage' || k === 'path') continue;
                routeEntry[k] = data[k];
            }
            _pushBuffer(_routeBuffers, serverId, routeEntry);
            // Network log: derived from the request-completion stages so
            // each entry represents a finished workspace fetch.
            if (path && (stage === 'bridge-replied' || stage === 'bridge-error' || stage === 'no-host-client')) {
                _pushBuffer(_networkBuffers, serverId, {
                    path,
                    ok: stage === 'bridge-replied' && data.ok === true,
                    status: typeof data.status === 'number' ? data.status : (stage === 'no-host-client' ? 503 : null),
                    stage,
                    ts,
                });
            }
        });
    }
}

/**
 * Tier 2 accessor — return captured `console.*` lines for a `serverId`.
 *
 * @param {{serverId: string, level?: string, lines?: number}} args
 * @returns {{logs: Array<{level: string, message: string, ts: number}>, truncated?: boolean}}
 */
export function getConsoleLogs({ serverId, level, lines }) {
    const buf = _consoleBuffers.get(serverId) || [];
    let filtered = buf;
    if (level && level !== 'all') {
        if (level === 'error') filtered = buf.filter(e => e.level === 'error');
        else if (level === 'warn') filtered = buf.filter(e => e.level === 'warn' || e.level === 'error');
    }
    const cap = Math.max(1, Math.min(typeof lines === 'number' ? lines : 50, 200));
    const sliced = filtered.slice(-cap);
    const result = { logs: sliced };
    if (filtered.length > sliced.length) result.truncated = true;
    return result;
}

/**
 * Tier 2 accessor — return captured `window.onerror` + `unhandledrejection`
 * events for a `serverId`. The Sokoban class lands here.
 *
 * @param {{serverId: string, lines?: number}} args
 * @returns {{errors: Array<object>, truncated?: boolean}}
 */
export function getErrors({ serverId, lines }) {
    const buf = _errorBuffers.get(serverId) || [];
    const cap = Math.max(1, Math.min(typeof lines === 'number' ? lines : 50, 100));
    const sliced = buf.slice(-cap);
    const result = { errors: sliced };
    if (buf.length > sliced.length) result.truncated = true;
    return result;
}

/**
 * Tier 2 accessor — return SW route stages for a `serverId`. Useful for
 * "the asset didn't exist in the workspace at the path the page asked
 * for" — distinct from the in-page console.
 *
 * @param {{serverId: string, lines?: number, search?: string}} args
 * @returns {{logs: Array<object>, truncated?: boolean}}
 */
export function getRouteLogs({ serverId, lines, search }) {
    const buf = _routeBuffers.get(serverId) || [];
    let filtered = buf;
    if (typeof search === 'string' && search.length > 0) {
        const needle = search.toLowerCase();
        filtered = buf.filter(e => {
            return (e.stage && e.stage.toLowerCase().includes(needle))
                || (e.path && e.path.toLowerCase().includes(needle));
        });
    }
    const cap = Math.max(1, Math.min(typeof lines === 'number' ? lines : 50, 200));
    const sliced = filtered.slice(-cap);
    const result = { logs: sliced };
    if (filtered.length > sliced.length) result.truncated = true;
    return result;
}

/**
 * Tier 2 accessor — return per-fetch network entries for a `serverId`.
 * Each entry is a finished workspace fetch (bridge-replied or bridge-error
 * stage). With `filter: 'failed'`, only failed requests are returned.
 *
 * @param {{serverId: string, filter?: string}} args
 * @returns {{requests: Array<object>}}
 */
export function getNetwork({ serverId, filter }) {
    const buf = _networkBuffers.get(serverId) || [];
    let filtered = buf;
    if (filter === 'failed') filtered = buf.filter(e => !e.ok);
    return { requests: filtered.slice() };
}

/**
 * Ensure the workspace-resolving Service Worker is registered and
 * active. Idempotent — concurrent callers share a single in-flight
 * registration promise.
 *
 * **Self-healing (gitea#338 dogfood):** the previous version cached
 * `_swRegistration` and short-circuited future calls, but a user who
 * unregistered the SW out-of-band (DevTools, browser settings) would
 * keep getting the stale reference and `register()` would never run
 * again in this session. The new flow validates the cache against
 * `getRegistration(scope)` first; if the live state doesn't match,
 * it forces a fresh `register()`. Console tracing is intentional —
 * the previous version exited silently on the unhappy paths and made
 * "preview did nothing" a near-impossible bug to diagnose without
 * hooking the SW lifecycle event-by-event.
 *
 * @returns {Promise<ServiceWorkerRegistration>}
 */
async function _ensureServiceWorker() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
        throw new Error('Service workers are not available in this environment. Tier 1 preview requires a browser context with SW support.');
    }

    // Validate cached registration is still live before trusting it.
    if (_swRegistration) {
        try {
            const live = await navigator.serviceWorker.getRegistration(SW_SCOPE);
            if (live && live.active && live.active.state === 'activated') {
                return _swRegistration;
            }
            console.log('[preview-host] cached SW registration is stale; re-registering');
        } catch (err) {
            console.warn('[preview-host] getRegistration check failed; re-registering:', err);
        }
        _swRegistration = null;
    }

    if (_swPending) return _swPending;

    _swPending = (async () => {
        console.log('[preview-host] register SW', { url: SW_URL, scope: SW_SCOPE });
        const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
        console.log('[preview-host] register() resolved', {
            installing: reg.installing?.state || null,
            waiting: reg.waiting?.state || null,
            active: reg.active?.state || null,
        });

        // Wait for an active+activated SW. Prefer the new worker (installing
        // /waiting) over an existing active one — register() can resolve
        // with the OLD active SW still set while a new one is installing.
        const newWorker = reg.installing || reg.waiting;
        const targetWorker = newWorker || reg.active;
        if (!targetWorker) {
            // register() returned but no worker is set anywhere — defensively
            // poll for up to 3s for one to appear, then give up.
            console.warn('[preview-host] register() resolved with no worker reference; polling');
            for (let i = 0; i < 30; i++) {
                await new Promise(r => setTimeout(r, 100));
                if (reg.installing || reg.waiting || reg.active) break;
            }
        }
        const finalTarget = reg.installing || reg.waiting || reg.active;
        if (finalTarget && finalTarget.state !== 'activated') {
            console.log('[preview-host] awaiting SW activation', finalTarget.state);
            await new Promise((resolve) => {
                const onChange = () => {
                    if (finalTarget.state === 'activated' || finalTarget.state === 'redundant') {
                        finalTarget.removeEventListener('statechange', onChange);
                        resolve(undefined);
                    }
                };
                finalTarget.addEventListener('statechange', onChange);
                // Re-check synchronously in case state changed between the
                // outer if and listener attach.
                if (finalTarget.state === 'activated' || finalTarget.state === 'redundant') {
                    finalTarget.removeEventListener('statechange', onChange);
                    resolve(undefined);
                }
            });
            console.log('[preview-host] SW transitioned to', finalTarget.state);
        }

        if (!reg.active || reg.active.state !== 'activated') {
            throw new Error(`Service worker did not reach 'activated' state (current: ${reg.active?.state || 'no active worker'})`);
        }

        // Wire the page-side bridge so SW fetch events resolve against
        // `Git.getFile`. Idempotent.
        initSwBridge();
        // Tier 2 (2.7.0) — attach capture listeners for shim postMessages
        // and SW debug broadcasts. Idempotent; safe to call on every
        // `_ensureServiceWorker` invocation.
        _attachCaptureListeners();
        _swRegistration = reg;
        console.log('[preview-host] SW ready', { scope: reg.scope, scriptURL: reg.active.scriptURL });
        return reg;
    })();
    try {
        return await _swPending;
    } finally {
        _swPending = null;
    }
}

/**
 * Probe the active workspace for a build step. Returns `{requires_build_step: true, hint}`
 * if `package.json` exists with `scripts.dev`; returns `null` otherwise.
 *
 * @returns {Promise<{requires_build_step: true, hint: string}|null>}
 */
async function _detectBuildStep() {
    if (!State.currentProject) return null;
    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch || 'main';
    let pkg;
    try {
        pkg = await Git.getFile(owner, repo, 'package.json', branch);
    } catch {
        return null; // no package.json → no build step probe to do
    }
    if (!pkg || typeof pkg.content !== 'string') return null;
    let parsed;
    try {
        parsed = JSON.parse(pkg.content);
    } catch {
        return null; // malformed package.json — let the iframe try anyway
    }
    if (parsed && parsed.scripts && typeof parsed.scripts.dev === 'string') {
        return {
            requires_build_step: true,
            hint: `This project has package.json with a 'dev' script ('${parsed.scripts.dev}'). Tier 1 preview serves static workspace files only and cannot run a build pipeline. Tier 3 sidecar (not yet shipped) handles build-step projects. For now, build the project externally and preview the build output, or skip preview for this workspace.`,
        };
    }
    return null;
}

/**
 * Mount (or remount) the slide-over panel showing the iframe for a
 * server entry. Idempotent — re-mounting the same `serverId` no-ops.
 *
 * @param {{serverId: string, path: string, url: string}} entry
 */
function _mountSlideOut(entry) {
    if (typeof document === 'undefined') return;
    _wireSlideOut();
    const overlay = document.getElementById('previewSlideOut');
    const titleEl = document.getElementById('previewSlideOutTitle');
    const subtitleEl = document.getElementById('previewSlideOutSubtitle');
    const bodyEl = document.getElementById('previewSlideOutBody');
    if (!overlay || !bodyEl) return;
    if (titleEl) titleEl.textContent = '👁 Agent Preview';
    // Show owner/repo/branch + path so users can confirm the iframe
    // really is fetching from the project they think it is. The
    // gitea#338 dogfood surfaced a real expectations gap — user
    // believed they were on HTML-Games but `State.currentProject`
    // was actually ai-editor, so the preview faithfully showed
    // ai-editor's index.html and looked like a bug.
    const proj = State.currentProject;
    const branch = State.currentBranch || 'main';
    const projLabel = proj ? `${proj.owner}/${proj.repo}@${branch}` : '(no project)';
    if (subtitleEl) subtitleEl.textContent = `${projLabel} · ${entry.path} · ${entry.serverId}`;
    bodyEl.innerHTML = '';
    const iframe = document.createElement('iframe');
    // Trust-boundary trade-off in single-origin Tier 1.
    //
    // DESIGN-preview.md §"Load-Bearing Decision" calls for
    // `sandbox="allow-scripts"` without `allow-same-origin`. In a multi-
    // origin deploy (preview subdomain) that gives the iframe a foreign
    // origin and blocks `window.parent.State` reach.
    //
    // In a *single-origin* deploy (this static-deploy posture), Chromium's
    // service-worker semantics deny SW interception to opaque-origin
    // clients — verified live: a sandboxed iframe at `/js/preview/...`
    // never receives a `fetch` event in our SW. The iframe falls through
    // to the network instead, so multi-file workspaces (typical HTML-Games
    // shape: `index.html` plus separate `js/*.js` and `css/*.css`) cannot
    // load. That defeats the value case.
    //
    // The pragmatic Tier 1 choice for single-origin: omit `sandbox` so the
    // iframe runs at the editor origin and the SW intercepts subresource
    // fetches. The trust boundary degrades from "iframe cannot reach
    // window.parent" to "iframe is on the editor origin; the CSP we set
    // from the SW (`default-src 'self'; connect-src 'self';` etc.) blocks
    // outbound network so workspace JS cannot phone home." Same-origin
    // reach to `window.parent.State` is technically possible — workspace
    // JS the LLM authored could read editor State if it were adversarial.
    //
    // The CHANGELOG flags this as a known single-origin limitation; the
    // multi-origin deploy fix (`preview.editor.gobha.ai` subdomain) is
    // the design's preferred path and lives in §"Open Questions" of
    // DESIGN-preview.md. This PR does NOT solve that — it ships the
    // working preview that catches the agent's Sokoban-class gap and
    // acknowledges the trust trade-off honestly.
    iframe.setAttribute('title', `Preview · ${entry.path}`);
    iframe.style.cssText = 'width: 100%; height: 100%; border: 0; background: white;';
    iframe.src = entry.url;
    iframe.dataset.previewServerId = entry.serverId;
    bodyEl.appendChild(iframe);
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
}

/**
 * Wire the slide-over close button + backdrop click + Esc key. Runs once
 * per session.
 */
function _wireSlideOut() {
    if (_slideOutWired) return;
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById('previewSlideOut');
    if (!overlay) return;
    _slideOutWired = true;
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) _closeSlideOut();
    });
    document.getElementById('previewCloseBtn')?.addEventListener('click', () => _closeSlideOut());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('active')) {
            _closeSlideOut();
        }
    });
}

function _closeSlideOut() {
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById('previewSlideOut');
    if (!overlay) return;
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
}

/**
 * `preview_start` lifecycle. Returns the `serverId` / `url` envelope on
 * success, the `{requires_build_step}` envelope on build-step projects,
 * or an `{error}` envelope when something goes wrong.
 *
 * @param {{path: string}} args
 * @returns {Promise<Object>}
 */
export async function previewStart({ path }) {
    if (!State.currentProject) {
        return { error: 'No project is currently loaded. Load a project before starting a preview.' };
    }
    // Idempotency — same path → same serverId, no relaunch.
    for (const entry of _servers.values()) {
        if (entry.path === path) {
            _mountSlideOut(entry);
            return { serverId: entry.serverId, url: entry.url, path: entry.path, reused: true };
        }
    }
    // Build-step probe — Cogfall lands here at Tier 1.
    const buildStep = await _detectBuildStep();
    if (buildStep) return buildStep;
    // Verify the requested path actually exists before spinning up the SW
    // — no point launching an iframe for a 404.
    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch || 'main';
    try {
        await Git.getFile(owner, repo, path, branch);
    } catch (err) {
        return {
            error: `no_entrypoint: '${path}' was not found in the workspace. Use get_project_tree to find a valid entrypoint, then call preview_start with that path.`,
            code: 'no_entrypoint',
        };
    }
    try {
        await _ensureServiceWorker();
    } catch (err) {
        // The SW registration can fail for environment-specific reasons
        // (older browsers, restrictive CSP, the file 404'd because the
        // deploy hasn't finished, Firefox's stricter install-handler
        // semantics — see js/preview/service-worker.js install handler
        // for the gitea#338 install-promise fix). Surface a recoveryHint
        // that lets cheap-tier models break out of a retry loop and fall
        // through to verifying the change by other means (read affected
        // files, run tests, commit + let CI verify) — same shape as the
        // §1.8.2 `getRefusalHint` precedent. Without this, the model
        // retried `preview_start` twice in the 2026-05-08 dogfood before
        // bailing.
        const message = err && err.message ? err.message : String(err);
        return {
            error: `Failed to register preview service worker: ${message}`,
            code: 'preview_unavailable',
            recoveryHint: 'Preview is unavailable in this environment. Do NOT retry preview_start. Skip the preview step and verify your changes by other means: re-read the affected files, ensure the edit is correct, commit, and let CI verify. The change is still mergeable.',
        };
    }
    const serverId = _generateServerId();
    const url = _buildPreviewUrl(serverId, path);
    const entry = { serverId, path, url, createdAt: Date.now() };
    _servers.set(serverId, entry);
    _mountSlideOut(entry);
    return { serverId, url, path };
}

/**
 * `preview_stop` lifecycle. Idempotent.
 *
 * @param {{serverId: string}} args
 * @returns {Promise<{stopped: true}>}
 */
export async function previewStop({ serverId }) {
    const had = _servers.delete(serverId);
    // Tier 2 (2.7.0) — drop capture buffers regardless of whether the
    // serverId was registered. A subsequent `preview_start` for the same
    // path generates a new serverId, so stale buffers under the old id
    // would never be reachable anyway, but freeing them keeps the host's
    // memory profile bounded across long sessions.
    _dropBuffers(serverId);
    if (had && typeof document !== 'undefined') {
        const overlay = document.getElementById('previewSlideOut');
        const iframe = overlay?.querySelector(`iframe[data-preview-server-id="${serverId}"]`);
        if (iframe && iframe.parentElement) {
            iframe.parentElement.removeChild(iframe);
        }
        // If no servers remain, close the slide-over.
        if (_servers.size === 0 && overlay) {
            overlay.classList.remove('active');
            overlay.setAttribute('aria-hidden', 'true');
        }
    }
    return { stopped: true };
}

/**
 * `preview_list` — returns the in-memory registry's contents.
 *
 * @returns {{servers: Array<{serverId: string, path: string, url: string, createdAt: number}>}}
 */
export function previewList() {
    const servers = [];
    for (const entry of _servers.values()) {
        servers.push({
            serverId: entry.serverId,
            path: entry.path,
            url: entry.url,
            createdAt: entry.createdAt,
        });
    }
    return { servers };
}

/**
 * Test seam — clears the in-memory registry. Used by
 * `tests/test-preview-tools.mjs` to isolate test cases.
 *
 * @returns {void}
 */
export function _resetForTests() {
    _servers.clear();
    _consoleBuffers.clear();
    _errorBuffers.clear();
    _routeBuffers.clear();
    _networkBuffers.clear();
    _swRegistration = null;
    _swPending = null;
    _slideOutWired = false;
    _captureListenersAttached = false;
}

/**
 * Test seam — push a synthetic shim event into the buffers, bypassing
 * the message listener. Lets `tests/test-preview-tier2.mjs` assert ring-
 * buffer drop-oldest behavior without mounting an iframe.
 *
 * @param {string} serverId
 * @param {object} entry
 * @returns {void}
 */
export function _pushCaptureForTests(serverId, entry) {
    if (!entry || typeof entry !== 'object') return;
    if (entry.type === 'console') {
        _pushBuffer(_consoleBuffers, serverId, {
            level: typeof entry.level === 'string' ? entry.level : 'log',
            message: typeof entry.message === 'string' ? entry.message : String(entry.message ?? ''),
            ts: typeof entry.ts === 'number' ? entry.ts : Date.now(),
        });
    } else if (entry.type === 'error') {
        _pushBuffer(_errorBuffers, serverId, {
            message: typeof entry.message === 'string' ? entry.message : '',
            source: typeof entry.source === 'string' ? entry.source : '',
            line: typeof entry.line === 'number' ? entry.line : null,
            col: typeof entry.col === 'number' ? entry.col : null,
            stack: typeof entry.stack === 'string' ? entry.stack : null,
            ts: typeof entry.ts === 'number' ? entry.ts : Date.now(),
        });
    } else if (entry.type === 'route') {
        _pushBuffer(_routeBuffers, serverId, {
            stage: entry.stage || 'unknown',
            path: entry.path,
            ts: typeof entry.ts === 'number' ? entry.ts : Date.now(),
            ...(entry.extra || {}),
        });
    } else if (entry.type === 'network') {
        _pushBuffer(_networkBuffers, serverId, {
            path: entry.path || '',
            ok: entry.ok === true,
            status: typeof entry.status === 'number' ? entry.status : null,
            stage: entry.stage || 'bridge-replied',
            ts: typeof entry.ts === 'number' ? entry.ts : Date.now(),
        });
    }
}
