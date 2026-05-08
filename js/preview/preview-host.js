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
    _swRegistration = null;
    _swPending = null;
    _slideOutWired = false;
}
