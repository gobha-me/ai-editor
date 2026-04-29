// @ts-check
/**
 * Compactor — runs the compression rule pipeline per
 * `docs/DESIGN-compression.md` §"Pipeline Algorithm".
 *
 * Single public entry point: `compress(req)`. The function is async to
 * accommodate the optional summarizer (Rule 5); when no summarizer fires
 * the call resolves on the same microtask as the inputs.
 *
 * Pipeline order (from DESIGN, Phase 1 implements 1, 2, 3, 5):
 *   1. Sort rules by priority (lowest first).
 *   2. Per-turn evaluation: for each non-preserve_recent turn, apply
 *      eviction rules (skipping summarizer rules). First non-Keep wins.
 *   3. Apply Drop / Replace decisions.
 *   4. (Phase 2) Resolution-rule cross-turn span collapse.
 *   5. Budget check: while over budget AND a summarizer is provided,
 *      summarize the oldest non-preserve_recent span.
 *   6. Final budget check: if still over, drop oldest until under.
 *
 * **preserve_recent** is the load-bearing invariant per DESIGN §"Core
 * Contracts". The most recent N turns are NEVER evicted, regardless of
 * what rules say. Prevents the most embarrassing failure mode
 * (compressing the user's most recent message because some rule
 * misfired).
 *
 * **Failure modes** per DESIGN §"Failure Modes":
 *   - Rule throws → skip rule for that turn; default Keep; record in
 *     `diagnostics.rule_errors`.
 *   - Two rules disagree → lower-priority rule wins (first match).
 *   - Summarizer fails → fall back to dropping oldest; warn.
 *   - preserve_recent exceeds budget → warn, return as-is.
 *   - Turn missing required metadata → rule returns Keep; counted in
 *     `diagnostics.rules_skipped` (post-pass).
 *
 * @module intelligence/compression/compactor
 */

import { Keep, isKeep, isDrop, isReplace } from './decisions.js';
import { sumTokens } from './tokens.js';
import { makeSynthesizedTurn } from './turn-store.js';

/**
 * @typedef {import('./contracts.js').Turn}                Turn
 * @typedef {import('./contracts.js').Decision}            Decision
 * @typedef {import('./contracts.js').CompressionRule}     CompressionRule
 * @typedef {import('./contracts.js').CompressionRequest}  CompressionRequest
 * @typedef {import('./contracts.js').CompressionResult}   CompressionResult
 * @typedef {import('./contracts.js').Diagnostics}         Diagnostics
 * @typedef {import('./contracts.js').SummarizedSpan}      SummarizedSpan
 * @typedef {import('./contracts.js').SummarizerFn}        SummarizerFn
 */

/**
 * Default minimum span length the Rule-5 summarizer will accept. Smaller
 * spans aren't worth a summarizer call; better to drop the oldest turn
 * outright in the final budget check.
 */
const MIN_SUMMARIZE_SPAN = 2;

/**
 * Default chunk size for the Rule-5 sweep. Each summarizer iteration
 * pulls this many oldest non-preserve turns into one summary turn.
 */
const SUMMARIZE_CHUNK_SIZE = 10;

/** Now-in-ms shim — `performance.now()` if available, else `Date.now()`. */
const _now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? () => performance.now()
    : () => Date.now();

/**
 * @returns {Diagnostics}
 */
function emptyDiagnostics() {
    return {
        rules_run: [],
        rules_skipped: [],
        decisions_by_rule: {},
        evicted_ids: [],
        replaced_ids: [],
        summarized_spans: [],
        tokens_in: 0,
        tokens_out: 0,
        compression_ratio: 1,
        warnings: [],
        rule_errors: [],
        latency_per_rule_ms: {},
        summarizer_latency_ms: 0,
    };
}

/**
 * Tally a decision under the per-rule decision counter.
 * @param {Diagnostics} diag
 * @param {string}      ruleName
 * @param {Decision}    dec
 */
function tally(diag, ruleName, dec) {
    const t = diag.decisions_by_rule[ruleName] = diag.decisions_by_rule[ruleName] || {
        keep: 0, drop: 0, replace: 0, summarize: 0,
    };
    if (dec.kind === 'keep') t.keep++;
    else if (dec.kind === 'drop') t.drop++;
    else if (dec.kind === 'replace') t.replace++;
    else if (dec.kind === 'summarize') t.summarize++;
}

