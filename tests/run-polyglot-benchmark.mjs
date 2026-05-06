#!/usr/bin/env node
// @ts-check
/**
 * Polyglot retrieval benchmark — drives `POLYGLOT_QUERY_FIXTURES` through
 * the existing regex code chunker
 * ([code-chunker.js](../js/intelligence/retrieval/chunkers/code-chunker.js))
 * + BM25 index ([bm25-indexer.js](../js/intelligence/retrieval/bm25-indexer.js))
 * + the strategy's `scoreBM25Doc`
 * ([strategies/semantic.js](../js/intelligence/retrieval/strategies/semantic.js))
 * against two real polyglot codebases (Armature in Go, Plinth in C++).
 *
 * **Why BM25, not semantic.** The roadmap's gated AST-chunker decision
 * turns on whether the regex chunker creates a measurable retrieval
 * quality gap on languages it does not have dedicated boundary patterns
 * for (everything not JS/TS/Python). The chunker emits the same chunks
 * regardless of which scorer downstream consumes them — so a chunker-
 * quality gap shows up in BM25 the same way it shows up in semantic.
 * BM25 is reproducible (no API keys, no model swaps), free (no embedding
 * cost over thousands of files), and fast (~1-2 min total). Locking the
 * scorer to BM25 keeps the experiment hermetic.
 *
 * **What this runs.**
 *   1. Walk each target repo's filesystem (skipping vendor/build/etc).
 *   2. Read each source file as UTF-8; size-cap at 500 KB.
 *   3. Chunk via `chunkCode({bytes, collection, metadata})` — the live
 *      production chunker.
 *   4. Build a single BM25 index per repo via `buildBM25Index`.
 *   5. For each fixture matching that repo:
 *      - `tokenizeBM25(query)`
 *      - Score every chunk
 *      - Dedupe scored chunks to file paths (best-score-wins per file)
 *      - Take top 5 paths → compute hit@5 (binary: ANY expected path
 *        present?) and recall@5 (fraction of expected paths present).
 *   6. Aggregate per repo + per category. Write JSON + a human-readable
 *      markdown report next to the fixture file.
 *
 * **Run shape.**
 *
 *   node tests/run-polyglot-benchmark.mjs
 *     # Default: both repos, paths from POLYGLOT_REPO_ROOTS env or
 *     # /config/Projects/{armature,plinth}.
 *
 *   POLYGLOT_REPO_ROOT_ARMATURE=/path/to/armature \
 *   POLYGLOT_REPO_ROOT_PLINTH=/path/to/plinth \
 *   node tests/run-polyglot-benchmark.mjs --repo armature
 *
 * Pure node — no browser, no IDB, no embeddings, no network.
 *
 * @module tests/run-polyglot-benchmark
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';

import { chunkCode } from '../js/intelligence/retrieval/chunkers/code-chunker.js';
import { buildBM25Index } from '../js/intelligence/retrieval/bm25-indexer.js';
import {
    tokenizeBM25,
    scoreBM25Doc,
    applyScoreWeights,
} from '../js/intelligence/retrieval/strategies/semantic.js';
import { POLYGLOT_QUERY_FIXTURES, getFixturesByRepo } from './fixtures/polyglot-corpus.js';

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

const DEFAULT_ROOTS = {
    armature: process.env.POLYGLOT_REPO_ROOT_ARMATURE || '/config/Projects/armature',
    plinth: process.env.POLYGLOT_REPO_ROOT_PLINTH || '/config/Projects/plinth',
};

/**
 * Permissive source extensions. The chunker's regex patterns cover JS/TS/
 * Python; everything else falls into the single-chunk degenerate path with
 * an 8000-char hard-cut. Including unsupported languages is the *whole
 * point* of this benchmark.
 */
const SOURCE_EXTENSIONS = new Set([
    'go',
    'c', 'cc', 'cpp', 'cxx',
    'h', 'hh', 'hpp', 'hxx',
    'rs',
    'java', 'kt', 'scala',
    'rb',
    'pl', 'pm',
    'swift', 'm', 'mm',
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
    'py',
]);

/**
 * Directories to never descend into. Build outputs, vendored dependencies,
 * VCS metadata, generated artifacts, runtime data.
 */
const SKIP_DIRS = new Set([
    '.git', '.github', '.idea', '.vscode',
    '.claude',  // Claude Code worktree mirrors duplicate the entire source tree.
    'node_modules', 'vendor', 'third_party', 'thirdparty', '_third_party',
    'build', 'build-asan', 'build-debug', 'cmake-build-debug',
    'dist', 'out', 'target',
    'logs', 'uploads',
    '.cache',
]);

const MAX_FILE_BYTES = 500 * 1024; // 500 KB per file
const TOP_K = 5;

