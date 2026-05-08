// @ts-check
/**
 * Pure runScript helper for the LLM-authored automation Phase 1 surface
 * (1.16.0 — DESIGN-llm-authored-automation.md §"First-Ship Scope").
 *
 * Exported here (instead of inline in `js/workers/script-runner-worker.js`)
 * so the Node test suite can exercise the curated-globals + timeout +
 * output-cap + adapter-stub round-trip without spawning a real Web Worker
 * (Workers don't run under `node:test`). The browser-side Worker calls
 * `runScript` with a postMessage-backed Git adapter; tests call it with
 * an in-process stub.
 *
 * **Sandbox boundary** (Tier 0): the user's `source` is wrapped in an
 * `async () => { ... }` and invoked with a curated environment that
 * exposes only the standard built-ins (Math, JSON, Array, etc.), a
 * `console` that captures into the result, and a `Git` adapter the caller
 * supplies. Forbidden globals (`fetch`, `XMLHttpRequest`, `WebSocket`,
 * `importScripts`, `process`, `window`, `document`) are NOT injected —
 * the user's source sees them as `undefined` references which throw a
 * standard `ReferenceError` on use, captured in stderr.
 *
 * **Output cap** is a soft byte ceiling on `stdout` + `stderr` combined.
 * Once the cap is hit, further writes are dropped and `truncated: true`
 * lands in the result. The script keeps running (it might still complete
 * within the timeout); we just stop accumulating its noise.
 *
 * **Timeout** is enforced via `Promise.race` — the user's async function
 * is racing a `setTimeout`-backed reject. On timeout we resolve with
 * `truncated: true` + a `'Timeout after Nms'` stderr line; the caller
 * (the Worker handle in `script-approval-card.js`) is responsible for
 * `.terminate()`-ing the actual Worker as a belt-and-braces measure since
 * a misbehaving script can keep the JS event loop busy past the race
 * boundary.
 *
 * @module intelligence/script-runner
 */

const DEFAULT_TIMEOUT_MS = 30000; // 30s — bumped from 10s after live testing showed real fs walks against this repo (~200+ files of CSS) saturate the 10s budget on the postMessage round-trip alone.
const DEFAULT_MAX_OUTPUT = 262144; // 256 KB

/**
 * @typedef {Object} ScriptRunResult
 * @property {string}  stdout       Captured `console.log/info/warn` output.
 * @property {string}  stderr       Captured `console.error` + uncaught throws.
 * @property {number}  runtime_ms   Wall time the script ran for (post-cap if truncated).
 * @property {boolean} truncated    True when output cap or timeout fired.
 */

/**
 * @typedef {Object} GitAdapter
 * @property {(owner: string, repo: string, path: string, ref?: string) => Promise<any>} getFile     Returns `{name, path, sha, size, content, encoding}`.
 * @property {(owner: string, repo: string, path: string, ref?: string) => Promise<string>} readFile Convenience: returns just the content string.
 * @property {(owner: string, repo: string, ref?: string, path?: string) => Promise<any>} getFileTree
 */

/**
 * Run a user-authored script in a curated sandbox. Pure: the only side
 * effects are calls to the supplied `gitAdapter`. Never throws — failure
 * modes (parse error, timeout, runtime throw, output cap, forbidden
 * global) all surface as fields on the returned result.
 *
 * @param {Object} opts
 * @param {string} opts.source                            JS source to evaluate.
 * @param {number} [opts.timeout_ms=30000]                Hard timeout in ms.
 * @param {number} [opts.max_output_bytes=262144]         Stdout+stderr byte cap.
 * @param {GitAdapter} opts.gitAdapter                    Project-file read adapter.
 * @returns {Promise<ScriptRunResult>}
 */
