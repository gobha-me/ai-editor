// @ts-check
/**
 * AI Editor — In-editor preview & verify Tier 1 (1.22.0).
 *
 * Three tools that let the LLM render the active workspace inside a
 * sandboxed iframe and observe whether it boots. Closes the platform-level
 * gap that the 2026-05-08 Sokoban dogfood incident on HTML-Games made
 * load-bearing: the agent edited a game whose `bindEvents()` never ran
 * because `updateUI()` threw on a missing `#level-display`, and had no
 * surface to load the page and see the failure.
 *
 * Per `docs/DESIGN-preview.md` §"First-Ship Scope":
 *   - Tier 1 only — static iframe + 3 tools. Tier 2 (console / error
 *     capture, the surface that catches the Sokoban class specifically)
 *     is its own minor; Tier 3 (driveable preview, sidecar) is gated on
 *     dogfood signal.
 *   - Iframe sandbox is the trust boundary. `sandbox="allow-scripts"`
 *     (no `allow-same-origin`) on the editor's own origin; the iframe's
 *     effective origin is `null`, so it cannot reach `window.parent.State`,
 *     `localStorage`, cookies, or any editor surface. Mirrors §1.16.0's
 *     Worker boundary at the content-execution level.
 *   - Service Worker resolves workspace paths via `Git.getFile` and
 *     synthesizes responses with extension-derived MIME + a CSP that
 *     locks the iframe to `default-src 'self'`. The SW is the server.
 *
 * All three tools are `readOnly: true` — they observe the workspace,
 * never edit it. Plan Mode keeps them admitted. Per-profile admission
 * via `coder.v1.tools.static`; chat.v1 / kb.v1 don't admit them.
 * Runtime filter (`applyPreviewToolFilter` in `js/llm/api.js`) drops the
 * tools when `preview.enabled === false` on the resolved profile +
 * settings overlay (`State.settings.preview.enabled`).
 *
 * Contract — short:
 *   - preview_start({path?})    → { serverId, url, path } | { requires_build_step: true, hint }
 *   - preview_stop({serverId})  → { stopped: true }
 *   - preview_list()            → { servers: [{serverId, path, url, createdAt}] }
 *
 * The handlers proxy into `js/preview/preview-host.js`, which owns the
 * Service Worker registration, the in-memory server registry, and the
 * slide-over mount. Splitting tool defs from lifecycle keeps the
 * registration site Node-importable for tests (the host module touches
 * `navigator.serviceWorker` and `document`, neither of which exists in
 * the Node `--test` runner).
 *
 * @since 1.22.0
 * @module tools/preview-tools
 */

import {
    previewStart,
    previewStop,
    previewList,
    getConsoleLogs,
    getErrors,
    getRouteLogs,
    getNetwork,
} from '../preview/preview-host.js';

/**
 * Register the three preview tools. Always registers; whether they're
 * admitted into the per-turn tool list is a separate decision at
 * Composer + filter time.
 *
 * @param {{register: Function}} registry
 */
