/**
 * Browser tests for the loadSettings one-shot migration block.
 * Mirrors `tests/test-settings-migration.mjs` using the in-page T harness.
 * Pure-logic tests; no DOM, no Storage round-trip — that's covered by the
 * .mjs sibling under node --test.
 */
import { State } from '../js/core.js';

const { T } = window;

function applyMigration(saved) {
    if (saved.llmTimeout !== undefined && saved.llmIdleTimeout === undefined) {
        saved.llmIdleTimeout = saved.llmTimeout;
        delete saved.llmTimeout;
    }
    return saved;
}

T.suite('Settings migration — llmTimeout → llmIdleTimeout');

T.eq(applyMigration({ llmTimeout: 240000 }).llmIdleTimeout, 240000,
    'old key value copied to new key');
T.eq(applyMigration({ llmTimeout: 240000 }).llmTimeout, undefined,
    'old key removed after migration');
T.eq(applyMigration({ llmIdleTimeout: 90000 }).llmIdleTimeout, 90000,
    'no-op when only new key present');
T.eq(applyMigration({ llmTimeout: 180000, llmIdleTimeout: 90000 }).llmIdleTimeout, 90000,
    'when both present, new key wins');
T.eq(applyMigration({ llmTimeout: 180000, llmIdleTimeout: 90000 }).llmTimeout, 180000,
    'when both present, old key not removed');
T.eq(applyMigration({ llmModel: 'foo' }).llmIdleTimeout, undefined,
    'no-op when neither key present');

T.suite('Settings migration — defaults & idempotency');

T.eq(State.settings.llmIdleTimeout, 90000,
    'State.settings.llmIdleTimeout default is 90000');
T.eq(State.settings.llmTimeout, undefined,
    'State.settings.llmTimeout no longer present (renamed)');

const once = applyMigration({ llmTimeout: 120000 });
const twice = applyMigration({ ...once });
T.deepEq(once, twice, 'migration is idempotent');
