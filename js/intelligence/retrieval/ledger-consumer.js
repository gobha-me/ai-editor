// @ts-check
/**
 * Ledger consumer — step 6.5 of [DESIGN-retrieval.md](../../../docs/DESIGN-retrieval.md)
 * §"Composition Algorithm" (lines 439–471). Replaces the no-op stub left
 * by the Composer in 1.4.17 and lands as PR 10 of the 1.5.0 stream
 * (1.4.18).
 *
 * Given the post-step-6 candidate set and the caller's `TaskLedger`,
 * `consultLedger` decides which candidates are *novel enough* to warrant
 * full re-admission and which can be replaced with ~20-token reference
 * markers. The design's framing: "the single intentional case of
 * cross-call state in the otherwise-stateless retrieval contract,
 * justified by the cost discipline" — legitimately context-heavy
 * multi-turn tasks become tractable only when previously-admitted
 * chunks don't pay full freight on every re-retrieval.
 *
 * **Algorithm (mirrors design lines 464–471):**
 *
 *   1. Per-pass setup — collect pinned ids (never suppress), resolve a
 *      per-call `turn_id` (request → opts → synth fallback).
 *   2. For each candidate chunk in `selected`:
 *      a. **Pinned bypass.** If chunk.id is in `priority_pins`, append a
 *         `strategy: "pinned"` admission and keep the chunk verbatim.
 *      b. **Cold candidate.** No prior admission for this chunk_id →
 *         append a fresh admission and keep the chunk.
 *      c. **Prior admission exists.** Compute novelty score (see below).
 *         - **High novelty** (≥ threshold) → re-admit; append a fresh
 *           admission record; chunk passes through unchanged.
 *         - **Low novelty** (< threshold) → suppress; replace chunk with
 *           a marker surrogate in the kept list; append an exclusion
 *           record with `reason: "already_admitted_low_novelty"`.
 *   3. Caller wires the `kept` list back into the Composer pipeline as
 *      input to step 7 (overflow guard).
 *
 * **Novelty signals** (per design line 467):
 *
 *   - **Token-set Jaccard** between current query and prior admission's
 *     justifying query — weight `0.45`. Lowercase, split on
 *     `/[^a-z0-9]+/`, drop tokens shorter than 3 chars, drop a small
 *     stop-set. `1 - jaccard` (low overlap → high novelty). When either
 *     side is empty, contributes `1.0` (re-admit when in doubt).
 *   - **Cosine distance** between current and prior `query_embedding`
 *     when both are present — weight `0.30`. `1 - cosine`. When either
 *     is absent, the weight redistributes onto Jaccard (Jaccard then
 *     carries `0.75`); the consumer never grows an embedder dep just to
 *     compute this.
 *   - **Time elapsed** since `prior.admitted_at`, scaled by
 *     `opts.timeDecayMs` (default 30 minutes) — weight `0.25`. Longer
 *     elapsed → more novel.
 *   - **Explicit re-examination** — short-circuits to novelty `1.0`
 *     when:
 *       * `req.strategy_hints` has an entry with `mode: "force"` whose
 *         `strategy` matches `prior.strategy`, OR
 *       * any hint's `reason` field carries the literal
 *         `re_examine:<chunk_id>` carrier (matching the candidate id).
 *
 *   Composite is a weighted average; threshold defaults to `0.4`
 *   (re-admit when in doubt — design's "conservative default"). Both
 *   `noveltyThreshold` and `timeDecayMs` are tunable via `opts` so that
 *   profile-level tuning lands as config, not code.
 *
 * **Marker shape** (per design line 469):
 *
 *   ```
 *   id: "ledger_marker:<original_id>:<turn_id>"
 *   content: "[Already admitted: <original_id> — see turn <prior_turn_id>]"
 *   tokens: 20  // fixed; matches design's "~20 tokens"
 *   provenance.retrieved_by: "ledger_marker"
 *   ```
 *
 *   The marker enters `selected` and flows through step 7 (overflow)
 *   and step 8 (block assembly) unmodified — the Composer doesn't grow
 *   a marker-aware code path. `chunks_by_id` carries the marker; the
 *   suppressed chunk's original id is parseable from the marker id (the
 *   substring after `ledger_marker:` up to the next `:` — see the
 *   reserved namespace doc on `ChunkID` in `contracts.js`).
 *
 * **Side effects.** `consultLedger` mutates `ledger.admissions` and
 * `ledger.exclusions` per the design's "appends new admission records
 * as a side effect of retrieval" rule. The ledger object passed in is
 * the production source of truth (typically per-conversation, owned by
 * `js/chat/task-state.js`); tests inject a freshly-constructed ledger
 * and assert against its arrays.
 *
 * **Known limitation (Phase 1).** Admissions are appended in step 6.5,
 * *before* step 7's overflow guard. A chunk that step 7 then evicts for
 * budget reasons leaves an admission record behind that the next call
 * will see and may suppress against. A post-overflow ledger
 * reconciliation pass is deferred to a 1.5.x follow-up — the design's
 * pseudocode places consultation before overflow, so this PR honors
 * that ordering and documents the trade-off rather than diverging.
 *
 * **Capacity spill.** When `ledger.admissions.length` reaches
 * `ledger.capacity`, older records should spill to a compact form (drop
 * `query_embedding`) and eventually drop entirely. That's the ledger
 * owner's job (`js/profiles/task-ledger.js`), not the consumer's — this
 * module appends unconditionally.
 *
 * **Removability.** Like the rest of the 1.5.0 stream, no production
 * wiring: `find_relevant_files` continues to run through
 * `js/context-manager.js`. With this module deleted and the step-6.5
 * call removed from `composer.js`, nothing in production degrades.
 *
 * @module intelligence/retrieval/ledger-consumer
 */

