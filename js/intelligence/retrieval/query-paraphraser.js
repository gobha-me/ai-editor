// @ts-check
/**
 * Query paraphraser — pre-Composer pass that expands a single query into N
 * alternative phrasings via an LLM, so the Semantic strategy's k-NN can
 * union per-variant rankings with RRF (the multi-variant path in
 * [`./strategies/semantic.js`](./strategies/semantic.js)).
 *
 * Implements lever (b) from `docs/ROADMAP.md` §"Open question" — query
 * rewriting at the Composer entry. Lives in production code rather than the
 * measurement harness so the same code path runs in benchmark and real
 * `find_relevant_files` calls.
 *
 * **Three constraints from PR scoping:**
 *
 *   1. Pure DI. `chatFn` is caller-supplied. The module imports nothing
 *      from `js/llm/api.js` or `core.js` so node tests stay browser-free
 *      (mirrors the `embedQuery` posture in
 *      [`semantic.js`](./strategies/semantic.js)).
 *   2. Three-way user-controlled mode. The companion
 *      `buildParaphraserFromSettings` consults
 *      `settings.retrieval.paraphraseMode ∈ {'off','primary','utility'}`
 *      and returns either a wired `QueryParaphraser` or `null`. `'off'` is
 *      the default — every user upgrading to 1.5.12 sees zero behavior
 *      change until they explicitly opt in.
 *   3. Locked corpus-agnostic prompt. The default prompt makes no
 *      reference to ai-editor concepts, file paths, or known fixture
 *      names — it asks for vocabulary-different paraphrases that
 *      preserve intent. Caller may override for ad-hoc experimentation
 *      but the default is the CHANGELOG-recorded one.
 *
 * **Failure mode.** Any path that can't produce paraphrases — `chatFn`
 * throws, returns a non-string, returns an empty string, or returns
 * content the parser rejects — degrades to `[]` (no paraphrases). The
 * Composer's caller treats `[]` as the single-variant path, which is the
 * existing behavior. The module never throws on operational failures;
 * argument-validation errors at construction time still throw `TypeError`.
 *
 * @module intelligence/retrieval/query-paraphraser
 */

/**
 * @typedef {Object} ChatMessage
 * @property {"system"|"user"|"assistant"} role
 * @property {string} content
 */

/**
 * Caller-supplied chat-completion seam. Shape mirrors what
 * `js/llm/api.js` `LLM.chat` exposes — production callers wire
 * `(messages, opts) => LLM.chat(messages, opts).then(r => r.content)`;
 * tests inject a deterministic fake. Returns the raw assistant text;
 * the paraphraser parses it line-by-line.
 *
 * The shape stays minimal on purpose: `model`, `temperature`, `maxTokens`
 * are the only options the paraphraser ever sets. Future knobs (retries,
 * timeouts, system-prompt threading) belong in the caller's `chatFn`
 * implementation, not this module.
 *
 * @typedef {(messages: ChatMessage[], options: { model: string, temperature: number, maxTokens?: number }) => Promise<string>} ChatFn
 */

/**
 * Cache shape for paraphrase results. Mirrors `EmbedderCache` from
 * [`./embedder.js`](./embedder.js): `get` returns the stored array (or
 * null), `set` stores it, `size` reports the count. Keys are opaque
 * strings the paraphraser computes from `(modelId, query, prompt)` —
 * callers should not interpret them.
 *
 * `get` / `set` / `size` may be sync (returning the value directly) or
 * async (returning a Promise). The paraphraser awaits them either way,
 * so an in-memory `Map`-backed cache and an IDB-backed cache can both
 * satisfy this contract.
 *
 * @typedef {Object} ParaphraseCache
 * @property {(key: string) => (string[]|null) | Promise<string[]|null>} get
 * @property {(key: string, value: string[]) => void | Promise<void>} set
 * @property {() => number | Promise<number>} size
 */

/**
 * Paraphraser handle. Stateless across `paraphrase` calls except for the
 * cache (when supplied) and the per-instance stats counters.
 *
 * @typedef {Object} QueryParaphraser
 * @property {(query: string) => Promise<string[]>} paraphrase
 * @property {() => { hits: number, misses: number, failures: number }} stats
 */

/**
 * Settings subtree shape consumed by `buildParaphraserFromSettings`.
 * Mirrors the `State.settings.retrieval.*` defaults defined in
 * `js/core.js` — this typedef pins the contract the helper expects.
 *
 * @typedef {Object} ParaphraseSettings
 * @property {string} llmModel                                   Primary chat model (used when mode === 'primary').
 * @property {{ paraphraseMode: 'off'|'primary'|'utility', paraphraseModelId: string, paraphraseRounds: number, paraphraseTemperature: number }} retrieval
 */

