// @ts-check
/**
 * PR Review — local review state.
 *
 * Owns the per-PR draft queue (line-anchored comments awaiting Submit),
 * the viewed-files set, and the locally-resolved-thread set. Survives
 * `closePrReview()` → `openPrReview()` swaps because the module loads
 * once. Drafts and viewed flags persist across reloads via Storage
 * (IDB-backed, with localStorage write-through); resolved-local stays
 * in-memory because the next `prs:refresh` is the source of truth.
 *
 * Pure helpers (`groupDraftsByThread`, `draftAnchorKey`) are exported
 * for the dock count math and for the `tests/test-pr-review-state.mjs`
 * suite. Anchor-key shape `${path}::${side}::${line}` matches slice-1's
 * `_commentsByAnchor` keying so the dock count and the diff-row thread
 * lookup agree by construction.
 *
 * @since 2.13.0 (Touch 3 PR Review surface — slice 2)
 * @module pr-review/review-state
 */

import { Storage } from '../core.js';

const STORAGE_PREFIX = 'pr-review';

/**
 * @typedef {Object} Draft
 * @property {string}            id
 * @property {string}            path
 * @property {number}            line
 * @property {'LEFT'|'RIGHT'}    side
 * @property {string}            body
 * @property {string}            [commitSha]
 * @property {number}            createdAt
 */

/**
 * Per-PR state record. Map keyed by PR number.
 * @typedef {{drafts: Draft[], viewed: Set<string>, resolvedLocal: Set<string|number>}} PrState
 */

/** @type {Map<number, PrState>} */
const _byPr = new Map();

/** Internal: ensure a PR record exists, hydrating from localStorage on first touch. */
function _ensure(prNumber) {
    let rec = _byPr.get(prNumber);
    if (rec) return rec;

    rec = {
        drafts: _loadDrafts(prNumber),
        viewed: _loadViewed(prNumber),
        resolvedLocal: new Set(),
    };
    _byPr.set(prNumber, rec);
    return rec;
}

// ============================================
// Storage persistence
// ============================================
// Lazy per-PR migration from the pre-2.40.0 unprefixed legacy keys
// (`pr-review.drafts.${N}` / `pr-review.viewed.${N}`) onto Storage —
// drafts for un-opened PRs stay in raw localStorage until the user
// reopens that PR, at which point `_ensure` triggers `_loadDrafts`
// → `migrateLegacyKey` → IDB + cache. Survives quota events thereafter
// (memory `feedback_storage_idb_authoritative.md`).

function _draftsKey(prNumber) { return `${STORAGE_PREFIX}.drafts.${prNumber}`; }
function _viewedKey(prNumber) { return `${STORAGE_PREFIX}.viewed.${prNumber}`; }

function _loadDrafts(prNumber) {
    const key = _draftsKey(prNumber);
    Storage.migrateLegacyKey(key, key);
    const parsed = Storage.get(key, []);
    return Array.isArray(parsed) ? parsed.filter(_isValidDraft) : [];
}

function _persistDrafts(prNumber, drafts) {
    Storage.set(_draftsKey(prNumber), drafts);
}

function _loadViewed(prNumber) {
    const key = _viewedKey(prNumber);
    Storage.migrateLegacyKey(key, key);
    const parsed = Storage.get(key, []);
    return new Set(Array.isArray(parsed) ? parsed : []);
}

function _persistViewed(prNumber, viewed) {
    Storage.set(_viewedKey(prNumber), Array.from(viewed));
}

function _isValidDraft(d) {
    return d
        && typeof d.id === 'string'
        && typeof d.path === 'string'
        && typeof d.line === 'number'
        && (d.side === 'LEFT' || d.side === 'RIGHT')
        && typeof d.body === 'string';
}

// ============================================
// Drafts
// ============================================

/** @returns {Draft[]} A defensive copy of the current draft list. */
export function getDrafts(prNumber) {
    return [..._ensure(prNumber).drafts];
}

