// @ts-check
/**
 * Cross-file query expander — pre-Composer pass that rewrites a single
 * user query into N codebase-aware identifier-vocabulary alternatives.
 * Where [`./query-paraphraser.js`](./query-paraphraser.js) (1.5.12) asks
 * the LLM for vocabulary-different paraphrases that preserve intent, the
 * expander asks for the *terms an engineer searching this corpus would
 * type* — `register_capability`, `RbacContext`, `effective_rules` —
 * surfacing identifier vocabulary that the BM25/semantic top-K is
 * keyword-matching on but that the user's natural-language phrasing
 * elides.
 *
 * Implements lever B from `docs/ROADMAP.md` §"AST Phase 2 lever B
 * (cross-file query expansion)" — measured viable in the 2026-05-07
 * probe (`[Unreleased]` → 1.8.1 in CHANGELOG), with a fusion-strategy
 * constraint: production cannot uniformly RRF `baseline + alts` because
 * the baseline ranking is *exactly* the noisy candidate pool we're
 * trying to escape. The Composer enforces the constraint by setting
 * `req.query_variants = variants` (no `req.query` prepend) when the
 * expander is wired — distinct from the paraphrase wiring which
 * prepends `req.query` to keep the original ranking in the fusion pool.
 *
 * **Same DI shape as `createQueryParaphraser`.** Pure function seam,
 * locked default prompt, three-way settings dispatch through
 * `buildExpanderFromSettings`. Failure mode — `chatFn` throws / returns
 * non-string / returns content the parser rejects — degrades to `[]`
 * (no alts), and the Composer falls back to single-variant baseline.
 *
 * **Why a separate module from the paraphraser?** Both are pre-Composer
 * query rewriters with the same DI shape, and the temptation to
 * generalize one over both is real. We keep them separate because:
 *   1. The default prompts diverge meaningfully — "preserve intent
 *      with different vocabulary" is a different request from "emit
 *      identifier-vocabulary alts an engineer would type." Locking
 *      both prompts in distinct modules surfaces the divergence in
 *      review.
 *   2. The Composer treats the two outputs differently — paraphrase
 *      prepends `req.query`, expansion does not. The wiring divergence
 *      is easier to keep correct when the modules are distinct.
 *   3. The settings UI exposes them as mutually exclusive levers; a
 *      single combined module would invite a single combined setting,
 *      which the probe explicitly avoided.
 *
 * @module intelligence/retrieval/query-expander
 */

/**
 * @typedef {Object} ChatMessage
 * @property {"system"|"user"|"assistant"} role
 * @property {string} content
 */

/**
 * Caller-supplied chat-completion seam. Same shape as the paraphraser's
 * `ChatFn` (production wires through `LLM.chat` either way) — kept as a
 * separate typedef so the module is self-contained and node tests don't
 * import from the paraphraser.
 *
 * @typedef {(messages: ChatMessage[], options: { model: string, temperature: number, maxTokens?: number }) => Promise<string>} ChatFn
 */

/**
 * @typedef {Object} ExpanderCache
 * @property {(key: string) => (string[]|null) | Promise<string[]|null>} get
 * @property {(key: string, value: string[]) => void | Promise<void>} set
 * @property {() => number | Promise<number>} size
 */

/**
 * @typedef {Object} QueryExpander
 * @property {(query: string) => Promise<string[]>} expand
 * @property {() => { hits: number, misses: number, failures: number }} stats
 */

/**
 * Settings subtree shape consumed by `buildExpanderFromSettings`. Pins
 * the contract so the helper rejects malformed inputs cleanly.
 *
 * @typedef {Object} ExpansionSettings
 * @property {string} llmModel                                                                                         Primary chat model (used when mode === 'primary').
 * @property {{ crossFileExpansionMode: 'off'|'primary'|'utility', crossFileExpanderModelId: string, crossFileExpanderRounds: number, crossFileExpanderTemperature: number }} retrieval
 */

/**
 * Locked corpus-agnostic default prompt. The 1.8.1 PR pins this string
 * verbatim and CHANGELOG records it. Changing this string in any
 * downstream patch must be paired with a same-branch re-measurement
 * against `tests/run-polyglot-benchmark.mjs` so the lift number stays
 * meaningful.
 *
 * The prompt deliberately:
 *   - Names no project, file, or codebase concept — the lever is
 *     general-purpose, and metric tilt would only show up against the
 *     specific fixtures that motivated the lever.
 *   - Asks for *identifier-vocabulary* alts, not paraphrase. This is
 *     the divergence from the paraphraser. The model is told what an
 *     engineer would *type into a code search box* — symbol names,
 *     class/struct names, function-style suffixes — rather than what
 *     the user *meant*.
 *   - Forbids invented specifics — keeps weak models from
 *     hallucinating identifiers that don't exist in the codebase.
 *   - Asks for one alt per line, no numbering, no commentary — keeps
 *     the parser simple.
 */
