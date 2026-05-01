/**
 * Ghost-text smoke tests (1.4.7) — browser-driven.
 *
 * Validates the public surface of the ghost-text module without a full
 * editor mount. Decoration rendering + keymap dispatch are exercised by
 * manual verification (per the 1.4.7 plan); a CodeMirror instance is too
 * heavy for the in-page test harness.
 *
 * Pure helpers + state-machine math live in `tests/test-ghost-text.mjs`
 * and run under `node --test`.
 */

const { T } = window;

T.suite('Ghost text — module exports');

const gt = await import('../js/editor/ghost-text.js');
T.assert(typeof gt.getGhostTextCompartment === 'function', 'getGhostTextCompartment exported');
T.assert(typeof gt.buildGhostTextExtension === 'function', 'buildGhostTextExtension exported');
T.assert(typeof gt.refreshGhostTextExtension === 'function', 'refreshGhostTextExtension exported');
T.assert(typeof gt.triggerCompletion === 'function', 'triggerCompletion exported');
T.assert(typeof gt.acceptCompletion === 'function', 'acceptCompletion exported');
T.assert(typeof gt.dismissCompletion === 'function', 'dismissCompletion exported');
T.assert(typeof gt.getGhostTextSettings === 'function', 'getGhostTextSettings exported');
T.assert(typeof gt.isAtIndentContext === 'function', 'isAtIndentContext exported');
T.assert(typeof gt.isGhostTextDisabledByFlag === 'function', 'isGhostTextDisabledByFlag exported');

T.suite('Ghost text — defaults');

const d = gt.GHOST_TEXT_DEFAULTS;
T.assert(d.enabled === false, 'disabled by default');
T.assert(d.hotkey === 'Tab', 'Tab is the default hotkey');
T.assert(d.maxTokens === 150, 'default maxTokens=150');
T.assert(d.contextLines === 40, 'default contextLines=40');
T.assert(d.model === '', 'default model = empty (inherit llmModel)');

T.suite('Ghost text — disabled feature returns empty extension');

// Without any State.settings.ghostText, buildGhostTextExtension returns [].
const ext = gt.buildGhostTextExtension();
T.assert(Array.isArray(ext), 'buildGhostTextExtension returns an array');
T.assert(ext.length === 0, 'feature off ⇒ zero-cost compartment ([])');

T.suite('Ghost text — URL flag kill switch');

T.assert(typeof gt.isGhostTextDisabledByFlag() === 'boolean', 'kill-switch returns boolean');

T.suite('Ghost text — completion module exports');

const comp = await import('../js/llm/completion.js');
T.assert(typeof comp.requestGhostTextCompletion === 'function', 'requestGhostTextCompletion exported');
T.assert(typeof comp.sliceContextAroundCursor === 'function', 'sliceContextAroundCursor exported');
T.assert(typeof comp.cleanCompletionResponse === 'function', 'cleanCompletionResponse exported');
T.assert(typeof comp.buildGhostTextSystemPrompt === 'function', 'buildGhostTextSystemPrompt exported');

// One round-trip through the pure helpers to confirm the imports actually wire up.
const { prefix, suffix } = comp.sliceContextAroundCursor('one\ntwo\nthree', 4, 5);
T.assert(prefix === 'one\n', 'sliceContextAroundCursor: prefix');
T.assert(suffix === 'two\nthree', 'sliceContextAroundCursor: suffix');

T.suite('Ghost text — indent context detection');

T.assert(gt.isAtIndentContext('    ', 4) === true, 'whitespace-only line → indent context');
T.assert(gt.isAtIndentContext('const x = 1', 11) === false, 'mid-line code → not indent context');
T.assert(gt.isAtIndentContext('', 0) === true, 'empty doc → indent context');
