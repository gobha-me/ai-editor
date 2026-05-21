/**
 * Anti-regression CI guard: the four agent-loop consumer files must each
 * cite `./agent-loop-contracts.js` so the contract surface named at
 * 2.83.0 stays linked from source.
 *
 * Why this exists — `docs/DESIGN-agent-loop.md` (landed 2026-05-21) names
 * the agent-loop consumer surface (envelope authorship rule, cache
 * coordination, dup-streak guard, no-progress guard, queued-input FIFO,
 * user-pause Promise slot, stateful-read bypass). 2.83.0 added
 * `js/chat/agent-loop-contracts.js` as the source-side citation point for
 * the design doc. Without a lint, future edits to the consumer files
 * (tool-loop-core.js, cache-invalidation.js, cache-policy.js,
 * refusal-hints.js) can silently drop the `@see` pointer or remove the
 * `@returns {import('./agent-loop-contracts.js').*}` JSDoc, and the
 * centralization rots.
 *
 * Shape: presence-of-citation. Read each consumer file as text; assert
 * the literal substring `agent-loop-contracts` appears. Don't validate
 * JSDoc parse (the project has no TS toolchain). Mirrors the source-scan
 * precedent in `tests/test-edit-tracker-read-tool-contract.mjs` (2.79.0).
 *
 * Also asserts `js/chat/agent-loop-contracts.js` itself exists and
 * carries the load-bearing literals `DESIGN-agent-loop.md` and
 * `Authorship Rule`.
 *
 * Runs under `node --test`. No browser-globals shim needed (no transitive
 * imports of `js/core.js` / `js/git.js`).
 *
 * @since 2.83.0
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CHAT_DIR = join(REPO_ROOT, 'js', 'chat');

const CONTRACTS_FILE = join(CHAT_DIR, 'agent-loop-contracts.js');

const CONSUMERS = [
    'tool-loop-core.js',
    'cache-invalidation.js',
    'cache-policy.js',
    'refusal-hints.js',
];

test('agent-loop-contracts.js exists', () => {
    assert.ok(
        existsSync(CONTRACTS_FILE),
        `Expected ${CONTRACTS_FILE} to exist. The 2.83.0 contract-centralization PR introduced ` +
        `this module as the source-side citation point for docs/DESIGN-agent-loop.md. ` +
        `If it has been moved or renamed, update the CONTRACTS_FILE path in this test ` +
        `AND the consumer-citation expectations below.`,
    );
});

test('agent-loop-contracts.js cites DESIGN-agent-loop.md', () => {
    const src = readFileSync(CONTRACTS_FILE, 'utf8');
    assert.match(
        src,
        /DESIGN-agent-loop\.md/,
        `agent-loop-contracts.js must cite docs/DESIGN-agent-loop.md (the authoritative design doc) ` +
        `so consumers and reviewers can follow the contract back to its source. ` +
        `Missing this citation means the module loses its load-bearing pointer.`,
    );
});

test('agent-loop-contracts.js documents the Authorship Rule', () => {
    const src = readFileSync(CONTRACTS_FILE, 'utf8');
    assert.match(
        src,
        /Authorship Rule/,
        `agent-loop-contracts.js must include the "Authorship Rule" heading + classification table ` +
        `verbatim from DESIGN-agent-loop.md §"The Authorship Rule". This is the test that ` +
        `disambiguates loop-authored vs. tool-authored envelope fields and is the most-cited ` +
        `part of the contract.`,
    );
});

for (const consumer of CONSUMERS) {
    test(`${consumer} cites ./agent-loop-contracts.js`, () => {
        const path = join(CHAT_DIR, consumer);
        const src = readFileSync(path, 'utf8');
        assert.match(
            src,
            /agent-loop-contracts/,
            `${consumer} must cite agent-loop-contracts.js (via @see, @returns/@type ` +
            `JSDoc, or a module-header pointer). 2.83.0 added the citation; future edits ` +
            `must not drop it without also removing this consumer from CONSUMERS in this ` +
            `test (and explaining why in the PR description). The four-consumer set is ` +
            `pinned to: ${CONSUMERS.join(', ')}.`,
        );
    });
}
