/**
 * Tests for chat handler pure functions — detectIntent, _briefError.
 * These functions drive the chat routing and error display.
 */
import { detectIntent, _briefError } from '../js/chat/handlers.js';
import { State } from '../js/core.js';

const { T } = window;

// ============================================
// detectIntent — Commit
// ============================================

T.suite('detectIntent — Commit');

T.eq(detectIntent('generate a commit message'), 'commit', '"generate commit" → commit');
T.eq(detectIntent('write a commit message for these changes'), 'commit', '"commit message" → commit');
T.eq(detectIntent('Can you create a commit message?'), 'commit', 'Polite commit request');

// ============================================
// detectIntent — Issue
// ============================================

T.suite('detectIntent — Issue');

T.eq(detectIntent('work on issue #42'), 'issue', '"work on issue #" → issue');
T.eq(detectIntent('implement issue #7'), 'issue', '"implement issue #" → issue');
// "find issue" should NOT be issue intent
T.eq(detectIntent('find issue #42 and search for related code'), 'general', '"find issue" → general (not issue)');
// "create issue" should NOT be issue intent
T.eq(detectIntent('create issue for this bug'), 'general', '"create issue" → general');

// ============================================
// detectIntent — Edit (requires open file)
// ============================================

T.suite('detectIntent — Edit (file open)');

const origFile = State.currentFile;
State.currentFile = { path: 'test.js', content: 'const x = 1;' };

T.eq(detectIntent('edit this function'), 'edit', '"edit" with file open → edit');
T.eq(detectIntent('change the variable name'), 'edit', '"change" → edit');
T.eq(detectIntent('modify the return value'), 'edit', '"modify" → edit');
T.eq(detectIntent('refactor this class'), 'edit', '"refactor" → edit');
T.eq(detectIntent('rewrite the error handling'), 'edit', '"rewrite" → edit');
T.eq(detectIntent('fix the bug on line 5'), 'edit', '"fix" weak signal → edit');
T.eq(detectIntent('add error handling'), 'edit', '"add" weak signal → edit');
T.eq(detectIntent('remove the console.log'), 'edit', '"remove" weak signal → edit');

// Weak signals should NOT trigger edit when disambiguating words present
T.eq(detectIntent('find where the bug is'), 'general', '"find" blocks weak edit signal');
T.eq(detectIntent('search for the function'), 'general', '"search" blocks weak edit signal');
T.eq(detectIntent('fix the file structure'), 'general', '"file" blocks weak edit signal');
T.eq(detectIntent('can you add a test?'), 'general', '"can you" blocks weak edit signal');
T.eq(detectIntent('where should I add this?'), 'general', '"where" blocks weak edit signal');
T.eq(detectIntent('review my changes'), 'general', '"review" blocks weak edit signal');
T.eq(detectIntent('think about how to fix this'), 'general', '"think" blocks weak edit signal');
T.eq(detectIntent('which files need updating?'), 'general', '"which" blocks weak edit signal');

State.currentFile = origFile;

// ============================================
// detectIntent — Edit (no file open)
// ============================================

T.suite('detectIntent — Edit (no file)');

State.currentFile = null;

// Without a file open, edit keywords should route to general
T.eq(detectIntent('edit the config file'), 'general', '"edit" without file → general');
T.eq(detectIntent('fix the bug'), 'general', '"fix" without file → general');
T.eq(detectIntent('refactor the utils'), 'general', '"refactor" without file → general');

State.currentFile = origFile;

// ============================================
// detectIntent — Explain
// ============================================

T.suite('detectIntent — Explain');

T.eq(detectIntent('explain this function'), 'explain', '"explain" → explain');
T.eq(detectIntent('what does this code do?'), 'explain', '"what does" → explain');
T.eq(detectIntent('how does the parser work?'), 'explain', '"how does" → explain');
T.eq(detectIntent('why does this return null?'), 'explain', '"why does" → explain');
T.eq(detectIntent('help me understand the flow'), 'explain', '"understand" → explain');

// "understanding" should NOT match (word boundary)
T.eq(detectIntent('I have a good understanding of this, now fix it'), 'general',
    '"understanding" is not "understand" (word boundary)');

// ============================================
// detectIntent — General (fallback)
// ============================================

T.suite('detectIntent — General');

T.eq(detectIntent('hello'), 'general', 'Generic greeting → general');
T.eq(detectIntent('what files are in this project?'), 'general', 'Project question → general');
T.eq(detectIntent('list all the dependencies'), 'general', 'List request → general');
T.eq(detectIntent('create a new test file'), 'general', 'Create request → general');

// ============================================
// _briefError
// ============================================

T.suite('_briefError — Message Extraction');

T.eq(_briefError(new Error('simple error')), 'simple error', 'Simple Error message');
T.eq(_briefError({ message: 'object error' }), 'object error', 'Object with message');
T.eq(_briefError('string error'), 'string error', 'String error');

T.suite('_briefError — JSON Extraction');

const jsonErr = new Error('LLM stream error: ConnectionError: {"message":"rate limit exceeded","code":429}');
T.eq(_briefError(jsonErr), 'rate limit exceeded', 'Extracts message from JSON wrapper');

T.suite('_briefError — Truncation');

const longMsg = 'A'.repeat(200);
const brief = _briefError(new Error(longMsg));
T.assert(brief.length <= 120, `Long message truncated to ≤120 chars (got ${brief.length})`);
T.assert(brief.endsWith('…'), 'Truncated message ends with ellipsis');

T.suite('_briefError — Edge Cases');

// new Error('').message is '' (falsy) → falls through to String(err) → "Error"
T.eq(_briefError(new Error('')), 'Error', 'Empty Error message falls through to String coercion');
T.eq(_briefError({}), '[object Object]', 'Object without message stringifies');
T.eq(_briefError(42), '42', 'Number error stringifies');
