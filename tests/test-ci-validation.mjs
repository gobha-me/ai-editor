import assert from 'node:assert/strict';
import test from 'node:test';

import {
    findInvisibleUnicode,
    findThemeTokenViolations,
    findUnsafeRawReturns,
    validateVersionText,
} from '../scripts/ci/validate.mjs';

const releasedChangelog = '# Changelog\n\n## [Unreleased]\n\n## [2.93.0] - 2026-05-22\n';

test('released version matches the latest changelog heading', () => {
    assert.deepEqual(
        validateVersionText("export const VERSION = '2.93.0';\n", releasedChangelog),
        { version: '2.93.0', latestRelease: '2.93.0', inFlight: false },
    );
});

test('released version rejects changelog drift', () => {
    assert.throws(
        () => validateVersionText("export const VERSION = '2.97.0';\n", releasedChangelog),
        /Version drift/u,
    );
});

test('in-flight version requires a new target and Unreleased section', () => {
    assert.deepEqual(
        validateVersionText("export const VERSION = '2.94.0.1';\n", releasedChangelog),
        { version: '2.94.0.1', latestRelease: '2.93.0', inFlight: true },
    );
    assert.throws(
        () => validateVersionText("export const VERSION = '2.93.0.1';\n", releasedChangelog),
        /conflicts with released/u,
    );
    assert.throws(
        () => validateVersionText("export const VERSION = '2.92.0.1';\n", releasedChangelog),
        /must be newer/u,
    );
});

test('release tag must exactly match a released three-segment version', () => {
    assert.doesNotThrow(() => validateVersionText(
        "export const VERSION = '2.93.0';\n",
        releasedChangelog,
        'v2.93.0',
    ));
    assert.throws(
        () => validateVersionText("export const VERSION = '2.93.0';\n", releasedChangelog, 'v2.92.0'),
        /does not match/u,
    );
});

test('unsafe raw HTML return is reported with its line', () => {
    assert.deepEqual(findUnsafeRawReturns('safe();\nreturn raw;\n'), [
        { line: 2, text: 'return raw;' },
    ]);
});

test('invisible Unicode scanner reports tags, zero-width, and bidi controls', () => {
    const findings = findInvisibleUnicode(`a\u200bb\u202ec${String.fromCodePoint(0xe0001)}`);
    assert.deepEqual(findings.map(finding => finding.codePoint), ['U+200B', 'U+202E', 'U+E0001']);
});

test('theme validator rejects standalone hex but permits var fallbacks', () => {
    assert.deepEqual(findThemeTokenViolations('.a { color: #fff; }'), [
        { line: 1, text: '.a { color: #fff; }' },
    ]);
    assert.deepEqual(findThemeTokenViolations('.a { color: var(--text, #fff); }'), []);
    assert.deepEqual(findThemeTokenViolations('/* gitea#523 */\n.a { color: var(--text); }'), []);
});