/* -------------------------------------------------------------------------- */
/* Filesystem walker                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Recursively walk `root`, yielding absolute paths to source files
 * matching `SOURCE_EXTENSIONS` and not under any `SKIP_DIRS` entry.
 *
 * @param {string} root
 * @returns {AsyncGenerator<string>}
 */
async function* walkSourceFiles(root) {
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (err) {
            console.warn(`[walk] skip ${dir}: ${err?.message || err}`);
            continue;
        }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            if (!entry.isFile()) continue;
            const dot = entry.name.lastIndexOf('.');
            if (dot < 0) continue;
            const ext = entry.name.slice(dot + 1).toLowerCase();
            if (!SOURCE_EXTENSIONS.has(ext)) continue;
            yield full;
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Index build                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} RepoIndex
 * @property {string} repo
 * @property {string} root
 * @property {import('../js/intelligence/retrieval/contracts.js').Chunk[]} chunks
 * @property {ReturnType<typeof buildBM25Index>} bm25
 * @property {{ files: number, chunks: number, skippedLarge: number, readErrors: number, elapsedMs: number }} stats
 */

/**
 * Walk a repo, chunk every source file, build a BM25 index over the
 * chunks. Returns the index + stats.
 *
 * @param {string} repo
 * @param {string} root
 * @returns {Promise<RepoIndex>}
 */
async function buildRepoIndex(repo, root) {
    const t0 = Date.now();
    /** @type {import('../js/intelligence/retrieval/contracts.js').Chunk[]} */
    const allChunks = [];
    let files = 0;
    let skippedLarge = 0;
    let readErrors = 0;

    for await (const abs of walkSourceFiles(root)) {
        let stat;
        try {
            stat = await fs.stat(abs);
        } catch {
            readErrors++;
            continue;
        }
        if (stat.size > MAX_FILE_BYTES) {
            skippedLarge++;
            continue;
        }
        let bytes;
        try {
            bytes = await fs.readFile(abs, 'utf8');
        } catch (err) {
            readErrors++;
            continue;
        }
        files++;
        const rel = path.relative(root, abs);
        const chunks = chunkCode({
            bytes,
            collection: repo,
            metadata: {
                source_uri: rel,
                created_at: 0,
                updated_at: 0,
            },
        });
        for (const c of chunks) allChunks.push(c);
    }

    const bm25 = buildBM25Index(/** @type {any} */ (allChunks));
    const elapsedMs = Date.now() - t0;

    return {
        repo,
        root,
        chunks: allChunks,
        bm25,
        stats: { files, chunks: allChunks.length, skippedLarge, readErrors, elapsedMs },
    };
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Score every chunk against `query`, optionally apply path/content-type
 * weight multipliers via `applyScoreWeights` (the same helper the
 * Semantic strategy uses post-rank), dedupe to file paths
 * (best-weighted-score wins per file), and return the top-K paths.
 *
 * Reusing `applyScoreWeights` keeps Stage-1 benchmark math identical to
 * the Stage-2 production code path — if/when a default weight set is
 * added to the strategy, the benchmark and production scores stay in
 * lockstep.
 *
 * @param {RepoIndex} idx
 * @param {string} query
 * @param {number} topK
 * @param {{ content_types?: Object<string, number>, prefixes?: Object<string, number> }|null} weights
 * @returns {{ paths: string[], topScore: number }}
 */
function topPathsForQuery(idx, query, topK, weights) {
    const queryTokens = tokenizeBM25(query);
    if (queryTokens.length === 0) return { paths: [], topScore: 0 };

    /** @type {Array<{chunk: any, score: number}>} */
    const scored = [];
    for (const chunk of idx.chunks) {
        const s = scoreBM25Doc(queryTokens, chunk.content, idx.bm25);
        if (!Number.isFinite(s) || s <= 0) continue;
        scored.push({ chunk, score: s });
    }

    const weighted = applyScoreWeights(scored, weights || undefined);

    /** @type {Map<string, number>} */
    const bestPerFile = new Map();
    let topScore = 0;
    for (const { chunk, score } of weighted) {
        if (score > topScore) topScore = score;
        const uri = chunk.metadata.source_uri;
        const prev = bestPerFile.get(uri) || 0;
        if (score > prev) bestPerFile.set(uri, score);
    }

    const ranked = Array.from(bestPerFile.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, topK)
        .map(([uri]) => uri);

    return { paths: ranked, topScore };
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} FixtureResult
 * @property {string}   id
 * @property {string}   repo
 * @property {string}   query
 * @property {string}   category
 * @property {string[]} expectedPaths
 * @property {string[]} returnedPaths
 * @property {number}   recallAt5    Fraction of expected paths in returned top-5.
 * @property {number}   hitAt5       1 if any expected path is in the top-5, else 0.
 * @property {number}   topScore
 */

/**
 * @param {RepoIndex} idx
 * @param {ReturnType<typeof getFixturesByRepo>} fixtures
 * @param {{ content_types?: Object<string, number>, prefixes?: Object<string, number> }|null} weights
 * @returns {FixtureResult[]}
 */
function runFixtures(idx, fixtures, weights) {
    /** @type {FixtureResult[]} */
    const out = [];
    for (const f of fixtures) {
        const { paths, topScore } = topPathsForQuery(idx, f.query, TOP_K, weights);
        const hits = f.expectedPaths.filter((p) => paths.includes(p));
        const recallAt5 = f.expectedPaths.length === 0 ? 0 : hits.length / f.expectedPaths.length;
        out.push({
            id: f.id,
            repo: f.repo,
            query: f.query,
            category: f.category,
            expectedPaths: f.expectedPaths,
            returnedPaths: paths,
            recallAt5,
            hitAt5: hits.length > 0 ? 1 : 0,
            topScore,
        });
    }
    return out;
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @param {FixtureResult[]} results
 */
function aggregate(results) {
    const byRepo = {};
    const byCategory = {};
    for (const r of results) {
        if (!byRepo[r.repo]) byRepo[r.repo] = { count: 0, hitAt5Sum: 0, recallAt5Sum: 0 };
        byRepo[r.repo].count++;
        byRepo[r.repo].hitAt5Sum += r.hitAt5;
        byRepo[r.repo].recallAt5Sum += r.recallAt5;
        const k = `${r.repo}/${r.category}`;
        if (!byCategory[k]) byCategory[k] = { count: 0, hitAt5Sum: 0, recallAt5Sum: 0 };
        byCategory[k].count++;
        byCategory[k].hitAt5Sum += r.hitAt5;
        byCategory[k].recallAt5Sum += r.recallAt5;
    }
    const finalize = (a) => ({
        count: a.count,
        meanHitAt5: a.count === 0 ? 0 : a.hitAt5Sum / a.count,
        meanRecallAt5: a.count === 0 ? 0 : a.recallAt5Sum / a.count,
    });
    return {
        overall: finalize(Object.values(byRepo).reduce((acc, x) => ({
            count: acc.count + x.count,
            hitAt5Sum: acc.hitAt5Sum + x.hitAt5Sum,
            recallAt5Sum: acc.recallAt5Sum + x.recallAt5Sum,
        }), { count: 0, hitAt5Sum: 0, recallAt5Sum: 0 })),
        byRepo: Object.fromEntries(Object.entries(byRepo).map(([k, v]) => [k, finalize(v)])),
        byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, finalize(v)])),
    };
}

