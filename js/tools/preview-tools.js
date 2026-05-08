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
}