/**
 * Tool-pair coherence pass.
 *
 * The LLM API requires every assistant `tool_calls[i].id` to be matched
 * by a subsequent `tool` message with the same `tool_call_id`. If
 * Rules 1 or 2 drop a tool_result without its matching tool_call also
 * being dropped, the API returns 400.
 *
 * Phase 1 strategy: keep the eviction *atomic at the assistant-turn
 * level*. After the per-turn rule pass produces verdicts, this function:
 *
 *   - For each tool_result turn marked Drop, find the assistant turn
 *     that owns its `tool_call_id` (via assistant.metadata.tool_call_ids).
 *   - If ALL of that assistant's tool_call_ids resolve to tool_results
 *     marked Drop → the assistant turn also flips to Drop with reason
 *     `"orphan:all_tool_results_evicted"`.
 *   - If only SOME of them are marked Drop → the partial drops on
 *     tool_results revert to Keep (we don't ship a partial-tool_calls
 *     mutation in Phase 1; safer to keep the pair than to risk a 400).
 *
 * Tool_call_id mismatches (an evicted tool_result whose caller was
 * already evicted by some other rule, or whose caller can't be found
 * in history) drop cleanly.
 *
 * @param {Map<string, {rule: string, decision: Decision}>} verdicts
 * @param {Turn[]}     history
 * @param {Diagnostics} diag
 */
function applyToolPairCoherence(verdicts, history, diag) {
    for (const caller of history) {
        if (!caller || caller.role !== 'assistant') continue;
        const expectedIds = caller.metadata && caller.metadata.tool_call_ids;
        if (!Array.isArray(expectedIds) || expectedIds.length === 0) continue;

        // Per-call-id coverage: does at least one tool_result with this
        // id survive? Track which tool_result turns were Drop'd so we
        // can revert the partial-uncovered ones.
        /** @type {Map<string, {hasKept: boolean, droppedTurns: Turn[]}>} */
        const coverage = new Map();
        for (const id of expectedIds) {
            if (typeof id === 'string') coverage.set(id, { hasKept: false, droppedTurns: [] });
        }
        for (const t of history) {
            if (!t || t.role !== 'tool_result') continue;
            const callId = t.metadata && t.metadata.tool_call_id;
            if (!coverage.has(callId)) continue;
            const v = verdicts.get(t.id);
            const cov = coverage.get(callId);
            if (!v || isKeep(v.decision)) {
                cov.hasKept = true;
            } else if (isDrop(v.decision)) {
                cov.droppedTurns.push(t);
            }
        }

        let allUncovered = true;
        let anyUncovered = false;
        /** @type {Turn[]} */
        const partialUncoveredDrops = [];
        for (const cov of coverage.values()) {
            if (cov.hasKept) {
                allUncovered = false;
            } else {
                anyUncovered = true;
                partialUncoveredDrops.push(...cov.droppedTurns);
            }
        }

        if (allUncovered) {
            // Every call_id this assistant issued has its result evicted.
            // Drop the assistant too — keeping it would orphan all its
            // tool_calls. Override even Keep verdicts (e.g. from
            // preserve_recent) because dangling tool_calls 400 the API.
            const reason = `orphan:all_${coverage.size}_tool_results_evicted`;
            verdicts.set(caller.id, {
                rule: 'tool_pair_coherence',
                decision: { kind: 'drop', reason },
            });
            diag.evicted_ids.push({ id: caller.id, rule: 'tool_pair_coherence', reason });
        } else if (anyUncovered) {
            // Some call_ids would dangle. Revert the eviction on each
            // tool_result whose call_id has no surviving result. Costs
            // us those token savings; safer than a 400.
            for (const t of partialUncoveredDrops) {
                verdicts.set(t.id, { rule: '__coherence_revert__', decision: Keep() });
                const idx = diag.evicted_ids.findIndex(e => e.id === t.id);
                if (idx >= 0) diag.evicted_ids.splice(idx, 1);
            }
            diag.warnings.push(
                `tool_pair_coherence_revert:${caller.id}:${partialUncoveredDrops.length}_uncovered_of_${coverage.size}`
            );
        }
        // else: every call_id has at least one kept result; no action needed.
    }
}

/**
 * Post-pass — count tool_result turns that lacked the metadata each
 * file-ops rule needs. Surfaces the `rules_skipped` diagnostic that lets
 * the LLM debug modal distinguish "no rule applied" from "rule skipped
 * because metadata absent" (per ROADMAP §1.2.0 exit criteria).
 *
 * @param {Diagnostics} diag
 * @param {Turn[]}      history
 * @param {CompressionRule[]} rules
 */