/**
 * Locked corpus-agnostic default prompt. The PR pins this string verbatim
 * and the CHANGELOG records it. Changing this string in any downstream
 * patch must be paired with a same-branch T8 re-measurement so the
 * baseline number stays meaningful.
 *
 * The prompt deliberately:
 *   - Names no project, file, or codebase concept — would be metric-tilting.
 *   - Forbids invented specifics — keeps weak models from hallucinating
 *     unrelated terms that pull in irrelevant chunks.
 *   - Asks for one paraphrase per line, no numbering, no commentary —
 *     keeps the parser simple and lets weaker models comply reliably.
 */
export const DEFAULT_PARAPHRASE_PROMPT =
    'You are a search-query reformulator. Given a user\'s code-search query, ' +
    'produce N alternative phrasings that preserve the original intent but use ' +
    'different vocabulary. Output one paraphrase per line, no numbering, no ' +
    'commentary. Do not invent specifics not implied by the query.';

/**
 * Default rounds — matches the plan's choice. Two paraphrases plus the
 * original gives three rankings to RRF over, which is enough to surface
 * cross-variant agreement signal without paying for many LLM calls.
 */
export const DEFAULT_PARAPHRASE_ROUNDS = 2;

/**
 * Default temperature. Zero is deterministic — required for reproducible
 * measurement runs. Users opting into paraphrasing in production can
 * raise it via Settings → Retrieval.
 */
export const DEFAULT_PARAPHRASE_TEMPERATURE = 0;

/**
 * FNV-1a 32-bit hash → 8 hex chars. Inlined here rather than imported
 * from `chunk-id.js` (private module) or `loader.js` (also private)
 * because the cache key only needs uniqueness, not cryptographic strength.
 * The 8-char output keeps cache keys short for `Map` lookups.
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
 * Compose a cache key. Three components:
 *   - `modelId` — model swap invalidates (different model, different
 *     paraphrase quality, no cross-pollination).
 *   - hashed `query` — different query, different paraphrases.
 *   - hashed `prompt` — caller-supplied prompt swap invalidates.
 *
 * Hashing the long components keeps the key small without sacrificing
 * uniqueness in practice.
 *
 * @param {string} modelId
 * @param {string} query
 * @param {string} prompt
 * @returns {string}
 */
function cacheKey(modelId, query, prompt) {
    return `${modelId}::${fnv1a8(query)}::${fnv1a8(prompt)}`;
}

/**
 * Default in-memory cache backing `createQueryParaphraser({ cache })`
 * when the caller supplies `cache: 'default'` (or omits and the
 * paraphraser wants one anyway). Kept private to the module — callers
 * that need an external cache (IDB, shared across instances) supply
 * their own conformant implementation.
 *
 * @returns {ParaphraseCache}
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
 * Parse the LLM's raw response into paraphrases. Strips numbering,
 * bullets, leading/trailing whitespace, and empty lines. Drops lines
 * that exactly match the original query (defensive — if the model
 * echoes the query back as a "paraphrase", we don't want it counted).
 *
 * Limits output to `maxRounds` paraphrases — a verbose model that
 * returns 7 lines when we asked for 2 should not flood RRF with
 * extra rankings.
 *
 * @param {string} raw
 * @param {string} originalQuery
 * @param {number} maxRounds
 * @returns {string[]}
 */
function parseParaphraseResponse(raw, originalQuery, maxRounds) {
    if (typeof raw !== 'string') return [];
    const lines = raw.split(/\r?\n/);
    const out = [];
    const lowerOriginal = originalQuery.trim().toLowerCase();
    for (const line of lines) {
        let s = line.trim();
        if (s.length === 0) continue;
        // Strip leading enumeration: "1.", "1)", "-", "*", "•" + optional space.
        s = s.replace(/^(?:\d+[.)]|[-*•])\s+/, '');
        if (s.length === 0) continue;
        if (s.toLowerCase() === lowerOriginal) continue;
        out.push(s);
        if (out.length >= maxRounds) break;
    }
    return out;
}

/**
 * Build the messages payload for the paraphrase call. Single user
 * message — keeps the request small (utility models charge per token)
 * and lets the prompt itself carry the role framing.
 *
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
 * Construct a `QueryParaphraser`. Pure DI — no `core.js` / `LLM.chat`
 * import here.
 *
 * @param {Object} options
 * @param {ChatFn} options.chatFn                Caller-supplied chat-completion seam.
 * @param {string} options.modelId               Model id threaded into `chatFn` options.
 * @param {number} [options.rounds]              Number of paraphrases to request. Default 2.
 * @param {number} [options.temperature]         LLM temperature. Default 0 (deterministic).
 * @param {string} [options.prompt]              Override the locked default prompt. Default = `DEFAULT_PARAPHRASE_PROMPT`.
 * @param {ParaphraseCache} [options.cache]      Optional injected cache. Omit to share an in-memory cache scoped to this paraphraser instance.
 * @returns {QueryParaphraser}
 */