/**
 * Append a draft. Returns the appended record (with auto-filled `id` +
 * `createdAt` if omitted).
 *
 * @param {number} prNumber
 * @param {Omit<Draft,'id'|'createdAt'> & {id?:string, createdAt?:number}} partial
 * @returns {Draft}
 */
export function addDraft(prNumber, partial) {
    const rec = _ensure(prNumber);
    const draft = {
        id: partial.id || _genId(),
        createdAt: partial.createdAt || Date.now(),
        path: partial.path,
        line: partial.line,
        side: partial.side,
        body: partial.body,
        commitSha: partial.commitSha,
    };
    if (!_isValidDraft(draft)) {
        throw new Error('addDraft: invalid draft shape');
    }
    rec.drafts.push(draft);
    _persistDrafts(prNumber, rec.drafts);
    return draft;
}

/** Remove a draft by id. No-op if not found. */
export function removeDraft(prNumber, draftId) {
    const rec = _ensure(prNumber);
    const next = rec.drafts.filter(d => d.id !== draftId);
    if (next.length === rec.drafts.length) return;
    rec.drafts = next;
    _persistDrafts(prNumber, rec.drafts);
}

/** Drop all drafts for this PR. Called after Submit success. */
export function clearDrafts(prNumber) {
    const rec = _ensure(prNumber);
    rec.drafts = [];
    _persistDrafts(prNumber, rec.drafts);
}

// ============================================
// Viewed-set (per-file)
// ============================================

export function getViewed(prNumber) {
    return new Set(_ensure(prNumber).viewed);
}

export function isFileViewed(prNumber, path) {
    return _ensure(prNumber).viewed.has(path);
}

/**
 * Toggle `path`'s viewed flag. Returns the new boolean.
 * @returns {boolean}
 */
export function toggleViewed(prNumber, path) {
    const rec = _ensure(prNumber);
    if (rec.viewed.has(path)) {
        rec.viewed.delete(path);
    } else {
        rec.viewed.add(path);
    }
    _persistViewed(prNumber, rec.viewed);
    return rec.viewed.has(path);
}

// ============================================
// Locally-resolved threads
// ============================================

export function getResolvedLocal(prNumber) {
    return new Set(_ensure(prNumber).resolvedLocal);
}

export function isThreadResolvedLocal(prNumber, threadId) {
    return _ensure(prNumber).resolvedLocal.has(threadId);
}

/**
 * Mark a thread resolved locally (UX-only hide). The provider-side
 * resolve API isn't supported by Gitea or by GitHub REST; this is the
 * best-effort hide so users can clean up their view.
 */
export function markResolvedLocal(prNumber, threadId) {
    _ensure(prNumber).resolvedLocal.add(threadId);
}

export function unmarkResolvedLocal(prNumber, threadId) {
    _ensure(prNumber).resolvedLocal.delete(threadId);
}

// ============================================
// Pure helpers (export for tests)
// ============================================

/**
 * Anchor key for a draft. Matches slice-1's `_commentsByAnchor` keying
 * convention `${path}::${side}::${line}` — so dock counts and diff-row
 * thread renders agree by construction.
 *
 * @param {{path:string, side:'LEFT'|'RIGHT', line:number}} d
 */
export function draftAnchorKey(d) {
    return `${d.path}::${d.side}::${d.line}`;
}

/**
 * Group drafts into a Map keyed by anchor. Each value is the list of
 * drafts on that line (multiple drafts on the same line are allowed).
 *
 * @param {Draft[]} drafts
 * @returns {Map<string, Draft[]>}
 */
export function groupDraftsByThread(drafts) {
    const map = new Map();
    for (const d of drafts) {
        const key = draftAnchorKey(d);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(d);
    }
    return map;
}

// ============================================
// ID generation
// ============================================

function _genId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `d_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ============================================
// Test seam
// ============================================

/** Internal: clear all in-memory state for the current process. */
export function _resetForTests() {
    _byPr.clear();
}