function recordSkippedDueToMissingMetadata(diag, history, rules) {
    let toolResultsWithoutFileOps = 0;
    for (const t of history) {
        if (t && t.role === 'tool_result') {
            const ops = t.metadata && t.metadata.file_ops;
            if (!Array.isArray(ops) || ops.length === 0) toolResultsWithoutFileOps++;
        }
    }
    if (toolResultsWithoutFileOps === 0) return;

    for (const r of rules) {
        if (r.is_summarizer) continue;
        if (r.name === 'subsumption' || r.name === 'invalidation') {
            diag.rules_skipped.push({
                rule: r.name,
                reason: 'file_ops_empty',
                count: toolResultsWithoutFileOps,
            });
        }
    }
}

/**
 * Pick the oldest contiguous non-preserve_recent block from `surviving`
 * to feed Rule 5. Phase 1 takes a fixed chunk of `SUMMARIZE_CHUNK_SIZE`
 * (or fewer if not enough turns are eligible). Returns `null` when
 * nothing summarizable remains.
 *
 * Constraint per DESIGN §Rule 5: never summarize a chunk in the middle
 * of history if the chunk before it survived. We always start at index
 * 0 of the eligible region.
 *
 * @param {Turn[]} surviving
 * @param {number} preserveRecent
 * @returns {Turn[]|null}
 */
function selectOldestSummarizableSpan(surviving, preserveRecent) {
    const eligibleEnd = surviving.length - Math.max(0, preserveRecent);
    if (eligibleEnd <= 0) return null;
    const span = surviving.slice(0, Math.min(SUMMARIZE_CHUNK_SIZE, eligibleEnd));
    if (span.length < MIN_SUMMARIZE_SPAN) return null;
    return span;
}

/**
 * Replace the oldest `span` in `surviving` with a single summary turn.
 *
 * @param {Turn[]} surviving
 * @param {Turn[]} span
 * @param {Turn}   summaryTurn
 * @returns {Turn[]}
 */
function replaceSpan(surviving, span, summaryTurn) {
    return [summaryTurn, ...surviving.slice(span.length)];
}

/**
 * Drop oldest non-preserve turns until the total token count is under
 * budget. Final fallback after summarization.
 *
 * @param {Turn[]} surviving
 * @param {number} budgetTokens
 * @param {number} preserveRecent
 * @returns {Turn[]}
 */
function dropOldestUntilUnderBudget(surviving, budgetTokens, preserveRecent) {
    const out = surviving.slice();
    const minLength = Math.max(0, preserveRecent);
    while (sumTokens(out) > budgetTokens && out.length > minLength) {
        out.shift();
    }
    return out;
}

/**
 * Run the compression pipeline.
 *
 * @param {CompressionRequest} req
 * @returns {Promise<CompressionResult>}
 */
