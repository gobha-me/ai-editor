// @ts-check
/**
 * AI Editor — In-editor preview & verify (Tier 1 / 2 / 3a — 1.22.0 / 2.7.0 / 2.10.0).
 *
 * Twelve tools that let the LLM render the active workspace inside a
 * sandboxed iframe, observe whether it boots, read its captured logs,
 * and now (Tier 3a) drive the page via selector-shaped click / fill /
 * inspect / snapshot / resize. Closes the platform-level gap that the
 * 2026-05-08 Sokoban dogfood incident on HTML-Games made load-bearing.
 *
 * Per `docs/DESIGN-preview.md` §Phased Delivery:
 *   - Tier 1 (1.22.0) — static iframe + 3 lifecycle tools. Catches "did
 *     anything render at all."
 *   - Tier 2 (2.7.0) — console / error / route / network capture
 *     readers. Catches the Sokoban class (boot-time TypeErrors).
 *   - Tier 3a (2.10.0) — driveable preview via selector-shaped tools
 *     (`preview_snapshot`, `preview_click`, `preview_fill`,
 *     `preview_inspect`, `preview_resize`). Catches integration-shape
 *     bugs ("does pressing arrow-up move the player?"). `preview_eval`
 *     is deliberately NOT shipped — selector-shaped tools cover the
 *     agent's actual probes; arbitrary-JS injection inverts trust.
 *   - Tier 3b (sidecar / build-step support) — separate minor.
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
    previewClick,
    previewFill,
    previewInspect,
    previewSnapshot,
    previewResize,
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
        readOnly: true,
    });

    // Tier 3a (2.10.0) — driveable preview. Selector-shaped tools that
    // round-trip a request envelope through the iframe shim and return
    // the iframe's reply. Closes the integration-shape bug class on
    // non-build-step projects (Sokoban, Snake, Forge-Defense — vanilla-
    // JS HTML-Games corpus). `preview_eval` is deliberately NOT shipped
    // (DESIGN-preview.md §"Three-Tier Delivery Shape" → "may never
    // ship"); selector-shaped tools cover the agent's actual probes.
    // Sidecar / build-step support (Tier 3b) is its own minor.

    registry.register('preview_snapshot', async (args) => {
        const argObj = (args && typeof args === 'object') ? args : {};
        const serverId = typeof argObj.serverId === 'string' ? argObj.serverId.trim() : '';
        if (!serverId) {
            return { error: 'preview_snapshot requires a non-empty "serverId" string (returned from a prior preview_start call).' };
        }
        const visibleOnly = argObj.visibleOnly !== false;  // default true
        return previewSnapshot({ serverId, visibleOnly });
    }, {
        type: 'function',
        function: {
            name: 'preview_snapshot',
            description: 'Walk the live DOM in the running preview and return an accessibility-shaped tree of up to 500 elements. **The preferred verifier — cheaper and more deterministic than screenshots.** Each emitted element gets a `data-preview-uid="u_N"` attribute written onto the live DOM, so a follow-up `preview_click({selector: \'[data-preview-uid="u_5"]\'})` resolves robustly even if the page mutated since the snapshot.\n\nReturns `{ok: true, elements: [{uid, tag, role, name, text, visible, bbox, ...}], truncated, url, title}`. `truncated: true` means the page exceeded the 500-element cap (newest elements dropped; capture is depth-first document order). For inputs/buttons/anchors, the entry includes `value`/`type`/`disabled`/`href` as applicable.\n\nProvide `serverId` (from `preview_start`). Optional `visibleOnly` (default `true`) skips elements whose `display: none` / `visibility: hidden` / `opacity: 0` parents make them invisible — set `false` only when you specifically need to probe collapsed UI.',
            parameters: {
                type: 'object',
                properties: {
                    serverId: {
                        type: 'string',
                        description: 'The `serverId` returned from a prior `preview_start` call.',
                    },
                    visibleOnly: {
                        type: 'boolean',
                        description: 'When true (default), only emit visible elements. Set false to include hidden subtrees (e.g. collapsed dialogs).',
                    },
                },
                required: ['serverId'],
            },
        },
        readOnly: true,
    });

    registry.register('preview_click', async (args) => {
        const argObj = (args && typeof args === 'object') ? args : {};
        const serverId = typeof argObj.serverId === 'string' ? argObj.serverId.trim() : '';
        const selector = typeof argObj.selector === 'string' ? argObj.selector : '';
        if (!serverId) return { error: 'preview_click requires a non-empty "serverId".' };
        if (!selector) return { error: 'preview_click requires a non-empty "selector" (CSS selector).' };
        const doubleClick = !!argObj.doubleClick;
        return previewClick({ serverId, selector, doubleClick });
    }, {
        type: 'function',
        function: {
            name: 'preview_click',
            description: 'Dispatch a click on the first element matching the CSS `selector` inside the running preview. Use uid selectors from `preview_snapshot` (`[data-preview-uid="u_N"]`) for mutation-robust targeting, or any other valid selector. The call returns once the click handler synchronously returns; subsequent observation should use `preview_snapshot` / `preview_inspect` / `preview_console_logs` to verify the side effect.\n\nReturns `{ok: true, clicked: true, tag}` on success or `{ok: false, error, message}` on failure (`not_found` if the selector matched nothing, `click_failed` if the dispatch threw, `preview_timeout` if the iframe didn\'t respond in 5s).\n\nProvide `serverId` and `selector`. Optional `doubleClick: true` dispatches click + dblclick.',
            parameters: {
                type: 'object',
                properties: {
                    serverId: {
                        type: 'string',
                        description: 'The `serverId` returned from a prior `preview_start` call.',
                    },
                    selector: {
                        type: 'string',
                        description: 'CSS selector identifying the click target. Prefer `[data-preview-uid="u_N"]` uids from `preview_snapshot` for stability.',
                    },
                    doubleClick: {
                        type: 'boolean',
                        description: 'When true, dispatch both `click` and `dblclick` events. Default false.',
                    },
                },
                required: ['serverId', 'selector'],
            },
        },
        readOnly: true,
    });

    registry.register('preview_fill', async (args) => {
        const argObj = (args && typeof args === 'object') ? args : {};
        const serverId = typeof argObj.serverId === 'string' ? argObj.serverId.trim() : '';
        const selector = typeof argObj.selector === 'string' ? argObj.selector : '';
        if (!serverId) return { error: 'preview_fill requires a non-empty "serverId".' };
        if (!selector) return { error: 'preview_fill requires a non-empty "selector" (CSS selector).' };
        const value = argObj.value === undefined || argObj.value === null ? '' : String(argObj.value);
        return previewFill({ serverId, selector, value });
    }, {
        type: 'function',
        function: {
            name: 'preview_fill',
            description: 'Set the `value` on a form element matching `selector` and dispatch `input` + `change` events. Targets `<input>`, `<textarea>`, `<select>` — anything with a `.value` property; non-fillable elements return `not_fillable`. Uses the prototype\'s native `value` setter so React/Preact controlled inputs fire their listeners (plain `el.value = x` skips them).\n\nReturns `{ok: true, filled: true, value}` on success or `{ok: false, error, message}` on failure.\n\nProvide `serverId`, `selector`, and `value` (string).',
            parameters: {
                type: 'object',
                properties: {
                    serverId: {
                        type: 'string',
                        description: 'The `serverId` returned from a prior `preview_start` call.',
                    },
                    selector: {
                        type: 'string',
                        description: 'CSS selector identifying the form field.',
                    },
                    value: {
                        type: 'string',
                        description: 'Value to set. Coerced to string.',
                    },
                },
                required: ['serverId', 'selector', 'value'],
            },
        },
        readOnly: true,
    });

    registry.register('preview_inspect', async (args) => {
        const argObj = (args && typeof args === 'object') ? args : {};
        const serverId = typeof argObj.serverId === 'string' ? argObj.serverId.trim() : '';
        const selector = typeof argObj.selector === 'string' ? argObj.selector : '';
        if (!serverId) return { error: 'preview_inspect requires a non-empty "serverId".' };
        if (!selector) return { error: 'preview_inspect requires a non-empty "selector" (CSS selector).' };
        const styles = Array.isArray(argObj.styles) ? argObj.styles.filter(s => typeof s === 'string') : undefined;
        return previewInspect({ serverId, selector, styles });
    }, {
        type: 'function',
        function: {
            name: 'preview_inspect',
            description: 'Return computed style + text + bounding box for a single element matching `selector`. **The right tool for verifying visual properties** — structured output beats pixel-grading a screenshot. Defaults to the most-asked styles (`display`, `visibility`, `opacity`, `color`, `backgroundColor`, `fontSize`, `fontFamily`); pass an explicit `styles` array to read others.\n\nReturns `{ok: true, tagName, id, className, textContent, computedStyle, boundingBox: {x,y,w,h}}` on success or `{ok: false, error, message}` on failure.\n\nProvide `serverId` and `selector`. Optionally `styles` — array of CSS property names to read (camelCase, e.g. `["marginTop", "borderRadius"]`).',
            parameters: {
                type: 'object',
                properties: {
                    serverId: {
                        type: 'string',
                        description: 'The `serverId` returned from a prior `preview_start` call.',
                    },
                    selector: {
                        type: 'string',
                        description: 'CSS selector identifying the element to inspect.',
                    },
                    styles: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional list of computed-style property names to read (camelCase). Defaults to common visual properties.',
                    },
                },
                required: ['serverId', 'selector'],
            },
        },
        readOnly: true,
    });

    registry.register('preview_resize', async (args) => {
        const argObj = (args && typeof args === 'object') ? args : {};
        const serverId = typeof argObj.serverId === 'string' ? argObj.serverId.trim() : '';
        if (!serverId) return { error: 'preview_resize requires a non-empty "serverId".' };
        const preset = typeof argObj.preset === 'string' ? argObj.preset : undefined;
        const width = typeof argObj.width === 'number' ? argObj.width : undefined;
        const height = typeof argObj.height === 'number' ? argObj.height : undefined;
        return previewResize({ serverId, preset, width, height });
    }, {
        type: 'function',
        function: {
            name: 'preview_resize',
            description: 'Resize the preview iframe element. Use `preset: "mobile"|"tablet"|"desktop"` for canonical viewport sizes (390×844, 820×1180, 1280×800), or pass explicit `width`/`height` in pixels. Adjusts the iframe element\'s CSS dimensions only — `prefers-color-scheme` / device-emulation are out of v1.\n\nReturns `{resized: true, width, height, preset}` on success.\n\nProvide `serverId` and either a `preset` or `width`/`height`.',
            parameters: {
                type: 'object',
                properties: {
                    serverId: {
                        type: 'string',
                        description: 'The `serverId` returned from a prior `preview_start` call.',
                    },
                    preset: {
                        type: 'string',
                        enum: ['mobile', 'tablet', 'desktop'],
                        description: 'Canonical viewport preset. `mobile`=390×844, `tablet`=820×1180, `desktop`=1280×800.',
                    },
                    width: {
                        type: 'number',
                        description: 'Explicit width in pixels. Ignored if `preset` is set.',
                    },
                    height: {
                        type: 'number',
                        description: 'Explicit height in pixels. Ignored if `preset` is set.',
                    },
                },
                required: ['serverId'],
            },
        },
        readOnly: true,
    });
}