/**
 * @typedef {import('./contracts.js').ChunkRef} ChunkRef
 * @typedef {import('./contracts.js').ChunkID} ChunkID
 * @typedef {import('./contracts.js').RetrievalRequest} RetrievalRequest
 * @typedef {import('./contracts.js').StrategyName} StrategyName
 * @typedef {import('./contracts.js').StrategyHint} StrategyHint
 * @typedef {import('../../profiles/task-ledger.js').TaskLedger} TaskLedger
 * @typedef {import('../../profiles/task-ledger.js').AdmissionRecord} AdmissionRecord
 * @typedef {import('../../profiles/task-ledger.js').ExclusionRecord} ExclusionRecord
 */

/**
 * Default novelty threshold — re-admit when in doubt.
 */
export const DEFAULT_NOVELTY_THRESHOLD = 0.4;

/**
 * Default time-decay window in milliseconds (30 minutes). Past this
 * point, the time-elapsed signal saturates at full novelty.
 */
export const DEFAULT_TIME_DECAY_MS = 30 * 60 * 1000;

/**
 * Fixed token cost of a suppression marker. Matches the design's
 * "~20 tokens instead of the full chunk size" line.
 */
export const MARKER_TOKEN_COST = 20;

/**
 * Component weights for the composite novelty score. When cosine is
 * unavailable (either embedding null), its weight is folded into
 * Jaccard so the time term keeps its share — Jaccard then carries
 * `JACCARD_WEIGHT + COSINE_WEIGHT`.
 */
const JACCARD_WEIGHT = 0.45;
const COSINE_WEIGHT = 0.30;
const TIME_WEIGHT = 0.25;

/**
 * Stop-set for token-set tokenization. Deliberately tiny — the design's
 * Jaccard signal is meant to differ on *concept* tokens, and aggressive
 * stop-listing can collapse two distinct queries into the same set.
 */
const STOP_TOKENS = new Set(['the', 'and', 'for', 'with', 'from']);

/**
 * Module-level monotonic counter that disambiguates synthesized
 * `turn_id`s minted in the same wall-clock millisecond. Reset is a
 * test-only seam (see `_resetTurnIdCounterForTests`).
 */
let _synthCounter = 0;

/**
 * Test seam — reset the synth counter between cases that assert
 * specific id strings. Product code should not call this.
 */
export function _resetTurnIdCounterForTests() {
    _synthCounter = 0;
}

/**
 * Tokenize a free-form query into the set used for Jaccard scoring.
 * Lowercase, split on non-alphanumerics, drop tokens shorter than 3
 * chars, drop the small stop-set. Empty / non-string inputs return an
 * empty Set.
 *
 * @param {string|null|undefined} query
 * @returns {Set<string>}
 */
