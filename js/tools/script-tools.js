// @ts-check
/**
 * AI Editor - LLM-Authored Automation tool (1.16.0).
 *
 * Lets the LLM submit a JS script for the user to review + approve. On
 * approval the script runs in a sandboxed Web Worker (Tier 0 — no
 * network, no DOM, no `process`, only a curated `Git.getFile` /
 * `Git.getFileTree` adapter). The handler returns a Promise that the
 * `ScriptApprovalCard` component resolves with the captured run output.
 *
 * Behavior identical to `submit_plan_for_approval` from the chat loop's
 * perspective: the call is a slow-running tool, `handlers.js` bypasses
 * the 30s timeout via the `USER_PAUSE_TOOLS` set, and the cancel path
 * calls `cancelScriptApproval()` to release the awaited Promise.
 *
 * Contract:
 *   - args = { source: string, description: string, expected_output: string }
 *   - Returns one of:
 *       { status: 'approved', stdout, stderr, runtime_ms, truncated }
 *       { status: 'rejected', feedback: string }
 *       { status: 'cancelled', cancelled: true, partial_stdout?, partial_stderr?, error }
 *
 * Always registered with `readOnly: true` (so Plan Mode keeps it
 * admitted — the *handler* is read-only; what the user does on approval
 * is a separate authorization decision happening at a different
 * surface). Profile-side admission is controlled by:
 *   - `profile.tools.admit` (gitea#438) — the explicit list of tool
 *     names a profile admits. `coder.v1.admit` includes
 *     `submit_script_for_approval`; `chat.v1.admit` also lists it for
 *     parity, but `chat.v1` leaves `scriptAutomation.enabled = false`
 *     so the runtime filter still drops it.
 *   - `scriptAutomation.enabled` toggle from the resolved profile +
 *     settings overlay; the runtime filter in `js/llm/api.js`
 *     `applyScriptAutomationFilter()` drops the tool when off,
 *     regardless of admission.
 *
 * Per DESIGN-llm-authored-automation.md §"Per-Invocation Gate, Not
 * Per-Tool Gate": catalog admission is the trust boundary at the tool
 * level; per-invocation source review is the *additional* gate that
 * runs on top.
 *
 * @since 1.16.0
 * @module tools/script-tools
 */

import { setPendingScriptApproval } from '../chat/state.js';

/**
 * Register the submit_script_for_approval tool. Always registers; whether
 * it's admitted into the per-turn tool list is a separate decision at
 * Composer + filter time.
 *
 * @param {{register: Function}} registry
 */
export function registerScriptTools(registry) {
    registry.register('submit_script_for_approval', async (args) => {
        if (!args || typeof args !== 'object') {
            return { error: 'submit_script_for_approval requires an arguments object.' };
        }
        if (typeof args.source !== 'string' || !args.source.trim()) {
            return { error: 'submit_script_for_approval requires a non-empty "source" string (JavaScript).' };
        }
        if (typeof args.description !== 'string' || !args.description.trim()) {
            return { error: 'submit_script_for_approval requires a non-empty "description" string (markdown — what the script does and why).' };
        }
        if (typeof args.expected_output !== 'string' || !args.expected_output.trim()) {
            return { error: 'submit_script_for_approval requires a non-empty "expected_output" string (your contract for what the run should return — helps the user spot mismatches at review time).' };
        }
        const source = args.source.trim();
        const description = args.description.trim();
        const expected_output = args.expected_output.trim();
        return new Promise((resolve) => {
            setPendingScriptApproval({ source, description, expected_output, resolve });
        });
    }, {
        type: 'function',
        function: {
            name: 'submit_script_for_approval',
            description: 'Submit a short JavaScript script for the user to review and approve. On approval the script runs in a sandboxed Web Worker (Tier 0): NO network (`fetch`, `XMLHttpRequest`, `WebSocket` throw `ReferenceError`), NO DOM, NO process/State/auth. Output cap 256 KB stdout+stderr; hard timeout 30s (configurable per profile, max 120s). Use this when a task would otherwise grind through dozens of `read_file` / `search_in_files` calls (dead-CSS sweeps, unused-export scans, import-graph audits) — the script collapses the X^N tool-loop to one round trip.\n\n**Git adapter (only side-effect surface):**\n\n- `await Git.readFile(owner, repo, path, ref?)` — returns the file content as a **string** (this is the 99% case; mirrors what `read_file` exposes).\n- `await Git.getFile(owner, repo, path, ref?)` — returns the full envelope `{name, path, sha, size, content, encoding}` for cases where you need metadata (e.g. skip large files: `if (file.size > 100000) continue`).\n- `await Git.getFileTree(owner, repo, ref?, path?)` — returns an array of `{path, ...}` entries. Filter with `.filter(f => f.path.endsWith(\'.css\'))`.\n\n**Example:**\n```js\nconst tree = await Git.getFileTree(owner, repo);\nconst cssFiles = tree.filter(f => f.path.endsWith(\'.css\'));\nfor (const f of cssFiles) {\n  const css = await Git.readFile(owner, repo, f.path);\n  console.log(f.path, css.split(\'\\n\').length, \'lines\');\n}\n```\n\nProvide `source` (the JS — top-level `await` is fine), `description` (markdown — why you wrote it, what it inspects), and `expected_output` (your contract for the structured answer you expect back). Use `console.log` / `console.error` for stdout / stderr; `return <value>` surfaces a structured answer as a JSON line on stdout. The chat loop pauses while the user reviews; the result returns as your tool_result.',
            parameters: {
                type: 'object',
                properties: {
                    source: {
                        type: 'string',
                        description: 'The full JavaScript source to run. Top-level `await` is allowed (the source is wrapped in an async IIFE). Use `console.log` / `console.error` to capture output, or `return <value>` to surface a structured answer as a JSON line on stdout. Available globals: `Git.readFile / Git.getFile / Git.getFileTree`, `console`, `Math`, `JSON`, `Date`, `TextEncoder`, `TextDecoder`, all standard built-ins. Forbidden (throw `ReferenceError`): `fetch`, `XMLHttpRequest`, `WebSocket`, `process`, `window`, `document`, `localStorage`, `sessionStorage`, `Worker`, `importScripts`, `indexedDB`, `caches`, `crypto`, `navigator`. **Tip:** prefer `await Git.readFile(...)` (returns the content string) over `(await Git.getFile(...)).content` (returns the full envelope) unless you need `size` / `sha` metadata.',
                    },
                    description: {
                        type: 'string',
                        description: 'Markdown explaining what the script does and why. The user reads this verbatim before approving — make the security-relevant intent legible. The user also sees the source rendered with syntax highlighting; the description is a hint, not the gate.',
                    },
                    expected_output: {
                        type: 'string',
                        description: 'Your declared contract for what the script should return. Helps the user spot a mismatch at review time. v1 is human-review only; the runtime does not validate against this field.',
                    },
                },
                required: ['source', 'description', 'expected_output'],
            },
        },
        readOnly: true,
        // USER_PAUSE tool — every invocation needs a fresh sandbox run +
        // user approval; a cache hit would return last-script output for
        // a different script. Args-keyed cache would actually be okay
        // here (identical source ⇒ similar output) but the approval card
        // must surface; staying conservative.
        cache: 'never',
    });
}
