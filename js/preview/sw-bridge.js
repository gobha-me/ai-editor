// @ts-check
/**
 * AI Editor — Page-side Service Worker bridge (1.22.0).
 *
 * The preview Service Worker (`js/preview/service-worker.js`) cannot
 * import editor modules directly — it runs in its own global scope with
 * no access to the editor's State / Git API. So when the SW intercepts
 * a fetch in scope (`/js/preview/<serverId>/<path>`) it postMessages
 * this page-side bridge with `{type: 'preview:fetch', serverId, path}`,
 * the bridge resolves the path against `Git.getFile`, and posts the
 * content back over the message channel the SW supplied. The SW then
 * synthesizes the Response with extension-derived MIME + a CSP header.
 *
 * Mirrors the §1.16.0 Tier-0 Worker adapter pattern at the boundary
 * level — the bridge is the only reach-back from the SW to the editor's
 * content surface; the SW itself sees no other editor module.
 *
 * Idempotent — `initSwBridge()` is safe to call on every `preview_start`
 * (the listener is attached at most once per page lifetime).
 *
 * @since 1.22.0
 * @module preview/sw-bridge
 */

import { State } from '../core.js';
import { Git } from '../git.js';

let _bridgeAttached = false;

/**
 * Extensions that are known binary formats. For these the bridge
 * recovers raw bytes from `Git.getFile`'s atob-fallback content (each
 * char.charCodeAt() is a byte 0-255) rather than re-encoding via
 * `TextEncoder` (which would corrupt the bytes for any non-UTF-8
 * sequence). Bridges send all payloads as `ArrayBuffer` so the
 * Response body preserves bytes regardless of file shape — gitea#338
 * dogfood surfaced this as woff2 fonts hitting `OTS parsing error:
 * Failed to convert WOFF 2.0 font to SFNT` because the bytes had
 * been UTF-8-mangled by the time they reached the iframe.
 */
const BINARY_EXTS = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'apng',
    'woff', 'woff2', 'ttf', 'otf', 'eot',
    'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus',
    'mp4', 'webm', 'mov', 'avi', 'mkv',
    'pdf', 'zip', 'tar', 'gz', 'bz2', '7z',
    'wasm',
]);

/**
 * Convert a JS string of raw bytes (each char a byte 0-255, as
 * produced by `atob`) to a `Uint8Array` of those bytes. Used for the
 * binary path; never lose information by re-interpreting the string
 * as UTF-8 codepoints.
 *
 * @param {string} s
 * @returns {Uint8Array}
 */
function _binaryStringToBytes(s) {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
        bytes[i] = s.charCodeAt(i) & 0xff;
    }
    return bytes;
}

/**
 * Attach the page-side `message` listener that resolves SW fetch
 * requests against `Git.getFile`. Idempotent.
 *
 * @returns {void}
 */
export function initSwBridge() {
    if (_bridgeAttached) return;
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
    _bridgeAttached = true;

    navigator.serviceWorker.addEventListener('message', async (event) => {
        const data = event.data;
        if (!data || data.type !== 'preview:fetch') return;
        const port = event.ports && event.ports[0];
        if (!port) return;
        const requestedPath = typeof data.path === 'string' ? data.path : '';
        try {
            const result = await _resolveWorkspacePath(requestedPath);
            // Transfer the ArrayBuffer (zero-copy) when present so we
            // don't pay a structured-clone cost on the SW round-trip.
            if (result.ok === true && result.body) {
                port.postMessage(result, [result.body]);
            } else {
                port.postMessage(result);
            }
        } catch (err) {
            port.postMessage({
                ok: false,
                status: 500,
                error: err && err.message ? err.message : String(err),
            });
        }
    });
}

/**
 * Resolve a workspace path to its file bytes + extension. Returns an
 * envelope with `body: ArrayBuffer` (transferable) so the SW can
 * synthesize a Response that preserves bytes for any file type.
 *
 * @param {string} path
 * @returns {Promise<{ok: true, body: ArrayBuffer, ext: string}|{ok: false, status: number, error: string}>}
 */
async function _resolveWorkspacePath(path) {
    if (!State.currentProject) {
        return { ok: false, status: 503, error: 'No project loaded' };
    }
    const cleanPath = path.replace(/^\/+/, '');
    if (!cleanPath) {
        return { ok: false, status: 400, error: 'Empty path' };
    }
    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch || 'main';
    let file;
    try {
        file = await Git.getFile(owner, repo, cleanPath, branch);
    } catch (err) {
        const status = err && err.status === 404 ? 404 : 500;
        return {
            ok: false,
            status,
            error: err && err.message ? err.message : 'Failed to read file',
        };
    }
    if (!file || typeof file.content !== 'string') {
        return { ok: false, status: 404, error: 'Empty file envelope' };
    }
    const lastDot = cleanPath.lastIndexOf('.');
    const ext = lastDot >= 0 ? cleanPath.slice(lastDot + 1).toLowerCase() : '';

    // Binary files: gitea.js's atob fallback gives us a raw-byte
    // string (each char a byte). Re-interpret without UTF-8 to
    // preserve the bytes. Text files: encode the JS string as UTF-8.
    let bytes;
    if (BINARY_EXTS.has(ext)) {
        bytes = _binaryStringToBytes(file.content);
    } else {
        bytes = new TextEncoder().encode(file.content);
    }

    return {
        ok: true,
        body: bytes.buffer,
        ext,
    };
}

/**
 * Test seam — resets the attach guard so test setups can re-init.
 *
 * @returns {void}
 */
export function _resetForTests() {
    _bridgeAttached = false;
}