function tokenizeForJaccard(query) {
    if (typeof query !== 'string' || query.length === 0) return new Set();
    const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    /** @type {Set<string>} */
    const out = new Set();
    for (const t of tokens) {
        if (t.length < 3) continue;
        if (STOP_TOKENS.has(t)) continue;
        out.add(t);
    }
    return out;
}

/**
 * Jaccard similarity over two token sets — `|A ∩ B| / |A ∪ B|`.
 * Returns `NaN` when both sets are empty (caller treats as max
 * novelty); returns 0 when one side is empty (no overlap, max
 * novelty).
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
function jaccard(a, b) {
    if (a.size === 0 && b.size === 0) return NaN;
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter += 1;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * Cosine similarity over two equal-length numeric vectors. Returns
 * `null` when either argument is missing, mismatched in length, or
 * has zero magnitude on either side (degenerate vector — the consumer
 * treats null as "signal unavailable").
 *
 * @param {number[]|null|undefined} a
 * @param {number[]|null|undefined} b
 * @returns {number|null}
 */
function cosine(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return null;
    if (a.length === 0 || a.length !== b.length) return null;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        const av = Number(a[i]) || 0;
        const bv = Number(b[i]) || 0;
        dot += av * bv;
        magA += av * av;
        magB += bv * bv;
    }
    if (magA === 0 || magB === 0) return null;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Find the most-recent prior admission record for `chunkId`. Linear
 * scan; admission arrays are capped at `ledger.capacity` (default 500
 * per `task-ledger.js`), so n is bounded.
 *
 * @param {TaskLedger} ledger
 * @param {ChunkID}    chunkId
 * @returns {AdmissionRecord|null}
 */
export function _findMostRecentAdmission(ledger, chunkId) {
    if (!ledger || !Array.isArray(ledger.admissions)) return null;
    /** @type {AdmissionRecord|null} */
    let best = null;
    for (const a of ledger.admissions) {
        if (!a || a.chunk_id !== chunkId) continue;
        if (best === null || (a.admitted_at || 0) > (best.admitted_at || 0)) best = a;
    }
    return best;
}

/**
 * Return `true` when the request explicitly forces re-examination of
 * the candidate. Two carriers:
 *   - `mode: "force"` hint whose `strategy` matches the prior
 *     admission's strategy (caller-level instruction to reset
 *     suppression for an entire strategy this turn).
 *   - any hint with `reason: "re_examine:<chunk_id>"` matching the
 *     candidate id (chunk-level instruction).
 *
 * @param {ChunkID}                candidateId
 * @param {AdmissionRecord}        prior
 * @param {StrategyHint[]|null|undefined} hints
 * @returns {boolean}
 */
function hasExplicitForce(candidateId, prior, hints) {
    if (!Array.isArray(hints) || hints.length === 0) return false;
    const reExamineMarker = `re_examine:${candidateId}`;
    for (const h of hints) {
        if (!h || typeof h !== 'object') continue;
        if (h.mode === 'force' && h.strategy && h.strategy === prior.strategy) return true;
        if (typeof h.reason === 'string' && h.reason === reExamineMarker) return true;
    }
    return false;
}

/**
 * Compute the composite novelty score for `prior` vs the current
 * request. Returns `1.0` for an explicit force hint or empty-on-both-
 * sides degenerate cases (caller treats as "re-admit"). Otherwise a
 * weighted blend of Jaccard + (cosine-or-Jaccard-fallback) + time.
 *
 * Pure function — no side effects, no clock reads (uses `now` arg).
 *
 * @param {Object} args
 * @param {ChunkID}                args.candidateId
 * @param {string|null|undefined}  args.currentQuery
 * @param {number[]|null|undefined} args.currentEmbedding
 * @param {StrategyHint[]|null|undefined} args.hints
 * @param {AdmissionRecord}        args.prior
 * @param {number}                 args.now
 * @param {number}                 args.timeDecayMs
 * @returns {number}
 */