export function createQueryParaphraser(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('createQueryParaphraser: options must be an object');
    }
    const { chatFn, modelId, rounds, temperature, prompt, cache } = options;
    if (typeof chatFn !== 'function') {
        throw new TypeError('createQueryParaphraser: chatFn must be a function');
    }
    if (typeof modelId !== 'string' || modelId.length === 0) {
        throw new TypeError('createQueryParaphraser: modelId must be a non-empty string');
    }
    const r = rounds === undefined ? DEFAULT_PARAPHRASE_ROUNDS : rounds;
    if (!Number.isFinite(r) || r < 1 || r > 5) {
        throw new TypeError('createQueryParaphraser: rounds must be a number 1-5');
    }
    const t = temperature === undefined ? DEFAULT_PARAPHRASE_TEMPERATURE : temperature;
    if (!Number.isFinite(t) || t < 0 || t > 2) {
        throw new TypeError('createQueryParaphraser: temperature must be a number 0-2');
    }
    const promptResolved = (typeof prompt === 'string' && prompt.length > 0)
        ? prompt
        : DEFAULT_PARAPHRASE_PROMPT;
    if (cache !== undefined && (
        !cache
        || typeof cache.get !== 'function'
        || typeof cache.set !== 'function'
        || typeof cache.size !== 'function'
    )) {
        throw new TypeError('createQueryParaphraser: cache must satisfy { get, set, size }');
    }
    const resolvedCache = cache ?? defaultMemoryCache();

    let hits = 0;
    let misses = 0;
    let failures = 0;

    /**
     * @param {string} query
     * @returns {Promise<string[]>}
     */
    async function paraphrase(query) {
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
        const parsed = parseParaphraseResponse(raw, trimmed, r);
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

    return { paraphrase, stats };
}

/**
 * Resolve a `QueryParaphraser` from the user's settings + a chat seam.
 * Three-way mode dispatch:
 *
 *   - `'off'` (default) → returns `null`. The Composer receives no
 *     paraphraser and runs the existing single-variant path.
 *   - `'primary'` → wires `modelId = settings.llmModel`. One reusable
 *     setting; reuses the user's configured chat model.
 *   - `'utility'` → wires `modelId = settings.retrieval.paraphraseModelId`
 *     when non-empty; falls back to `null` (defensive — user enabled
 *     utility mode but left the model id blank).
 *
 * Provider/endpoint/key are not threaded through. The 1.5.12 design
 * decision is "same provider as the primary chat model; only `modelId`
 * differs" — multi-provider paraphrase is post-2.0. The supplied
 * `chatFn` is expected to read provider/endpoint/key from wherever it
 * needs to (production wires through `LLM.chat`, which already consults
 * `State.settings.llm*`).
 *
 * @param {ParaphraseSettings} settings
 * @param {Object} deps
 * @param {ChatFn} deps.chatFn                  Required.
 * @param {ParaphraseCache} [deps.cache]
 * @returns {QueryParaphraser|null}
 */
export function buildParaphraserFromSettings(settings, deps) {
    if (!settings || typeof settings !== 'object') return null;
    if (!deps || typeof deps.chatFn !== 'function') return null;
    const retrieval = /** @type {any} */ (settings).retrieval;
    if (!retrieval || typeof retrieval !== 'object') return null;
    const mode = retrieval.paraphraseMode;
    if (mode !== 'primary' && mode !== 'utility') return null;
    let modelId;
    if (mode === 'primary') {
        modelId = /** @type {any} */ (settings).llmModel;
    } else {
        modelId = retrieval.paraphraseModelId;
    }
    if (typeof modelId !== 'string' || modelId.length === 0) return null;
    const rounds = Number.isFinite(retrieval.paraphraseRounds)
        ? retrieval.paraphraseRounds
        : DEFAULT_PARAPHRASE_ROUNDS;
    const temperature = Number.isFinite(retrieval.paraphraseTemperature)
        ? retrieval.paraphraseTemperature
        : DEFAULT_PARAPHRASE_TEMPERATURE;
    return createQueryParaphraser({
        chatFn: deps.chatFn,
        modelId,
        rounds,
        temperature,
        cache: deps.cache,
    });
}
