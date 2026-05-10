// @ts-check
/**
 * AI Editor — MCP auto-test policy (2.16.0)
 *
 * github#27 Phase 2 slice 2. The Settings → MCP Servers tab fires
 * `MCPServerRegistry.testConnection` automatically after Save and
 * surfaces the outcome via toast. This module owns the two pure
 * decisions that drive that flow:
 *
 *   - `shouldAutoTest({preSave, postSave})` decides whether to skip
 *     (label-only edit, server saved disabled) or fire the probe.
 *   - `formatTestResultToast({label, result})` shapes the result toast
 *     so the message + kind have unit coverage instead of being inline
 *     string concatenation in the tab.
 *
 * Pure on purpose — keeps the slice's behavior testable under
 * `node --test` without a DOM, mirrors the `catalog-merge.js` /
 * `catalog-source.js` parser-vs-IO split that landed at 2.15.0.
 *
 * Latency contract: the Save toast itself fires synchronously in the
 * tab; the auto-test runs only when this module says so, with results
 * landing as a follow-up toast. A slow or broken probe never blocks the
 * Save acknowledgement.
 *
 * @module mcp/auto-test
 */

/**
 * Should the tab fire `testConnection` after a Save?
 *
 * Adds (preSave === null): yes when the new server is enabled. A
 * disabled new server is an explicit user opt-out — testing it would
 * be wasteful and confusing.
 *
 * Edits: yes when the post-save server is enabled AND at least one of
 * `url` / `token` / `transport` actually changed, OR the server just
 * transitioned disabled → enabled. A label-only rename on an already-
 * enabled server returns false (no protocol round-trip).
 *
 * @param {{preSave: Object|null, postSave: Object}} args
 * @returns {boolean}
 */
export function shouldAutoTest({ preSave, postSave }) {
    if (!postSave || typeof postSave !== 'object') return false;
    if (postSave.enabled === false) return false;
    if (!postSave.url) return false;

    if (preSave === null || preSave === undefined) return true;
    if (typeof preSave !== 'object') return true;

    if (preSave.enabled === false) return true;

    if (preSave.url !== postSave.url) return true;
    if ((preSave.token || '') !== (postSave.token || '')) return true;
    const preTransport = preSave.transport || 'streamable-http';
    const postTransport = postSave.transport || 'streamable-http';
    if (preTransport !== postTransport) return true;

    return false;
}

/**
 * Shape the result toast for a `testConnection` outcome. Pure — the
 * Settings tab passes the live label + the registry's result envelope
 * and gets back a `{message, kind}` pair to hand to `window.showToast`.
 *
 * @param {{label: string, result: {ok?: boolean, toolCount?: number, error?: string}}} args
 * @returns {{message: string, kind: 'success'|'warning'}}
 */
export function formatTestResultToast({ label, result }) {
    const safeLabel = (label && String(label)) || 'MCP server';
    if (result && result.ok) {
        const count = Number.isFinite(result.toolCount) ? result.toolCount : 0;
        const word = count === 1 ? 'tool' : 'tools';
        return {
            message: `✅ ${safeLabel}: connected — ${count} ${word} advertised`,
            kind: 'success',
        };
    }
    const err = (result && result.error) ? String(result.error) : 'Connection failed';
    return {
        message: `⚠️ ${safeLabel}: ${err}. Edit the server to fix.`,
        kind: 'warning',
    };
}