export async function compress(req) {
    if (!req || typeof req !== 'object') {
        throw new TypeError('compress: req must be an object');
    }
    if (!Array.isArray(req.history)) {
        throw new TypeError('compress: req.history must be an array');
    }

    const diagnostics = emptyDiagnostics();
    const history = req.history;
    diagnostics.tokens_in = sumTokens(history);

    // Empty / single-turn history is a no-op.
    if (history.length === 0) {
        return {
            history: [],
            diagnostics,
            evicted_ids: [],
            surviving_ids: [],
            summarized_spans: [],
        };
    }

    const rules = (Array.isArray(req.rules) ? req.rules.slice() : [])
        .sort((a, b) => (a.priority || 0) - (b.priority || 0));
    diagnostics.rules_run = rules.map(r => r.name);

    const preserveRecent = Math.max(0, Math.floor(req.preserve_recent || 0));
    const preserveStart = history.length - preserveRecent;

    // Step 2: Per-turn evaluation.
    /** @type {Map<string, {rule: string, decision: Decision}>} */
    const verdicts = new Map();

    for (let i = 0; i < history.length; i++) {
        const turn = history[i];

        // preserve_recent invariant — always Keep.
        if (i >= preserveStart) {
            verdicts.set(turn.id, { rule: '__preserve_recent__', decision: Keep() });
            continue;
        }

        let chosen = null;
        for (const rule of rules) {
            if (rule.is_summarizer) continue;

            const ruleStart = _now();
            let dec;
            try {
                dec = rule.evaluate(turn, history);
            } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                diagnostics.rule_errors.push({ rule: rule.name, error: msg });
                dec = Keep();
            }
            diagnostics.latency_per_rule_ms[rule.name] =
                (diagnostics.latency_per_rule_ms[rule.name] || 0) + (_now() - ruleStart);

            tally(diagnostics, rule.name, dec);

            if (!isKeep(dec)) {
                chosen = { rule: rule.name, decision: dec };
                break;
            }
        }

        if (chosen) {
            verdicts.set(turn.id, chosen);
            if (isDrop(chosen.decision)) {
                diagnostics.evicted_ids.push({
                    id: turn.id,
                    rule: chosen.rule,
                    reason: chosen.decision.reason,
                });
            } else if (isReplace(chosen.decision)) {
                diagnostics.replaced_ids.push({
                    id: turn.id,
                    rule: chosen.rule,
                    reason: chosen.decision.reason,
                    marker: chosen.decision.marker,
                });
            }
        } else {
            verdicts.set(turn.id, { rule: '__default__', decision: Keep() });
        }
    }

    // Step 2.5: Tool-pair coherence — keep evictions atomic at the
    // assistant-turn level so we never orphan a tool_call.
    applyToolPairCoherence(verdicts, history, diagnostics);

    // Step 3: Apply Drop / Replace / Keep.
    let surviving = [];
    for (const turn of history) {
        const v = verdicts.get(turn.id);
        if (!v || isKeep(v.decision)) {
            surviving.push(turn);
        } else if (isReplace(v.decision)) {
            surviving.push(makeSynthesizedTurn(
                v.decision.marker,
                v.decision.reason,
                turn.timestamp
            ));
        }
        // Drop: skip
    }

    // Record metadata-skipped counts for the file-ops rules.
    recordSkippedDueToMissingMetadata(diagnostics, history, rules);

    // Step 5: Budget check + Rule-5 summarizer fallback.
    const budget = typeof req.budget_tokens === 'number' && req.budget_tokens > 0
        ? req.budget_tokens
        : Infinity;
    const summarizerProvided = typeof req.summarizer === 'function';

    if (summarizerProvided) {
        // Cap iterations to avoid pathological loops if summarizer
        // outputs are larger than the spans they replace.
        let safetyIters = 50;
        while (sumTokens(surviving) > budget && safetyIters-- > 0) {
            const span = selectOldestSummarizableSpan(surviving, preserveRecent);
            if (!span) break;

            const sumStart = _now();
            let summaryTurn;
            try {
                summaryTurn = await req.summarizer(span);
            } catch (err) {
                const msg = err && err.message ? err.message : String(err);
                diagnostics.warnings.push(`summarizer_failed:${msg}`);
                break;
            }
            diagnostics.summarizer_latency_ms += (_now() - sumStart);

            if (!summaryTurn || typeof summaryTurn !== 'object' || typeof summaryTurn.tokens !== 'number') {
                diagnostics.warnings.push('summarizer_malformed_output');
                break;
            }

            diagnostics.summarized_spans.push({
                first_id: span[0].id,
                last_id: span[span.length - 1].id,
                span_length: span.length,
                latency_ms: diagnostics.summarizer_latency_ms,
            });

            surviving = replaceSpan(surviving, span, summaryTurn);
        }
        if (safetyIters <= 0) {
            diagnostics.warnings.push('summarizer_iteration_cap_hit');
        }
    }

    // Step 6: Final budget check — drop oldest outright.
    if (sumTokens(surviving) > budget) {
        const before = surviving.length;
        surviving = dropOldestUntilUnderBudget(surviving, budget, preserveRecent);
        if (surviving.length < before) {
            diagnostics.warnings.push(
                summarizerProvided
                    ? 'budget_exceeded_after_summarization'
                    : 'budget_exceeded_no_summarizer'
            );
        }
        if (sumTokens(surviving) > budget) {
            // We hit preserve_recent floor; can't drop further.
            diagnostics.warnings.push('preserve_recent_exceeds_budget');
        }
    }

    diagnostics.tokens_out = sumTokens(surviving);
    diagnostics.compression_ratio = diagnostics.tokens_in === 0
        ? 1
        : diagnostics.tokens_out / diagnostics.tokens_in;

    return {
        history: surviving,
        diagnostics,
        evicted_ids: diagnostics.evicted_ids.map(e => e.id),
        surviving_ids: surviving.map(t => t.id),
        summarized_spans: diagnostics.summarized_spans,
    };
}

/** Object form for ergonomic imports. */
export const Compactor = { compress };
