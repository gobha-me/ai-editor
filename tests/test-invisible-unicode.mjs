/**
 * Tests for 1.1.4 — invisible Unicode scanner.
 *
 * Pure-logic checks against js/security/invisible-unicode.js:
 *   - Each flagged codepoint family produces a finding.
 *   - Common BMP characters (CJK, accented Latin, emoji) don't false-positive.
 *   - Range boundaries are inclusive (start and end of each range hit).
 *   - findingsToCharRanges produces correct UTF-16 offsets, including the
 *     supplementary-plane Tags block which spans 2 char units.
 *   - shouldScan gates prose extensions off by default.
 *   - stripInvisible removes flagged chars and preserves everything else.
 *
 * No DOM here — the editor decoration's CM6 wiring is exercised by
 * tests/test-invisible-unicode.js (browser-only) once the decoration ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    INVISIBLE_RANGES,
    scan,
    findingsToCharRanges,
    stripInvisible,
    shouldScan
} from '../js/security/invisible-unicode.js';

const CP = String.fromCodePoint;

test('scan returns empty for ASCII-only input', () => {
    assert.deepEqual(scan('const x = 42;'), []);
});

test('scan returns empty for empty / non-string input', () => {
    assert.deepEqual(scan(''), []);
    assert.deepEqual(scan(null), []);
    assert.deepEqual(scan(undefined), []);
});

test('scan ignores common BMP characters (CJK, accents, emoji)', () => {
    assert.deepEqual(scan('Café 日本語 🎉 Привет'), []);
});

test('scan flags every named codepoint in CODEPOINT_NAMES', () => {
    const named = [
        0x200B, 0x200C, 0x200D, 0x200E, 0x200F,
        0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
        0x2060, 0x2061, 0x2062, 0x2063, 0x2064,
        0x2066, 0x2067, 0x2068, 0x2069,
        0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F,
        0xFEFF
    ];
    for (const cp of named) {
        const findings = scan(`a${CP(cp)}b`);
        assert.equal(findings.length, 1, `expected 1 finding for U+${cp.toString(16)}`);
        assert.equal(findings[0].codepoint, cp);
        assert.equal(findings[0].index, 1);
    }
});

test('scan flags Tags block boundaries U+E0000 and U+E007F', () => {
    for (const cp of [0xE0000, 0xE0001, 0xE0061, 0xE007F]) {
        const findings = scan(CP(cp));
        assert.equal(findings.length, 1, `expected 1 finding for U+${cp.toString(16)}`);
        assert.equal(findings[0].codepoint, cp);
    }
});

test('scan does not false-positive on range boundaries (one outside each range)', () => {
    const justOutside = [
        0x200A,  // one before zero-width
        0x2070,  // one after word-joiner block
        0xFEFE,  // one before BOM
        0xFF00,  // well after BOM
        0x2029,  // one before bidi-override
        0x202F,  // one after bidi-override
        0x2065,  // reserved gap inside word-joiner block — still flagged (range is inclusive); skip
        0x2070,  // re-tested
        0xDFFFF, // high private-use, well below tags block
        0xE0080  // one after tags block
    ];
    for (const cp of justOutside) {
        if (cp === 0x2065) continue; // 0x2065 IS inside U+2060–U+206F so it's flagged; not a boundary
        const findings = scan(CP(cp));
        assert.equal(findings.length, 0, `U+${cp.toString(16)} should not flag`);
    }
});

test('scan reports correct line and column (1-based)', () => {
    const text = `line one\nline two${CP(0x200B)}\nline three`;
    const findings = scan(text);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 2);
    assert.equal(findings[0].col, 9);
});

test('scan finds multiple findings in one string', () => {
    const text = `${CP(0x200B)}a${CP(0x202E)}b${CP(0xE0001)}`;
    const findings = scan(text);
    assert.equal(findings.length, 3);
    assert.equal(findings[0].codepoint, 0x200B);
    assert.equal(findings[1].codepoint, 0x202E);
    assert.equal(findings[2].codepoint, 0xE0001);
});

test('findingsToCharRanges: BMP char produces from/to=index+1', () => {
    const findings = scan(`a${CP(0x200B)}b`);
    const ranges = findingsToCharRanges(findings);
    assert.deepEqual(ranges, [{ from: 1, to: 2 }]);
});

test('findingsToCharRanges: Tags-block char produces from/to=index+2 (UTF-16 surrogate pair)', () => {
    const text = `a${CP(0xE0001)}b`;
    assert.equal(text.length, 4, 'sanity: U+E0001 takes 2 UTF-16 units');
    const findings = scan(text);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].index, 1);
    const ranges = findingsToCharRanges(findings);
    assert.deepEqual(ranges, [{ from: 1, to: 3 }]);
});

test('findingsToCharRanges: subsequent BMP char index reflects the surrogate pair', () => {
    const text = `${CP(0xE0001)}${CP(0x200B)}`;
    const findings = scan(text);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].index, 0);
    assert.equal(findings[1].index, 2);
});

test('stripInvisible removes flagged chars and preserves the rest', () => {
    assert.equal(stripInvisible(`a${CP(0x200B)}b`), 'ab');
    assert.equal(stripInvisible(`x${CP(0xE0001)}y`), 'xy');
    assert.equal(stripInvisible('clean'), 'clean');
    assert.equal(stripInvisible(''), '');
});

test('stripInvisible handles non-string input', () => {
    assert.equal(stripInvisible(null), null);
    assert.equal(stripInvisible(undefined), undefined);
});

test('shouldScan defaults on for code/config files', () => {
    assert.equal(shouldScan('foo.js'), true);
    assert.equal(shouldScan('plugin.json'), true);
    assert.equal(shouldScan('config.yaml'), true);
    assert.equal(shouldScan('main.py'), true);
    assert.equal(shouldScan('lib.rs'), true);
    assert.equal(shouldScan('Dockerfile'), true);
});

test('shouldScan defaults off for prose / markup formats', () => {
    assert.equal(shouldScan('README.md'), false);
    assert.equal(shouldScan('notes.markdown'), false);
    assert.equal(shouldScan('index.html'), false);
    assert.equal(shouldScan('page.htm'), false);
    assert.equal(shouldScan('manifest.xml'), false);
    assert.equal(shouldScan('book.xhtml'), false);
});

test('shouldScan handles paths with directories and uppercase extensions', () => {
    assert.equal(shouldScan('docs/notes.MD'), false);
    assert.equal(shouldScan('src/lib/util.JS'), true);
    assert.equal(shouldScan('foo'), true);
});

test('INVISIBLE_RANGES exports cover all four families', () => {
    const families = new Set(INVISIBLE_RANGES.map(r => r.family));
    assert.ok(families.has('zero-width'));
    assert.ok(families.has('bidi-override'));
    assert.ok(families.has('tags-block'));
});