export function registerPreviewTools(registry) {
    registry.register('preview_start', async (args) => {
        const argObj = (args && typeof args === 'object') ? args : {};
        const rawPath = typeof argObj.path === 'string' ? argObj.path : '';
        const path = rawPath.trim() || 'index.html';
        return previewStart({ path });
    }, {
        type: 'function',
        function: {
            name: 'preview_start',
            description: 'Render the active workspace in a sandboxed iframe and return its URL. Tier 1: static preview only — the iframe loads workspace files via the editor\'s `Git.getFile` adapter, runs at a sandboxed null origin (cannot reach the editor\'s State / localStorage / tokens), and is constrained by a CSP that blocks outbound network. Use this to verify a page actually renders after an edit; the URL is opened in a slide-over panel for the user.\n\n**What it catches today:** "did anything render at all" — blank-page failures, missing entrypoint, asset 404s in `preview_logs`. **What it does NOT catch:** uncaught exceptions during boot (e.g. Sokoban-class TypeError from a missing `#level-display`) — those wait for Tier 2 (`preview_console_logs` / `preview_errors`).\n\n**Build-step projects.** If the workspace has a `package.json` with `scripts.dev` (Vite, Webpack, etc.), the tool returns `{requires_build_step: true, hint}` instead of a URL — Tier 1 cannot serve a build pipeline. Tier 3 sidecar handles those cases.\n\nProvide `path` (workspace-relative; defaults to `index.html`). The slide-over opens automatically; the returned URL is informational. Idempotent — calling with the same `path` returns the existing `serverId`.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Workspace-relative path to load. Defaults to `index.html`. Must be a real file in the active project; non-existent paths return a `no_entrypoint` error (the model can re-call with a different path).',
                    },
                },
                required: [],
            },
        },
        roles: 'all',
        readOnly: true,
    });

    registry.register('preview_stop', async (args) => {
        const argObj = (args && typeof args === 'object') ? args : {};
        const serverId = typeof argObj.serverId === 'string' ? argObj.serverId.trim() : '';
        if (!serverId) {
            return { error: 'preview_stop requires a non-empty "serverId" string (returned from a prior preview_start call).' };
        }
        return previewStop({ serverId });
    }, {
        type: 'function',
        function: {
            name: 'preview_stop',
            description: 'Stop a running preview by `serverId`. Removes the iframe from the slide-over and drops the in-memory server entry; idempotent — stopping an unknown `serverId` returns `{stopped: true}` without error.',
            parameters: {
                type: 'object',
                properties: {
                    serverId: {
                        type: 'string',
                        description: 'The `serverId` returned from a prior `preview_start` call.',
                    },
                },
                required: ['serverId'],
            },
        },
        roles: 'all',
        readOnly: true,
    });

    registry.register('preview_list', async () => {
        return previewList();
    }, {
        type: 'function',
        function: {
            name: 'preview_list',
            description: 'List currently-running preview servers in the active editor session. Returns `{servers: [{serverId, path, url, createdAt}]}`. Useful for resuming a prior preview without re-starting it, or for confirming a `preview_stop` call dropped the entry.',
            parameters: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
        roles: 'all',
        readOnly: true,
    });

    // Tier 2 (2.7.0) — capture surfaces. The shim injected by the SW
    // (`js/preview/preview-shim.js`) wraps `console.*` / `window.onerror` /
    // `unhandledrejection` and forwards events over postMessage; the host
    // (`preview-host.js`) buffers them per-`serverId` and these tools
    // expose the buffers to the LLM. All `readOnly: true` — they observe
    // the iframe's runtime, never edit it.

    registry.register('preview_console_logs', async (args) => {
        const argObj = (args && typeof args === 'object') ? args : {};
        const serverId = typeof argObj.serverId === 'string' ? argObj.serverId.trim() : '';
        if (!serverId) {
            return { error: 'preview_console_logs requires a non-empty "serverId" string (returned from a prior preview_start call).' };
        }
        const level = typeof argObj.level === 'string' ? argObj.level : undefined;
        const lines = typeof argObj.lines === 'number' ? argObj.lines : undefined;
        return getConsoleLogs({ serverId, level, lines });
    }, {
        type: 'function',
        function: {
            name: 'preview_console_logs',
            description: 'Read captured `console.{log, info, warn, error, debug}` output from a running preview. Tier 2: events are captured by a shim injected before any workspace `<script>` and forwarded to the editor over postMessage; the host buffers up to 200 entries per `serverId` (oldest dropped on overflow).\n\n**This is the load-bearing tool for the Sokoban class.** When the page renders but boot-time JS throws, the resulting `console.error` lines (or any `console.error` your code emits) appear here. Combine with `preview_errors` for full coverage — uncaught TypeErrors land in both.\n\nProvide `serverId` (from `preview_start`). Optionally `level` (`all` (default), `warn` for warn+error, `error` for error-only) and `lines` (1–200, default 50). Returns `{logs: [{level, message, ts}], truncated?: true}` — `truncated: true` means there were more matching entries than `lines` allowed.',
            parameters: {
                type: 'object',
                properties: {
                    serverId: {
                        type: 'string',
                        description: 'The `serverId` returned from a prior `preview_start` call.',
                    },
                    level: {
                        type: 'string',
                        enum: ['all', 'warn', 'error'],
                        description: 'Filter by minimum severity. `all` returns every level; `warn` returns warn+error; `error` returns only error. Default `all`.',
                    },
                    lines: {
                        type: 'integer',
                        description: 'Maximum number of most-recent entries to return (1–200). Default 50.',
                    },
                },
                required: ['serverId'],
            },
        },
        roles: 'all',
        readOnly: true,
    });

    registry.register('preview_errors', async (args) => {
        const argObj = (args && typeof args === 'object') ? args : {};
        const serverId = typeof argObj.serverId === 'string' ? argObj.serverId.trim() : '';
        if (!serverId) {
            return { error: 'preview_errors requires a non-empty "serverId" string (returned from a prior preview_start call).' };
        }
        const lines = typeof argObj.lines === 'number' ? argObj.lines : undefined;
        return getErrors({ serverId, lines });
    }, {
        type: 'function',
        function: {
            name: 'preview_errors',
            description: 'Read uncaught `window.error` events and `unhandledrejection` events from a running preview. Tier 2: hooked from the same shim that captures `console.*`, but specifically for runtime exceptions that escape user-code try/catch.\n\n**The Sokoban class lands here.** A `TypeError: Cannot read properties of null` thrown during `loadLevel(0)` shows up with `{message, source, line, col, stack}` — enough to point the model directly at the failing reference.\n\nProvide `serverId` (from `preview_start`). Optionally `lines` (1–100, default 50). Returns `{errors: [{message, source, line, col, stack, ts}], truncated?: true}`.',
            parameters: {
                type: 'object',
                properties: {
                    serverId: {
                        type: 'string',
                        description: 'The `serverId` returned from a prior `preview_start` call.',
                    },
                    lines: {
                        type: 'integer',
                        description: 'Maximum number of most-recent entries to return (1–100). Default 50.',
                    },
                },
                required: ['serverId'],
            },
        },
        roles: 'all',
        readOnly: true,
    });

    registry.register('preview_logs', async (args) => {
        const argObj = (args && typeof args === 'object') ? args : {};
        const serverId = typeof argObj.serverId === 'string' ? argObj.serverId.trim() : '';
        if (!serverId) {
            return { error: 'preview_logs requires a non-empty "serverId" string (returned from a prior preview_start call).' };
        }
        const lines = typeof argObj.lines === 'number' ? argObj.lines : undefined;
        const search = typeof argObj.search === 'string' ? argObj.search : undefined;
        return getRouteLogs({ serverId, lines, search });
    }, {
        type: 'function',
        function: {
            name: 'preview_logs',
            description: 'Read Service-Worker route stages for a running preview — the editor side of the request lifecycle, distinct from the in-iframe `preview_console_logs`. Each entry is one stage of one fetch the SW handled (intercept → host-client-pick → bridge-reply / bridge-error). Useful when the page asks for an asset that doesn\'t exist in the workspace, or when the SW couldn\'t reach the page bridge.\n\nProvide `serverId` (from `preview_start`). Optionally `lines` (1–200, default 50) and `search` (case-insensitive substring match against `stage` or `path`). Returns `{logs: [{stage, path, ts, ...}], truncated?: true}`.',
            parameters: {
                type: 'object',
                properties: {
                    serverId: {
                        type: 'string',
                        description: 'The `serverId` returned from a prior `preview_start` call.',
                    },
                    lines: {
                        type: 'integer',
                        description: 'Maximum number of most-recent entries to return (1–200). Default 50.',
                    },
                    search: {
                        type: 'string',
                        description: 'Case-insensitive substring match against `stage` or `path`. Useful for filtering to a specific asset.',
                    },
                },
                required: ['serverId'],
            },
        },
        roles: 'all',
        readOnly: true,
    });

    registry.register('preview_network', async (args) => {
        const argObj = (args && typeof args === 'object') ? args : {};
        const serverId = typeof argObj.serverId === 'string' ? argObj.serverId.trim() : '';
        if (!serverId) {
            return { error: 'preview_network requires a non-empty "serverId" string (returned from a prior preview_start call).' };
        }
        const filter = typeof argObj.filter === 'string' ? argObj.filter : undefined;
        return getNetwork({ serverId, filter });
    }, {
        type: 'function',
        function: {
            name: 'preview_network',
            description: 'List finished workspace fetches the preview Service Worker handled, with the outcome of each. One entry per request that has reached a terminal stage (bridge-replied / bridge-error / no-host-client). Useful for "did the page actually load `js/game.js`?" or "which assets 404\'d?" — separate from in-iframe `console.*` (`preview_console_logs`) and the per-stage SW route log (`preview_logs`).\n\nProvide `serverId` (from `preview_start`). Optionally `filter: \'failed\'` to return only requests that didn\'t resolve OK. Returns `{requests: [{path, ok, status, stage, ts}]}`.',
            parameters: {
                type: 'object',
                properties: {
                    serverId: {
                        type: 'string',
                        description: 'The `serverId` returned from a prior `preview_start` call.',
                    },
                    filter: {
                        type: 'string',
                        enum: ['all', 'failed'],
                        description: 'Filter the result set. `all` (default) returns every finished request; `failed` returns only requests that didn\'t resolve OK.',
                    },
                },
                required: ['serverId'],
            },
        },
        roles: 'all',
        readOnly: true,
    });
}