/**
 * @typedef {Object} ConfigRun
 * @property {string} name
 * @property {{ content_types?: Object<string, number>, prefixes?: Object<string, number> }|null} weights
 * @property {FixtureResult[]} results
 * @property {ReturnType<typeof aggregate>} aggregate
 */

/**
 * @param {RepoIndex[]} indexes
 * @param {ConfigRun[]} configRuns
 */
function renderMarkdown(indexes, configRuns) {
    const lines = [];
    lines.push('# Polyglot Retrieval Benchmark — Results');
    lines.push('');
    lines.push(`Run: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('Scorer: BM25 only (no embedder). Chunker: production regex / AST (1.7.0+).');
    lines.push('');
    lines.push('## Index stats');
    lines.push('');
    lines.push('| Repo | Files | Chunks | Skipped (>500K) | Read errors | Elapsed |');
    lines.push('|---|---:|---:|---:|---:|---:|');
    for (const idx of indexes) {
        lines.push(`| ${idx.repo} | ${idx.stats.files} | ${idx.stats.chunks} | ${idx.stats.skippedLarge} | ${idx.stats.readErrors} | ${idx.stats.elapsedMs} ms |`);
    }
    lines.push('');
    lines.push('## Configurations compared');
    lines.push('');
    lines.push('| Config | Weights |');
    lines.push('|---|---|');
    for (const c of configRuns) {
        const w = c.weights ? `\`${JSON.stringify(c.weights)}\`` : '_(none — baseline)_';
        lines.push(`| **${c.name}** | ${w} |`);
    }
    lines.push('');
    lines.push('## Aggregate (side-by-side)');
    lines.push('');
    const repoNames = Object.keys(configRuns[0].aggregate.byRepo);
    const headerCells = ['Scope', ...configRuns.map(c => `${c.name} meanHit@5 / meanRecall@5`)];
    lines.push(`| ${headerCells.join(' | ')} |`);
    lines.push(`|${headerCells.map(() => '---').join('|')}|`);
    const fmt = (a) => `${a.meanHitAt5.toFixed(3)} / ${a.meanRecallAt5.toFixed(3)}`;
    lines.push(`| **Overall** | ${configRuns.map(c => fmt(c.aggregate.overall)).join(' | ')} |`);
    for (const repo of repoNames) {
        lines.push(`| **${repo}** | ${configRuns.map(c => fmt(c.aggregate.byRepo[repo])).join(' | ')} |`);
    }
    lines.push('');
    for (const c of configRuns) {
        lines.push(`## ${c.name} — by category`);
        lines.push('');
        lines.push('| Repo / Category | N | meanHit@5 | meanRecall@5 |');
        lines.push('|---|---:|---:|---:|');
        for (const [k, v] of Object.entries(c.aggregate.byCategory)) {
            lines.push(`| ${k} | ${v.count} | ${v.meanHitAt5.toFixed(3)} | ${v.meanRecallAt5.toFixed(3)} |`);
        }
        lines.push('');
        lines.push(`### ${c.name} — per-fixture detail`);
        lines.push('');
        lines.push('| ID | Cat | Hit | R@5 | Top score | Returned (top 5) | Expected |');
        lines.push('|---|---|:-:|---:|---:|---|---|');
        for (const r of c.results) {
            const got = r.returnedPaths.length === 0 ? '_(no results)_' : r.returnedPaths.map(p => `\`${p}\``).join('<br>');
            const want = r.expectedPaths.map(p => `\`${p}\``).join('<br>');
            const hit = r.hitAt5 ? '✅' : '❌';
            lines.push(`| \`${r.id}\` | ${r.category} | ${hit} | ${r.recallAt5.toFixed(2)} | ${r.topScore.toFixed(2)} | ${got} | ${want} |`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                        */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
    const args = { repo: 'both', out: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--repo') args.repo = argv[++i];
        else if (a === '--out') args.out = argv[++i];
        else if (a === '--help' || a === '-h') {
            console.log('usage: node tests/run-polyglot-benchmark.mjs [--repo armature|plinth|both] [--out <path-without-ext>]');
            process.exit(0);
        }
    }
    return args;
}

/**
 * Configurations the benchmark sweeps in a single run. Each entry is
 * passed through `applyScoreWeights` post-rank, pre-truncation. The
 * `tests/`-prefix penalties target the AST chunker Phase 2 lever C
 * hypothesis: that integration-test files out-score source files when
 * both contain query keywords (the Plinth/C++ stuck-zero fixtures).
 */
const RUN_CONFIGS = [
    { name: 'baseline', weights: null },
    { name: 'tests-prefix-0.5', weights: { prefixes: { 'tests/': 0.5, 'test/': 0.5, 'integration_tests/': 0.5 } } },
    { name: 'tests-prefix-0.3', weights: { prefixes: { 'tests/': 0.3, 'test/': 0.3, 'integration_tests/': 0.3 } } },
];

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const repos = args.repo === 'both' ? ['armature', 'plinth'] : [args.repo];

    const indexes = [];
    for (const repo of repos) {
        const root = DEFAULT_ROOTS[repo];
        if (!root) {
            console.error(`unknown repo: ${repo}`);
            process.exit(2);
        }
        try {
            await fs.access(root);
        } catch {
            console.error(`repo root not accessible: ${root}`);
            process.exit(2);
        }
        process.stdout.write(`[bench] indexing ${repo} at ${root} ... `);
        const idx = await buildRepoIndex(repo, root);
        process.stdout.write(`done (${idx.stats.files} files, ${idx.stats.chunks} chunks, ${idx.stats.elapsedMs} ms)\n`);
        indexes.push(idx);
    }

    /** @type {ConfigRun[]} */
    const configRuns = [];
    for (const cfg of RUN_CONFIGS) {
        /** @type {FixtureResult[]} */
        const allResults = [];
        for (const idx of indexes) {
            const fixtures = getFixturesByRepo(/** @type {any} */ (idx.repo));
            const results = runFixtures(idx, fixtures, cfg.weights);
            allResults.push(...results);
        }
        configRuns.push({
            name: cfg.name,
            weights: cfg.weights,
            results: allResults,
            aggregate: aggregate(allResults),
        });
    }

    const md = renderMarkdown(indexes, configRuns);
    console.log('');
    console.log(md);

    // Write outputs next to the fixture file unless --out overrides.
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const base = args.out || path.join(here, 'fixtures', 'polyglot-benchmark-results');
    const jsonPath = `${base}.json`;
    const mdPath = `${base}.md`;
    await fs.writeFile(jsonPath, JSON.stringify({
        ranAt: new Date().toISOString(),
        scorer: 'bm25',
        topK: TOP_K,
        indexes: indexes.map(i => ({ repo: i.repo, root: i.root, stats: i.stats })),
        configs: configRuns,
    }, null, 2));
    await fs.writeFile(mdPath, md);
    console.log(`\nWrote ${jsonPath}`);
    console.log(`Wrote ${mdPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