export const DEFAULT_EXPAND_PROMPT =
    'You are a code-search assistant. Given a user\'s natural-language code-search ' +
    'query, produce N alternative search queries that an engineer would type into a ' +
    'code-search box for the same goal — favoring concrete identifier vocabulary ' +
    '(function names, class names, type names, common API verbs) over natural ' +
    'language. Output one alternative per line, no numbering, no commentary. Do not ' +
    'invent identifiers not implied by the query.';

/**
 * Default rounds — three alts plus the baseline gives the Composer a
 * candidate pool large enough for RRF-over-alts-only to surface
 * cross-variant agreement signal, while keeping LLM cost per
 * `find_relevant_files` call bounded. The probe used three hand-curated
 * alts per fixture and the production code mirrors that depth.
 */
export const DEFAULT_EXPAND_ROUNDS = 3;

/**
 * Default temperature. Zero is deterministic — required for
 * reproducible benchmark runs. Users opting into expansion in
 * production can raise it via Settings → Retrieval.
 */
export const DEFAULT_EXPAND_TEMPERATURE = 0;

/**
 * FNV-1a 32-bit hash → 8 hex chars. Inlined (rather than shared with
 * the paraphraser) to keep the module self-contained — the paraphraser
 * has the same helper for the same reason; cross-module function reuse
 * would create a circular-import risk through `index.js`.
 *
 * @param {string} s
 * @returns {string}
 */
function fnv1a8(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * @param {string} modelId
 * @param {string} query
 * @param {string} prompt
 * @returns {string}
 */
function cacheKey(modelId, query, prompt) {
    return `${modelId}::${fnv1a8(query)}::${fnv1a8(prompt)}`;
}

/**
 * @returns {ExpanderCache}
 */
function defaultMemoryCache() {
    /** @type {Map<string, string[]>} */
    const m = new Map();
    return {
        get(key) {
            return m.has(key) ? /** @type {string[]} */ (m.get(key)) : null;
        },
        set(key, value) {
            m.set(key, value);
        },
        size() {
            return m.size;
        },
    };
}

/**
 * Parse the LLM's raw response into alt queries. Same parser shape as
 * the paraphraser: strip numbering / bullets / blank lines, drop a line
 * that exactly echoes the original query, cap at `maxRounds`.
 *
 * @param {string} raw
 * @param {string} originalQuery
 * @param {number} maxRounds
 * @returns {string[]}
 */
function parseExpandResponse(raw, originalQuery, maxRounds) {
    if (typeof raw !== 'string') return [];
    const lines = raw.split(/\r?\n/);
    const out = [];
    const lowerOriginal = originalQuery.trim().toLowerCase();
    for (const line of lines) {
        let s = line.trim();
        if (s.length === 0) continue;
        s = s.replace(/^(?:\d+[.)]|[-*•])\s+/, '');
        if (s.length === 0) continue;
        if (s.toLowerCase() === lowerOriginal) continue;
        out.push(s);
        if (out.length >= maxRounds) break;
    }
    return out;
}

/**
 * @param {string} prompt
 * @param {string} query
 * @param {number} rounds
 * @returns {ChatMessage[]}
 */
function buildMessages(prompt, query, rounds) {
    const promptResolved = prompt.replace(/\bN\b/, String(rounds));
    return [
        {
            role: 'user',
            content: `${promptResolved}\n\nQuery: ${query}`,
        },
    ];
}

/**
 * Construct a `QueryExpander`. Pure DI — no `core.js` / `LLM.chat`
 * import here.
 *
 * @param {Object} options
 * @param {ChatFn} options.chatFn                Caller-supplied chat-completion seam.
 * @param {string} options.modelId               Model id threaded into `chatFn` options.
 * @param {number} [options.rounds]              Number of alts to request. Default 3.
 * @param {number} [options.temperature]         LLM temperature. Default 0 (deterministic).
 * @param {string} [options.prompt]              Override the locked default prompt. Default = `DEFAULT_EXPAND_PROMPT`.
 * @param {ExpanderCache} [options.cache]        Optional injected cache. Omit to share an in-memory cache scoped to this expander instance.
 * @returns {QueryExpander}
 */
