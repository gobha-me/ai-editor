// @ts-check
/**
 * `PUBLIC_EVENT_CHANNELS` — the documented set of EventBus channels that
 * plugins (and other third-party consumers) may subscribe to. Several of
 * these channels intentionally have **zero in-tree subscribers**: they
 * exist as extension hooks for plugin code, not internal wiring.
 *
 * The 2026-Q2 audit sweep flagged four clusters as "0 internal
 * subscribers" — plugin lifecycle, `editor:linesReplaced/Inserted/Deleted`,
 * `ghostText:*`, `mergeConflict:*`. Each is intentional public API; the
 * grep-based channel-discovery diagnostic that opened those entries can't
 * tell "intentional extension point" from "dead wire." This registry is
 * the contract that says so.
 *
 * **2.39.0.1 (sweep wave slice 2) — git cluster expansion.** Inventory
 * entries #3 (`git:branchCreated` dual-naming) and #8 (the 13-channel
 * `git:*` 0-subscriber cluster) close by triaging each channel as either
 * (a) public-extension API → declared here, (b) internal-only with an
 * in-tree subscriber → not declared, or (c) dead-wire → emit deleted. The
 * triage outcome was: every flagged `git:*` channel resolved to (a) —
 * provider-level events follow the documented "plugin SDK extension hook"
 * pattern, and the four `git.js` paired-start emits (`git:loadingFile`/
 * `git:saving`/etc.) pair with already-subscribed completion channels
 * (`git:fileUpdated`/`git:saved`/etc.), making the start-side the natural
 * plugin-symmetry surface for loading/saving indicators.
 *
 * Single source of truth for `js/profiles/plugin-dev-v1.js`'s Plugin SDK
 * system-prompt EVENTBUS EVENTS enumeration — same pattern as 2.35.0
 * `LEGACY_TOOL_ENUMERATION` retirement (`renderToolEnumeration` derives
 * from `ToolRegistry`) and 2.37.0 `renderUntrustedMarkers` (derives from
 * `UNTRUSTED_KINDS`). Adding a new public channel here surfaces it in the
 * plugin-editor system prompt without a second edit.
 *
 * @module events/public-channels
 */

/**
 * One entry in `PUBLIC_EVENT_CHANNELS`. `name` is the canonical channel
 * string. `payload` is an optional short shape descriptor used in
 * documentation rendering.
 *
 * @typedef {Readonly<{ name: string, payload?: string }>} PublicChannelEntry
 */

/**
 * Per-surface group header. Maps the registry key to the heading shown in
 * the plugin-editor system-prompt enumeration. New groups append here.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const GROUP_LABELS = Object.freeze({
    chat: 'Chat',
    editor: 'Editor',
    files: 'Files',
    git: 'Git',
    llm: 'LLM',
    plugin: 'Plugin',
    issues: 'Issues',
    conversations: 'Conversations',
    ghostText: 'Ghost text',
    mergeConflict: 'Merge conflict',
});

/**
 * Frozen registry of public extension channels, grouped by surface. The
 * group order here is the render order in the plugin-editor system
 * prompt. Within a group, channel order matches the order channels were
 * first introduced (or alphabetical when introduction order is unclear).
 *
 * **Note — pre-2.39.0.0 corrections.** The hand-maintained list this
 * registry replaces in `js/profiles/plugin-dev-v1.js` claimed three
 * Files-group channels (`file:created`, `file:deleted`, `file:renamed`)
 * and three Issues-group channels (`issues:loaded`, `issue:created`,
 * `issue:updated`) that were never emitted by any module in `js/`. The
 * real Files channels are `fs:created/updated/deleted/renamed`; the real
 * Issues channels are `issues:render` and `issues:refresh`. This registry
 * uses the channels that actually exist; the parity-guard test in
 * `tests/test-public-event-channels.mjs` rejects any future drift.
 *
 * @type {Readonly<Record<string, ReadonlyArray<PublicChannelEntry>>>}
 */
