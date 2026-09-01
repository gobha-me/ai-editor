/**
 * Invisible Unicode scanner — supply-chain / glassworm / Trojan Source defense.
 *
 * Single source of truth for the codepoint ranges flagged across:
 *   - This module (editor decoration, plugin install scan, settings import scan)
 *   - scripts/ci/validate.mjs invisible-Unicode source policy
 *   - docs/SECURITY.md "Codepoint reference" section
 *
 * If you change the ranges here, update the CI lint pattern AND
 * docs/SECURITY.md in the same PR.
 *
 * @module security/invisible-unicode
 */

// Tags block, zero-width, bidi overrides. See docs/SECURITY.md for the threat
// model (glassworm uses tags block; Trojan Source uses bidi overrides;
// zero-width chars are the polyglot/exfil staple).
export const INVISIBLE_RANGES = [
    { start: 0x200B, end: 0x200F, family: 'zero-width', name: 'Zero-width / directional marks' },
    { start: 0x2060, end: 0x206F, family: 'zero-width', name: 'Word joiner / invisible operators' },
    { start: 0xFEFF, end: 0xFEFF, family: 'zero-width', name: 'BOM / Zero Width No-Break Space' },
    { start: 0x202A, end: 0x202E, family: 'bidi-override', name: 'Bidi embedding / override' },
    { start: 0x2066, end: 0x2069, family: 'bidi-override', name: 'Bidi isolate' },
    { start: 0xE0000, end: 0xE007F, family: 'tags-block', name: 'Tags block (glassworm carrier)' }
];

const INVISIBLE_REGEX = /[\u200B-\u200F\u2060-\u206F\uFEFF\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu;

const CODEPOINT_NAMES = {
    0x200B: 'Zero Width Space',
    0x200C: 'Zero Width Non-Joiner',
    0x200D: 'Zero Width Joiner',
    0x200E: 'Left-To-Right Mark',
    0x200F: 'Right-To-Left Mark',
    0x202A: 'Left-To-Right Embedding',
    0x202B: 'Right-To-Left Embedding',
    0x202C: 'Pop Directional Formatting',
    0x202D: 'Left-To-Right Override',
    0x202E: 'Right-To-Left Override',
    0x2060: 'Word Joiner',
    0x2061: 'Function Application',
    0x2062: 'Invisible Times',
    0x2063: 'Invisible Separator',
    0x2064: 'Invisible Plus',
    0x2066: 'Left-To-Right Isolate',
    0x2067: 'Right-To-Left Isolate',
    0x2068: 'First Strong Isolate',
    0x2069: 'Pop Directional Isolate',
    0x206A: 'Inhibit Symmetric Swapping',
    0x206B: 'Activate Symmetric Swapping',
    0x206C: 'Inhibit Arabic Form Shaping',
    0x206D: 'Activate Arabic Form Shaping',
    0x206E: 'National Digit Shapes',
    0x206F: 'Nominal Digit Shapes',
    0xFEFF: 'Zero Width No-Break Space (BOM)'
};

function getCodepointName(cp) {
    if (CODEPOINT_NAMES[cp]) return CODEPOINT_NAMES[cp];
    if (cp >= 0xE0000 && cp <= 0xE007F) {
        if (cp === 0xE0001) return 'Language Tag';
        if (cp >= 0xE0020 && cp <= 0xE007E) {
            return `Tag '${String.fromCodePoint(cp - 0xE0000)}'`;
        }
        if (cp === 0xE007F) return 'Cancel Tag';
        return `Tag block U+${cp.toString(16).toUpperCase().padStart(5, '0')}`;
    }
    return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

function buildLineIndex(text) {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 0x0A) lineStarts.push(i + 1);
    }
    return lineStarts;
}

function lineColForIndex(lineStarts, index) {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= index) lo = mid;
        else hi = mid - 1;
    }
    return { line: lo + 1, col: index - lineStarts[lo] + 1 };
}

/**
 * Scan a string for invisible Unicode characters in the flagged ranges.
 *
 * @param {string} text
 * @returns {Array<{index: number, codepoint: number, char: string, name: string, line: number, col: number}>}
 *   `index` is the UTF-16 char offset (matters for CM6: tags-block chars are
 *   surrogate pairs and occupy 2 chars). `line` and `col` are 1-based.
 */
export function scan(text) {
    if (typeof text !== 'string' || text.length === 0) return [];
    const findings = [];
    const lineStarts = buildLineIndex(text);
    INVISIBLE_REGEX.lastIndex = 0;
    let match;
    while ((match = INVISIBLE_REGEX.exec(text)) !== null) {
        const index = match.index;
        const char = match[0];
        const codepoint = char.codePointAt(0);
        const { line, col } = lineColForIndex(lineStarts, index);
        findings.push({
            index,
            codepoint,
            char,
            name: getCodepointName(codepoint),
            line,
            col
        });
    }
    return findings;
}

/**
 * Convert findings into CM6 char ranges (from/to). Tags-block chars span 2 UTF-16
 * code units; BMP chars span 1. CM6 indexes by char (UTF-16), not codepoint.
 *
 * @param {Array<{index: number, char: string}>} findings
 * @returns {Array<{from: number, to: number}>}
 */
export function findingsToCharRanges(findings) {
    return findings.map(f => ({
        from: f.index,
        to: f.index + f.char.length
    }));
}

/**
 * Remove every invisible character from a string.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripInvisible(text) {
    if (typeof text !== 'string') return text;
    return text.replace(INVISIBLE_REGEX, '');
}

const PROSE_EXTENSIONS = new Set(['md', 'markdown', 'html', 'htm', 'xml', 'xhtml']);

/**
 * Whether the editor decoration should scan a file by default. Off for prose
 * formats where bidi/zero-width is sometimes legitimate (localized text).
 *
 * @param {string} filename
 * @returns {boolean}
 */
export function shouldScan(filename) {
    if (typeof filename !== 'string' || filename.length === 0) return true;
    const dot = filename.lastIndexOf('.');
    if (dot < 0) return true;
    const ext = filename.slice(dot + 1).toLowerCase();
    return !PROSE_EXTENSIONS.has(ext);
}
