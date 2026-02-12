/**
 * Tests for secondary pane utilities — isPreviewable, _shortAuthor, _shortDate.
 */
import { isPreviewable, _shortAuthor, _shortDate } from '../js/secondary-pane.js';

const { T } = window;

// ============================================
// isPreviewable
// ============================================

T.suite('isPreviewable');

T.assert(isPreviewable('README.md'), 'Markdown is previewable');
T.assert(isPreviewable('DOC.markdown'), '.markdown extension');
T.assert(isPreviewable('index.html'), 'HTML is previewable');
T.assert(isPreviewable('page.htm'), 'HTM is previewable');
T.assert(isPreviewable('icon.svg'), 'SVG is previewable');
T.assert(isPreviewable('PATH/TO/FILE.MD'), 'Case-insensitive');

T.assert(!isPreviewable('app.js'), 'JavaScript not previewable');
T.assert(!isPreviewable('style.css'), 'CSS not previewable');
T.assert(!isPreviewable('data.json'), 'JSON not previewable');
T.assert(!isPreviewable('image.png'), 'PNG not previewable');
T.assert(!isPreviewable(''), 'Empty string not previewable');
T.assert(!isPreviewable(null), 'null not previewable');
T.assert(!isPreviewable(undefined), 'undefined not previewable');

// ============================================
// _shortAuthor
// ============================================

T.suite('_shortAuthor');

T.eq(_shortAuthor('Jeff Smith'), 'Jeff S.', 'Two-part name → first + last initial');
T.eq(_shortAuthor('Alice Bob Charlie'), 'Alice C.', 'Three-part name → first + last initial');
T.eq(_shortAuthor('Mononym'), 'Mononym', 'Single name → truncated to 10 chars');
T.eq(_shortAuthor('VeryLongSingleName'), 'VeryLongSi', 'Long single name truncated to 10');
T.eq(_shortAuthor(''), '', 'Empty string');
T.eq(_shortAuthor(null), '', 'null');
T.eq(_shortAuthor(undefined), '', 'undefined');
T.eq(_shortAuthor('  Jeff   Smith  '), 'Jeff S.', 'Extra whitespace handled');

// ============================================
// _shortDate
// ============================================

T.suite('_shortDate');

// "today" and "yesterday" depend on wall clock — use relative timestamps
const now = new Date();
const todayISO = now.toISOString();
T.eq(_shortDate(todayISO), 'today', 'Current timestamp → "today"');

const yesterday = new Date(now - 24 * 60 * 60 * 1000);
T.eq(_shortDate(yesterday.toISOString()), 'yesterday', '24h ago → "yesterday"');

const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000);
T.eq(_shortDate(fiveDaysAgo.toISOString()), '5d ago', '5 days ago');

const twoMonthsAgo = new Date(now - 60 * 24 * 60 * 60 * 1000);
T.eq(_shortDate(twoMonthsAgo.toISOString()), '2mo ago', '60 days → "2mo ago"');

const oldDate = '2020-06-15T12:00:00Z';
const result = _shortDate(oldDate);
T.assert(result.startsWith('2020-'), `Old date → YYYY-MM-DD format (got "${result}")`);

T.eq(_shortDate(''), '', 'Empty string');
T.eq(_shortDate(null), '', 'null');
T.eq(_shortDate(undefined), '', 'undefined');

// Invalid date falls back to first 10 chars
T.eq(_shortDate('not-a-date-at-all'), 'not-a-date', 'Invalid date → first 10 chars');
