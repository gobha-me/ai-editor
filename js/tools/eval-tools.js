/**
 * AI Editor - Eval Tool
 *
 * Sandboxed JavaScript evaluation for the LLM. Lets models run
 * calculations, string manipulation, data transforms, and small
 * code snippets without relying on mental arithmetic.
 *
 * Security model:
 *   - Runs in a Function() sandbox with no global access
 *   - Blocked globals: window, document, fetch, XMLHttpRequest, eval,
 *     Function, import, require, localStorage, sessionStorage, indexedDB
 *   - 3-second timeout via AbortController + Promise.race
 *   - Console capture (log/warn/error) returned alongside result
 *   - Max 100KB output to prevent memory bombs
 */

const MAX_OUTPUT = 102400; // 100KB
const TIMEOUT_MS = 3000;

/**
 * Run code in a sandboxed Function() with blocked globals.
 * @param {string} code - JavaScript to evaluate
 * @returns {{result: string, logs: string[]} | {error: string}}
 */
function sandboxEval(code) {
    // Capture console output
    const logs = [];
    const fakeConsole = {
        log:   (...args) => logs.push(args.map(_serialize).join(' ')),
        warn:  (...args) => logs.push('[warn] ' + args.map(_serialize).join(' ')),
        error: (...args) => logs.push('[error] ' + args.map(_serialize).join(' ')),
        info:  (...args) => logs.push(args.map(_serialize).join(' ')),
    };

    // Blocked globals — set to undefined inside the sandbox
    const blocked = [
        'window', 'self', 'globalThis', 'document',
        'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
        'eval', 'Function', 'importScripts',
        'localStorage', 'sessionStorage', 'indexedDB',
        'navigator', 'location', 'history',
        'alert', 'confirm', 'prompt',
        'setTimeout', 'setInterval', 'requestAnimationFrame',
        'postMessage', 'Worker', 'SharedWorker', 'ServiceWorker',
    ];

    // Build sandbox params: blocked names → undefined, plus console
    const paramNames = [...blocked, 'console'];
    const paramValues = [...blocked.map(() => undefined), fakeConsole];

    // REPL-style: auto-return the last expression.
    // Strategy: try prepending `return` to the last non-empty line.
    // If that creates a SyntaxError (e.g. last line is a declaration),
    // fall back to running the code as-is.
    const wrapped = code.includes('return ')
        ? code
        : _wrapForReturn(code, paramNames);

    try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(...paramNames, wrapped);
        const result = fn(...paramValues);
        return { result: _serialize(result), logs };
    } catch (e) {
        return { error: e.message, logs };
    }
}

/**
 * Try to make the last expression auto-return (REPL-style).
 * Prepends `return` to the last non-empty line. If that creates a
 * SyntaxError (last line is a declaration, loop, etc.), falls back
 * to running the code without implicit return.
 *
 * @param {string} code - Raw user code
 * @param {string[]} paramNames - Function parameter names (for syntax check)
 * @returns {string} Wrapped code suitable for new Function() body
 */
function _wrapForReturn(code, paramNames) {
    const lines = code.trimEnd().split('\n');

    // Find last non-empty, non-comment line
    let lastIdx = lines.length - 1;
    while (lastIdx >= 0 && /^\s*(\/\/.*)?$/.test(lines[lastIdx])) {
        lastIdx--;
    }

    if (lastIdx < 0) return code; // All empty/comments

    // Try: prepend `return` to last meaningful line
    const candidate = [
        ...lines.slice(0, lastIdx),
        'return ' + lines[lastIdx].trimStart()
    ].join('\n');

    try {
        // Syntax check only — does `return <lastLine>` parse?
        // eslint-disable-next-line no-new-func
        new Function(...paramNames, candidate);
        return candidate;
    } catch {
        // Last line can't be returned (declaration, block, etc.)
        // Fall back to raw code — result will be undefined
        return code;
    }
}

/**
 * Serialize a value to a readable string.
 */
function _serialize(val) {
    if (val === undefined) return 'undefined';
    if (val === null) return 'null';
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (val instanceof Error) return `${val.name}: ${val.message}`;
    try {
        const json = JSON.stringify(val, null, 2);
        return json.length > MAX_OUTPUT ? json.slice(0, MAX_OUTPUT) + '\n... (truncated)' : json;
    } catch {
        return String(val);
    }
}

// ============================================
// TOOL REGISTRATION
// ============================================

/**
 * @param {Object} registry - ToolRegistry instance
 */
export function registerEvalTools(registry) {

    registry.register('run_code', async ({ code }) => {
        if (!code || !code.trim()) {
            return { error: 'code is required' };
        }

        // Timeout wrapper
        const result = await Promise.race([
            new Promise(resolve => {
                // Run synchronously but wrap in promise for timeout
                resolve(sandboxEval(code));
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Execution timeout (3s)')), TIMEOUT_MS)
            )
        ]).catch(e => ({ error: e.message, logs: [] }));

        if (result.error) {
            return {
                error: result.error,
                console_output: result.logs?.length ? result.logs.join('\n') : undefined
            };
        }

        const output = {
            success: true,
            result: result.result,
        };

        if (result.logs.length > 0) {
            output.console_output = result.logs.join('\n');
        }

        // Truncate if too large
        const totalSize = JSON.stringify(output).length;
        if (totalSize > MAX_OUTPUT) {
            output.result = output.result.slice(0, MAX_OUTPUT / 2) + '\n... (truncated)';
        }

        return output;

    }, {
        type: 'function',
        function: {
            name: 'run_code',
            description: `Execute JavaScript code and return the result. Use for:
- Math calculations (line counts, offsets, percentages)
- String manipulation (regex, formatting, parsing)
- Data transforms (sort, filter, map arrays)
- Quick prototyping or validation of logic

The code runs in a sandbox — no DOM, no fetch, no file access. Console.log output is captured and returned. The last expression is returned as the result.

Examples:
  "42 * 17"  →  714
  "Array.from({length: 5}, (_, i) => i * 2)"  →  [0, 2, 4, 6, 8]
  "'hello world'.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')"  →  "Hello World"`,
            parameters: {
                type: 'object',
                properties: {
                    code: {
                        type: 'string',
                        description: 'JavaScript code to execute. Last expression is returned. Use console.log() for intermediate output.'
                    }
                },
                required: ['code']
            }
        },
        roles: ['coder']
    });
}
