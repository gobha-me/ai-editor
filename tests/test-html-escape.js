/**
 * Tests for HTML escape utilities — escapeHtml, escapeAttr.
 * Critical security functions: XSS prevention.
 */
import { escapeHtml, escapeAttr } from '../js/utils/html.js';

const { T } = window;

// ============================================
// escapeHtml
// ============================================

T.suite('escapeHtml — Basic Escaping');

T.eq(escapeHtml('hello'), 'hello', 'Plain text unchanged');
T.eq(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;', 'Script tags escaped');
T.eq(escapeHtml('a & b'), 'a &amp; b', 'Ampersand escaped');
T.eq(escapeHtml('"quoted"'), '"quoted"', 'Quotes in HTML content (not attrs)');
T.eq(escapeHtml("it's"), "it's", 'Single quotes in HTML content');
T.eq(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;', 'XSS img tag escaped');

T.suite('escapeHtml — Edge Cases');

T.eq(escapeHtml(''), '', 'Empty string');
T.eq(escapeHtml(null), '', 'null → empty');
T.eq(escapeHtml(undefined), '', 'undefined → empty');
T.eq(escapeHtml(42), '42', 'Number coerced to string');
T.eq(escapeHtml(0), '0', 'Zero coerced');
T.eq(escapeHtml(false), 'false', 'Boolean coerced');
T.eq(escapeHtml('a\nb'), 'a\nb', 'Newlines preserved');
T.eq(escapeHtml('  spaces  '), '  spaces  ', 'Whitespace preserved');

// ============================================
// escapeAttr
// ============================================

T.suite('escapeAttr — Basic Escaping');

T.eq(escapeAttr('hello'), 'hello', 'Plain text unchanged');
T.eq(escapeAttr('"double"'), '&quot;double&quot;', 'Double quotes escaped');
T.eq(escapeAttr("'single'"), '&#39;single&#39;', 'Single quotes escaped');
T.eq(escapeAttr('a & b'), 'a &amp; b', 'Ampersand escaped');
T.eq(escapeAttr('<tag>'), '&lt;tag&gt;', 'Angle brackets escaped');
T.eq(escapeAttr('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)', 'XSS attribute breakout escaped');

T.suite('escapeAttr — Edge Cases');

T.eq(escapeAttr(''), '', 'Empty string');
T.eq(escapeAttr(null), '', 'null → empty');
T.eq(escapeAttr(undefined), '', 'undefined → empty');
T.eq(escapeAttr(42), '42', 'Number coerced');

T.suite('escapeAttr — Combined Characters');

T.eq(escapeAttr('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&#39;f', 'All special chars in one string');
