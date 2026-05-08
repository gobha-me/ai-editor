/**
 * Script-runner Web Worker — Tier-0 sandbox for the LLM-authored
 * automation Phase 1 surface (1.16.0 — DESIGN-llm-authored-automation.md
 * §"Sandbox Seam — Option A").
 *
 * Runs in a dedicated worker so user-authored code can never touch the
 * main thread's `window`, `document`, `State`, the tool registry, or
 * any settings/auth surface. Forbidden globals are deleted at the top
 * of this file *before* any user source runs, and the
 * `js/intelligence/script-runner.js` helper does NOT inject `fetch`
 * etc. into the user function's scope — references to forbidden
 * globals fall through to the Worker's `self`, where they're undefined
 * after the deletion below, so they throw `ReferenceError` on use.
 *
 * Wire shape (postMessage protocol):
 *
 *   Main → Worker:
 *     { type: 'run_script', id, source, timeout_ms, max_output_bytes }
 *     { type: 'git_call_result', call_id, ok: true,  value }
 *     { type: 'git_call_result', call_id, ok: false, error }
 *
 *   Worker → Main:
 *     { type: 'scriptComplete', id, stdout, stderr, runtime_ms, truncated }
 *     { type: 'git_call', call_id, fn, args }    // proxied Git.* call
 *     { type: 'error', id, error }               // bootstrap error only
 */

// Deny-list of globals the Tier-0 sandbox must not see. Worker built-ins
// like `fetch`, `XMLHttpRequest`, `Worker`, etc. are non-configurable on
// `self`, so `delete` is a no-op. Override with a throwing accessor
// instead — user-source reads / calls trip the throw and the
// `script-runner.js` helper captures it as a `ReferenceError` in stderr.
const _denied = [
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    'importScripts', 'indexedDB', 'localStorage', 'sessionStorage',
    'caches', 'Worker', 'SharedWorker', 'MessageChannel', 'BroadcastChannel',
    'Notification', 'navigator', 'crypto',
];
for (const name of _denied) {
    try {
        Object.defineProperty(self, name, {
            configurable: true,
            enumerable: false,
            get() {
                throw new ReferenceError(`${name} is not available in the Tier-0 sandbox`);
            },
            set() { /* writes silently dropped */ },
        });
    } catch (err) {
        // Some properties may be hard-locked under strict configurability;
        // in that case fall back to assignment-over (works for `fetch`
        // when the descriptor's writable=true even if configurable=false).
        try { self[name] = undefined; } catch { /* best-effort */ }
    }
}

// Outstanding `Git.*` calls awaiting their main-thread response. Keyed
// by `call_id` (a monotone counter); resolved when the matching
// `git_call_result` lands.
const _pendingGitCalls = new Map();
let _gitCallSeq = 0;

function _proxyGitCall(fn, args) {
    return new Promise((resolve, reject) => {
        const call_id = ++_gitCallSeq;
        _pendingGitCalls.set(call_id, { resolve, reject });
        try {
            self.postMessage({ type: 'git_call', call_id, fn, args });
        } catch (err) {
            _pendingGitCalls.delete(call_id);
            reject(err);
        }
    });
}

const gitAdapter = {
    // `getFile` returns the full provider envelope `{name, path, sha,
    // size, content, encoding}` — surface metadata for cases where the
    // script needs sha (cache-keying) or size (skip large files).
    getFile: (owner, repo, path, ref) => _proxyGitCall('getFile', [owner, repo, path, ref]),
    // `readFile` is the convenience helper that mirrors what the
    // main-thread `read_file` tool exposes: just the file's content as
    // a string. 99% of Tier-0 scripts want this — the unwrapping the
    // model would otherwise have to do (`(await Git.getFile(...)).content`)
    // is an ergonomics tax with no security tradeoff. Implemented as a
    // sibling proxy call so the main thread can short-circuit the
    // metadata round-trip if a future provider exposes a content-only
    // endpoint; today it forwards to `Git.getFile` and unwraps `.content`.
    readFile: (owner, repo, path, ref) => _proxyGitCall('readFile', [owner, repo, path, ref]),
    getFileTree: (owner, repo, ref, path) => _proxyGitCall('getFileTree', [owner, repo, ref, path]),
};

self.onmessage = async (e) => {
    const msg = e.data || {};
    if (msg.type === 'git_call_result') {
        const pending = _pendingGitCalls.get(msg.call_id);
        if (!pending) return;
        _pendingGitCalls.delete(msg.call_id);
        if (msg.ok) pending.resolve(msg.value);
        else pending.reject(new Error(msg.error || 'Git adapter call failed'));
        return;
    }

    if (msg.type === 'run_script') {
        const { id, source, timeout_ms, max_output_bytes } = msg;
        try {
            // Lazy-import so the Worker's bootstrap is fast even without
            // a script to run. Path is relative to the worker file.
            const { runScript } = await import('../intelligence/script-runner.js');
            const result = await runScript({
                source: typeof source === 'string' ? source : '',
                timeout_ms,
                max_output_bytes,
                gitAdapter,
            });
            self.postMessage({
                type: 'scriptComplete',
                id,
                stdout: result.stdout,
                stderr: result.stderr,
                runtime_ms: result.runtime_ms,
                truncated: result.truncated,
            });
        } catch (err) {
            // Reaching this branch means the runner helper itself
            // crashed (import failure, etc.) — runScript() handles
            // user-script errors internally. Surface as `error` so
            // the caller can distinguish "runtime crash" from a
            // structured run result.
            self.postMessage({
                type: 'error',
                id,
                error: (err && err.message) ? err.message : String(err),
            });
        }
        return;
    }
};