export function createQueryExpander(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createQueryExpander: options must be an object');
    }
    const { chatFn, modelId, rounds, temperature, prompt, cache } = options;
    if (typeof chatFn !== 'function') {
        throw new TypeError('createQueryExpander: chatFn must be a function');
    }
    if (typeof modelId !== 'string' || modelId.length === 0) {
        throw new TypeError('createQueryExpander: modelId must be a non-empty string');
    }
    const r = rounds === undefined ? DEFAULT_EXPAND_ROUNDS : rounds;
    if (!Number.isFinite(r) || r < 1 || r > 5) {
        throw new TypeError('createQueryExpander: rounds must be a number 1-5');
    }
    const t = temperature === undefined ? DEFAULT_EXPAND_TEMPERATURE : temperature;
    if (!Number.isFinite(t) || t < 0 || t > 2) {
        throw new TypeError('createQueryExpander: temperature must be a number 0-2');
    }
    const promptResolved = (typeof prompt === 'string' && prompt.length > 0)
        ? prompt
        : DEFAULT_EXPAND_PROMPT;
    if (cache !== undefined && (
        !cache
        || typeof cache.get !== 'function'
        || typeof cache.set !== 'function'
        || typeof cache.size !== 'function'
    )) {
        throw new TypeError('createQueryExpander: cache must satisfy { get, set, size }');
    }
    const resolvedCache = cache ?? defaultMemoryCache();

    let hits = 0;
    let misses = 0;
    let failures = 0;

    /**
     * @param {string} query
     * @returns {Promise<string[]>}
     */
    async function expand(query) {
        if (typeof query !== 'string' || query.trim().length === 0) {
            return [];
        }
        const trimmed = query.trim();
        const key = cacheKey(modelId, trimmed, promptResolved);
        const cached = await resolvedCache.get(key);
        if (cached) {
            hits += 1;
            return cached.slice();
        }
        misses += 1;
        let raw;
        try {
            raw = await chatFn(buildMessages(promptResolved, trimmed, r), {
                model: modelId,
                temperature: t,
            });
        } catch (_err) {
            failures += 1;
            return [];
        }
        const parsed = parseExpandResponse(raw, trimmed, r);
        if (parsed.length === 0) {
            failures += 1;
            return [];
        }
        await resolvedCache.set(key, parsed);
        return parsed.slice();
    }

    function stats() {
        return { hits, misses, failures };
    }

    return { expand, stats };
}

/**
 * Resolve a `QueryExpander` from the user's settings + a chat seam.
 * Three-way mode dispatch — same posture as `buildParaphraserFromSettings`:
 *
 *   - `'off'` (default) → returns `null`. The Composer receives no
 *     expander and runs the existing single-variant or paraphrase
 *     paths.
 *   - `'primary'` → wires `modelId = settings.llmModel`. Reuses the
 *     user's configured chat model.
 *   - `'utility'` → wires `modelId = settings.retrieval.crossFileExpanderModelId`
 *     when non-empty; falls back to `null` (defensive — user enabled
 *     utility mode but left the model id blank).
 *
 * @param {ExpansionSettings} settings
 * @param {Object} deps
 * @param {ChatFn} deps.chatFn                  Required.
 * @param {ExpanderCache} [deps.cache]
 * @returns {QueryExpander|null}
 */
export function buildExpanderFromSettings(settings, deps) {
    if (!settings || typeof settings !== 'object') return null;
    if (!deps || typeof deps.chatFn !== 'function') return null;
    const retrieval = /** @type {any} */ (settings).retrieval;
    if (!retrieval || typeof retrieval !== 'object') return null;
    const mode = retrieval.crossFileExpansionMode;
    if (mode !== 'primary' && mode !== 'utility') return null;
    let modelId;
    if (mode === 'primary') {
        modelId = /** @type {any} */ (settings).llmModel;
    } else {
        modelId = retrieval.crossFileExpanderModelId;
    }
    if (typeof modelId !== 'string' || modelId.length === 0) return null;
    const rounds = Number.isFinite(retrieval.crossFileExpanderRounds)
        ? retrieval.crossFileExpanderRounds
        : DEFAULT_EXPAND_ROUNDS;
    const temperature = Number.isFinite(retrieval.crossFileExpanderTemperature)
        ? retrieval.crossFileExpanderTemperature
        : DEFAULT_EXPAND_TEMPERATURE;
    return createQueryExpander({
        chatFn: deps.chatFn,
        modelId,
        rounds,
        temperature,
        cache: deps.cache,
    });
}
