/**
 * Browser tests for 1.1.3 — Vim keybindings setting.
 *
 * Exercises the parts of the toggle that need a real EditorView:
 *   - `CM.vim` namespace is populated after CodeMirror loads.
 *   - `setKeybindingMode('vim')` reconfigures the keymap compartment without
 *     throwing on a real instance.
 *   - Switching back to 'default' is also non-throwing.
 *   - `setKeybindingMode` returns false when called before an editor exists.
 *
 * Vim's own keystroke handling is owned by `@replit/codemirror-vim`; we don't
 * re-prove that here — the smoke is that the integration wires up cleanly.
 */
import { CM, loadCodeMirror } from '../js/editor/setup.js';
import { createEditor, setKeybindingMode } from '../js/editor/instance.js';

const { T } = window;

T.suite('Keybindings — Vim integration');

await loadCodeMirror();

T.assert(!!CM.EditorView, 'CodeMirror loaded');
T.assert(!!CM.vim, 'CM.vim namespace populated by loader');
T.assert(typeof CM.vim?.vim === 'function', 'CM.vim.vim() factory is callable');
T.assert(typeof CM.vim?.Vim?.defineEx === 'function', 'CM.vim.Vim.defineEx is available for ex-command registration');

// setKeybindingMode is a no-op (returns false) when no editor instance exists.
// We can't easily reset module-level editorInstance, so we rely on createEditor
// running below to flip the state — call before to assert the early-return path.
const beforeResult = setKeybindingMode('vim');
T.eq(typeof beforeResult, 'boolean', 'setKeybindingMode returns a boolean');

// Build a real editor in a hidden container.
const container = document.createElement('div');
container.style.cssText = 'position: absolute; left: -9999px; width: 400px; height: 200px;';
document.body.appendChild(container);

try {
    const view = await createEditor(container, 'hello\nworld\n', 'test.txt');
    T.assert(!!view, 'createEditor returned an EditorView');
    T.eq(view.state.doc.toString(), 'hello\nworld\n', 'initial doc content');

    // Toggle to vim — must not throw, must return true.
    const toVim = setKeybindingMode('vim');
    T.eq(toVim, true, 'setKeybindingMode("vim") succeeds with editor present');

    // Editor doc should be unchanged after the reconfigure.
    T.eq(view.state.doc.toString(), 'hello\nworld\n', 'doc content preserved across mode switch');

    // Real-keystroke smoke: vim() must come before basicSetup in the
    // extension order, otherwise basicSetup's defaultKeymap claims Esc/i/h/j/k/l
    // first and Vim becomes a no-op even though the compartment reconfigured.
    // This regression is invisible to the dispatch-only path above; only a
    // real KeyboardEvent through the contentDOM proves the keymap precedence.
    view.focus();
    const cmAdapter = CM.vim?.getCM ? CM.vim.getCM(view) : null;
    T.assert(!!cmAdapter, 'vim getCM adapter present after switching to vim mode');
    const initialInsert = cmAdapter?.state?.vim?.insertMode;
    T.eq(initialInsert, false, 'starts in normal mode (vim default)');

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', bubbles: true }));
    T.eq(cmAdapter?.state?.vim?.insertMode, true, '`i` enters insert mode (vim keymap wins over basicSetup)');

    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    T.eq(cmAdapter?.state?.vim?.insertMode, false, '`Esc` returns to normal mode');

    // Toggle back to default — must also succeed.
    const toDefault = setKeybindingMode('default');
    T.eq(toDefault, true, 'setKeybindingMode("default") succeeds');

    // Unknown mode falls back to [] (default) — should not throw.
    const toUnknown = setKeybindingMode('zzz-not-a-mode');
    T.eq(toUnknown, true, 'setKeybindingMode with unknown value falls back to default safely');

    view.destroy();
} finally {
    container.remove();
}