export const PUBLIC_EVENT_CHANNELS = Object.freeze({
    chat: Object.freeze([
        Object.freeze({ name: 'chat:message', payload: '{ role, content, timestamp }' }),
        Object.freeze({ name: 'chat:cleared' }),
        Object.freeze({ name: 'chat:pruned' }),
        Object.freeze({ name: 'chat:editAndResend' }),
        Object.freeze({ name: 'chat:stashFlushed' }),
    ]),
    editor: Object.freeze([
        Object.freeze({ name: 'editor:change' }),
        Object.freeze({ name: 'editor:loaded' }),
        Object.freeze({ name: 'editor:loading' }),
        Object.freeze({ name: 'editor:created' }),
        Object.freeze({ name: 'editor:error' }),
        Object.freeze({ name: 'editor:linesReplaced' }),
        Object.freeze({ name: 'editor:linesInserted' }),
        Object.freeze({ name: 'editor:linesDeleted' }),
        Object.freeze({ name: 'editor:editApplied' }),
        Object.freeze({ name: 'editor:scrollToLine' }),
    ]),
    files: Object.freeze([
        Object.freeze({ name: 'file:opened' }),
        Object.freeze({ name: 'fs:created' }),
        Object.freeze({ name: 'fs:updated' }),
        Object.freeze({ name: 'fs:deleted' }),
        Object.freeze({ name: 'fs:renamed' }),
        Object.freeze({ name: 'tab:switched' }),
        Object.freeze({ name: 'tab:closed' }),
    ]),
    git: Object.freeze([
        Object.freeze({ name: 'git:fileUpdated' }),
        Object.freeze({ name: 'git:projectLoaded' }),
        Object.freeze({ name: 'branch:switch' }),
        Object.freeze({ name: 'branch:created', payload: '{ sourceBranch, targetBranch }' }),
        Object.freeze({ name: 'branches:refresh' }),
        Object.freeze({ name: 'tree:refresh' }),
        Object.freeze({ name: 'context:prMerged' }),
        // 2.39.0.1 (sweep wave slice 2) — provider-level lifecycle events.
        // All carry the {connectionId, owner, repo, ...} shape.
        Object.freeze({ name: 'git:repoCreated', payload: '{ connectionId, owner, repo }' }),
        // `git:branchCreated` is the provider-level companion to UI-level
        // `branch:created` — different payload shape, intentional both-emit
        // (closes inventory entry #3).
        Object.freeze({ name: 'git:branchCreated', payload: '{ connectionId, owner, repo, name }' }),
        Object.freeze({ name: 'git:branchDeleted', payload: '{ connectionId, owner, repo, name }' }),
        Object.freeze({ name: 'git:fileCreated', payload: '{ connectionId, owner, repo, path, branch, content }' }),
        Object.freeze({ name: 'git:issueCreated', payload: '{ connectionId, owner, repo, number }' }),
        Object.freeze({ name: 'git:issueCommented', payload: '{ connectionId, owner, repo, number }' }),
        Object.freeze({ name: 'git:issueUpdated', payload: '{ connectionId, owner, repo, number, ...fields }' }),
        Object.freeze({ name: 'git:mrCreated', payload: '{ connectionId, owner, repo, number }' }),
        Object.freeze({ name: 'git:prMerged', payload: '{ connectionId, owner, repo, number }' }),
        Object.freeze({ name: 'git:prReviewSubmitted', payload: '{ connectionId, owner, repo, number }' }),
        Object.freeze({ name: 'git:ciRerun', payload: '{ connectionId, owner, repo, runId }' }),
        // 2.39.0.1 (sweep wave slice 2) — js/git.js internal channels. The
        // four paired-start emits (loadingFile, fileLoaded, saving,
        // batchSaving) pair with already-subscribed completion channels
        // (git:fileUpdated, git:saved, git:batchSaved) — start-side is the
        // plugin-symmetry surface for loading/saving indicators.
        Object.freeze({ name: 'git:folderDeleted', payload: '{ owner, repo, folderPath, branch, count }' }),
        Object.freeze({ name: 'git:folderRenamed', payload: '{ owner, repo, oldFolder, newFolder, branch, count }' }),
        Object.freeze({ name: 'git:loadingFile', payload: '{ path }' }),
        Object.freeze({ name: 'git:fileLoaded', payload: '{ file, hasDraft, content }' }),
        Object.freeze({ name: 'git:saving', payload: '{ path }' }),
        Object.freeze({ name: 'git:batchSaving', payload: '{ files }' }),
    ]),
    llm: Object.freeze([
        Object.freeze({ name: 'llm:generating', payload: 'bool' }),
        Object.freeze({ name: 'model:changed' }),
        Object.freeze({ name: 'cost:updated' }),
        Object.freeze({ name: 'debug:exchange' }),
        Object.freeze({ name: 'debug:exchangeDone' }),
    ]),
    plugin: Object.freeze([
        Object.freeze({ name: 'plugin:registered' }),
        Object.freeze({ name: 'plugin:initialized' }),
        Object.freeze({ name: 'plugin:configChanged' }),
        Object.freeze({ name: 'plugin:enabledChanged' }),
        Object.freeze({ name: 'plugin:buttonRegistered' }),
        Object.freeze({ name: 'plugin:modalRegistered' }),
        Object.freeze({ name: 'plugin:toolRegistered' }),
        Object.freeze({ name: 'plugin:mcpServerRegistered' }),
        Object.freeze({ name: 'plugin:installed' }),
        Object.freeze({ name: 'plugin:uninstalled' }),
    ]),
    issues: Object.freeze([
        Object.freeze({ name: 'issues:refresh' }),
        Object.freeze({ name: 'issues:render' }),
    ]),
    conversations: Object.freeze([
        Object.freeze({ name: 'conversation:created' }),
        Object.freeze({ name: 'conversation:loaded' }),
        Object.freeze({ name: 'conversation:deleted' }),
        Object.freeze({ name: 'conversation:renamed' }),
    ]),
    ghostText: Object.freeze([
        Object.freeze({ name: 'ghostText:requested' }),
        Object.freeze({ name: 'ghostText:received' }),
        Object.freeze({ name: 'ghostText:empty' }),
        Object.freeze({ name: 'ghostText:failed' }),
        Object.freeze({ name: 'ghostText:accepted' }),
        Object.freeze({ name: 'ghostText:dismissed' }),
    ]),
    mergeConflict: Object.freeze([
        Object.freeze({ name: 'mergeConflict:opened' }),
        Object.freeze({ name: 'mergeConflict:resolved' }),
        Object.freeze({ name: 'mergeConflict:aborted' }),
        Object.freeze({ name: 'mergeConflict:aiResolve:start' }),
        Object.freeze({ name: 'mergeConflict:aiResolve:success' }),
        Object.freeze({ name: 'mergeConflict:aiResolve:error' }),
    ]),
});

/**
 * Render `PUBLIC_EVENT_CHANNELS` as the `Heading: a, b, c` block used
 * inside the Plugin SDK system-prompt addendum. Each group renders to a
 * single line, in `GROUP_LABELS` declaration order. Channels with a
 * `payload` descriptor render as `name (payload)`; otherwise just `name`.
 *
 * Pure projection — no module state, no I/O. Exported for the
 * registry-shape test in `tests/test-public-event-channels.mjs`.
 *
 * @returns {string}
 */
export function renderPublicEventChannels() {
    const lines = [];
    for (const [key, label] of Object.entries(GROUP_LABELS)) {
        const entries = PUBLIC_EVENT_CHANNELS[key];
        if (!entries || entries.length === 0) continue;
        const rendered = entries.map(e => e.payload ? `${e.name} (${e.payload})` : e.name).join(', ');
        lines.push(`${label}: ${rendered}`);
    }
    return lines.join('\n');
}