export function _computeNovelty({ candidateId, currentQuery, currentEmbedding, hints, prior, now, timeDecayMs }) {
    if (hasExplicitForce(candidateId, prior, hints)) return 1;

    const jacRaw = jaccard(tokenizeForJaccard(currentQuery), tokenizeForJaccard(prior.query));
    const jacNov = Number.isNaN(jacRaw) ? 1 : Math.max(0, Math.min(1, 1 - jacRaw));

    const cosRaw = cosine(currentEmbedding, prior.query_embedding);
    const cosNov = cosRaw === null ? null : Math.max(0, Math.min(1, 1 - cosRaw));

    const elapsed = Math.max(0, now - (prior.admitted_at || 0));
    const decay = timeDecayMs > 0 ? timeDecayMs : DEFAULT_TIME_DECAY_MS;
    const timeNov = Math.min(1, elapsed / decay);

    if (cosNov === null) {
        const fallbackJacWeight = JACCARD_WEIGHT + COSINE_WEIGHT;
        return (fallbackJacWeight * jacNov) + (TIME_WEIGHT * timeNov);
    }
    return (JACCARD_WEIGHT * jacNov) + (COSINE_WEIGHT * cosNov) + (TIME_WEIGHT * timeNov);
}

/**
 * Synthesize a turn_id when neither `req.turn_id` nor `opts.turnId` is
 * provided. Format: `"composer:<Date.now()>:<counter>"`. The counter
 * disambiguates calls landing in the same millisecond.
 *
 * @param {number} now
 * @returns {string}
 */
function synthesizeTurnId(now) {
    const c = _synthCounter++;
    return `composer:${now}:${c}`;
}

/**
 * Build the marker `ChunkRef` surrogate that replaces a suppressed
 * chunk in the kept list. See the module docstring for shape rationale
 * and the reserved-namespace note in `contracts.js`.
 *
 * @param {ChunkRef}        chunk      The suppressed candidate (for collection + content_type).
 * @param {AdmissionRecord} prior
 * @param {string}          turnId
 * @returns {ChunkRef}
 */
function buildMarker(chunk, prior, turnId) {
    const content = `[Already admitted: ${chunk.id} — see turn ${prior.turn_id}]`;
    return {
        id: `ledger_marker:${chunk.id}:${turnId}`,
        collection: chunk.collection,
        content,
        tokens: MARKER_TOKEN_COST,
        metadata: {
            source_uri: `ledger://${prior.turn_id}`,
            content_type: chunk.metadata.content_type,
            created_at: prior.admitted_at || 0,
            updated_at: prior.admitted_at || 0,
            content_hash: chunk.metadata.content_hash,
            structural: null,
            custom: { suppressed_chunk_id: chunk.id, prior_turn_id: prior.turn_id },
        },
        provenance: {
            source_uri: `ledger://${prior.turn_id}`,
            byte_range: null,
            line_range: null,
            retrieved_by: 'ledger_marker',
            score: 0,
            score_kind: 'structural_expanded',
        },
        embedding: null,
    };
}

/**
 * Append an `AdmissionRecord` for a kept chunk. The strategy field
 * mirrors `chunk.provenance.retrieved_by` — the strategy that produced
 * the chunk this turn — except for pinned chunks, which get
 * `strategy: "pinned"` regardless of provenance.
 *
 * @param {TaskLedger}             ledger
 * @param {ChunkRef}               chunk
 * @param {string|null|undefined}  query
 * @param {number[]|null|undefined} queryEmbedding
 * @param {string}                 turnId
 * @param {number}                 now
 * @param {boolean}                isPinned
 */
function appendAdmission(ledger, chunk, query, queryEmbedding, turnId, now, isPinned) {
    /** @type {AdmissionRecord} */
    const rec = {
        chunk_id: chunk.id,
        admitted_at: now,
        turn_id: turnId,
        tokens: Number(chunk.tokens) || 0,
        query: typeof query === 'string' && query.length > 0 ? query : null,
        query_embedding: Array.isArray(queryEmbedding) ? queryEmbedding : null,
        strategy: isPinned ? 'pinned' : (chunk.provenance && chunk.provenance.retrieved_by) || 'semantic',
        facets_covered: [],
    };
    // TODO(1.5.x): ledger capacity spill — when admissions.length === capacity,
    // older records should spill to compact form (drop query_embedding) per
    // js/profiles/task-ledger.js docstring. Owner's job, not the consumer's.
    ledger.admissions.push(rec);
}

/**
 * Append an `ExclusionRecord` for a suppressed chunk.
 *
 * @param {TaskLedger} ledger
 * @param {ChunkID}    chunkId
 * @param {string}     turnId
 * @param {number}     now
 */