export async function runScript(opts) {
    const source = typeof opts?.source === 'string' ? opts.source : '';
    const timeout_ms = Number.isInteger(opts?.timeout_ms) && opts.timeout_ms > 0
        ? opts.timeout_ms
        : DEFAULT_TIMEOUT_MS;
    const max_output_bytes = Number.isInteger(opts?.max_output_bytes) && opts.max_output_bytes > 0
        ? opts.max_output_bytes
        : DEFAULT_MAX_OUTPUT;
    const gitAdapter = opts?.gitAdapter || null;

    const startedAt = Date.now();
    const out = { stdout: '', stderr: '', truncated: false };

    function _appendCapped(channel, text) {
        if (out.truncated) return;
        const total = out.stdout.length + out.stderr.length;
        const remaining = max_output_bytes - total;
        if (remaining <= 0) {
            out.truncated = true;
            return;
        }
        if (text.length > remaining) {
            out[channel] += text.slice(0, remaining);
            out.truncated = true;
        } else {
            out[channel] += text;
        }
    }

    function _stringifyArgs(args) {
        const parts = [];
        for (const a of args) {
            if (typeof a === 'string') {
                parts.push(a);
            } else {
                try { parts.push(JSON.stringify(a)); }
                catch { parts.push(String(a)); }
            }
        }
        return parts.join(' ') + '\n';
    }

    const sandboxConsole = {
        log:   (...a) => _appendCapped('stdout', _stringifyArgs(a)),
        info:  (...a) => _appendCapped('stdout', _stringifyArgs(a)),
        warn:  (...a) => _appendCapped('stdout', _stringifyArgs(a)),
        error: (...a) => _appendCapped('stderr', _stringifyArgs(a)),
        debug: (...a) => _appendCapped('stdout', _stringifyArgs(a)),
    };

    const sandboxGit = gitAdapter ? {
        getFile: (...args) => gitAdapter.getFile(...args),
        readFile: (...args) => (
            // If the adapter ships a native readFile (Worker postMessage
            // path), prefer it; otherwise fall back to unwrapping `.content`
            // from getFile so test-supplied stubs that only implement
            // getFile keep working.
            typeof gitAdapter.readFile === 'function'
                ? gitAdapter.readFile(...args)
                : Promise.resolve(gitAdapter.getFile(...args)).then(f => (f && typeof f === 'object' && typeof f.content === 'string') ? f.content : '')
        ),
        getFileTree: (...args) => gitAdapter.getFileTree(...args),
    } : {
        getFile: () => Promise.reject(new Error('Git adapter not available in this sandbox')),
        readFile: () => Promise.reject(new Error('Git adapter not available in this sandbox')),
        getFileTree: () => Promise.reject(new Error('Git adapter not available in this sandbox')),
    };

    // Build the user function. Parse errors throw synchronously from the
    // Function constructor; we catch and surface in stderr.
    let userFn;
    try {
        userFn = new Function('console', 'Git', `return (async () => {\n${source}\n})();`);
    } catch (parseErr) {
        _appendCapped('stderr', `ParseError: ${parseErr && parseErr.message ? parseErr.message : String(parseErr)}\n`);
        return {
            stdout: out.stdout,
            stderr: out.stderr,
            runtime_ms: Date.now() - startedAt,
            truncated: out.truncated,
        };
    }

    // Race the user's async function against the timeout. On timeout
    // we resolve (not reject) with truncated:true so the caller sees a
    // structured result rather than a thrown error.
    let timeoutId;
    const timeoutPromise = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve({ __timeout: true }), timeout_ms);
    });

    let userResult;
    try {
        userResult = await Promise.race([
            (async () => {
                try {
                    const r = await userFn(sandboxConsole, sandboxGit);
                    return { __ok: true, value: r };
                } catch (err) {
                    return { __throw: true, err };
                }
            })(),
            timeoutPromise,
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }

    if (userResult && userResult.__timeout) {
        _appendCapped('stderr', `Timeout after ${timeout_ms}ms\n`);
        out.truncated = true;
    } else if (userResult && userResult.__throw) {
        const err = userResult.err;
        const name = (err && err.name) ? err.name : 'Error';
        const msg = (err && err.message) ? err.message : String(err);
        _appendCapped('stderr', `${name}: ${msg}\n`);
    } else if (userResult && userResult.__ok && userResult.value !== undefined) {
        // If the user's `return` produced a value, surface it on stdout
        // as a final line — this is the natural channel for "the script
        // computed an answer" (e.g. `return unusedSelectors.length`).
        try {
            _appendCapped('stdout', JSON.stringify(userResult.value) + '\n');
        } catch {
            _appendCapped('stdout', String(userResult.value) + '\n');
        }
    }

    return {
        stdout: out.stdout,
        stderr: out.stderr,
        runtime_ms: Date.now() - startedAt,
        truncated: out.truncated,
    };
}