function appendExclusion(ledger, chunkId, turnId, now) {
    /** @type {ExclusionRecord} */
    const rec = {
        chunk_id: chunkId,
        excluded_at: now,
        turn_id: turnId,
        reason: 'already_admitted_low_novelty',
        rule: 'ledger_consumer_v1',
    };
    ledger.exclusions.push(rec);
}

/**
 * Consult the task ledger and replace low-novelty re-admissions with
 * marker surrogates. See the module docstring for the full algorithm.
 *
 * @param {ChunkRef[]}        selected   Post-step-6 candidate set.
 * @param {RetrievalRequest}  req        Threaded for query, embedding, hints, pins, turn_id.
 * @param {TaskLedger}        ledger     Mutated as a side effect (admissions + exclusions).
 * @param {Object}           [opts]
 * @param {number}           [opts.now]                 Clock override (tests).
 * @param {string}           [opts.turnId]              Override `req.turn_id`.
 * @param {number[]}         [opts.queryEmbedding]      Optional current-query embedding for cosine novelty.
 * @param {number}           [opts.noveltyThreshold]    Override `DEFAULT_NOVELTY_THRESHOLD`.
 * @param {number}           [opts.timeDecayMs]         Override `DEFAULT_TIME_DECAY_MS`.
 * @returns {{ kept: ChunkRef[], suppressedCount: number, admittedCount: number, turnIdSynthesized: boolean, turnId: string }}
 */
export function consultLedger(selected, req, ledger, opts = {}) {
    if (!Array.isArray(selected)) {
        throw new TypeError('consultLedger: selected must be an array');
    }
    if (!req || typeof req !== 'object') {
        throw new TypeError('consultLedger: req must be a RetrievalRequest object');
    }
    if (!ledger || !Array.isArray(ledger.admissions) || !Array.isArray(ledger.exclusions)) {
        throw new TypeError('consultLedger: ledger must be a TaskLedger with admissions[] + exclusions[]');
    }

    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const threshold = typeof opts.noveltyThreshold === 'number' ? opts.noveltyThreshold : DEFAULT_NOVELTY_THRESHOLD;
    const timeDecayMs = typeof opts.timeDecayMs === 'number' && opts.timeDecayMs > 0 ? opts.timeDecayMs : DEFAULT_TIME_DECAY_MS;

    const explicitTurnId = (typeof opts.turnId === 'string' && opts.turnId.length > 0)
        ? opts.turnId
        : (typeof req.turn_id === 'string' && req.turn_id.length > 0 ? req.turn_id : null);
    const turnIdSynthesized = explicitTurnId === null;
    const turnId = explicitTurnId !== null ? explicitTurnId : synthesizeTurnId(now);

    /** @type {Set<ChunkID>} */
    const pinnedIds = new Set(Array.isArray(req.priority_pins) ? req.priority_pins : []);

    /** @type {ChunkRef[]} */
    const kept = [];
    let suppressedCount = 0;
    let admittedCount = 0;

    for (const chunk of selected) {
        if (!chunk || typeof chunk.id !== 'string') {
            kept.push(chunk);
            continue;
        }

        // Pinned: never suppress; record admission with strategy: "pinned".
        if (pinnedIds.has(chunk.id)) {
            appendAdmission(ledger, chunk, req.query, opts.queryEmbedding, turnId, now, true);
            admittedCount += 1;
            kept.push(chunk);
            continue;
        }

        const prior = _findMostRecentAdmission(ledger, chunk.id);

        if (prior === null) {
            // Cold candidate — admit and seed the ledger.
            appendAdmission(ledger, chunk, req.query, opts.queryEmbedding, turnId, now, false);
            admittedCount += 1;
            kept.push(chunk);
            continue;
        }

        const novelty = _computeNovelty({
            candidateId: chunk.id,
            currentQuery: req.query,
            currentEmbedding: opts.queryEmbedding,
            hints: req.strategy_hints,
            prior,
            now,
            timeDecayMs,
        });

        if (novelty >= threshold) {
            appendAdmission(ledger, chunk, req.query, opts.queryEmbedding, turnId, now, false);
            admittedCount += 1;
            kept.push(chunk);
        } else {
            appendExclusion(ledger, chunk.id, turnId, now);
            suppressedCount += 1;
            kept.push(buildMarker(chunk, prior, turnId));
        }
    }

    return { kept, suppressedCount, admittedCount, turnIdSynthesized, turnId };
}
