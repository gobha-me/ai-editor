/**
 * Tests for blame feature — validates module exports and blame data shape normalization.
 * These are structure/smoke tests since blame requires a live git server for integration testing.
 */
import { Git } from '../js/git.js';

const { T } = window;

T.suite('Blame — Git Facade Exports');

T.assert(typeof Git.getBlame === 'function', 'Git.getBlame is exported');
T.assert(typeof Git.getFileCommits === 'function', 'Git.getFileCommits is exported');

// These should throw "No project is currently loaded" since no project is active
T.suite('Blame — Guard Checks (no project loaded)');

await T.throwsAsync(
    () => Git.getBlame('owner', 'repo', 'test.js', 'main'),
    'getBlame throws when no project loaded'
);

await T.throwsAsync(
    () => Git.getFileCommits('owner', 'repo', 'test.js', 'main'),
    'getFileCommits throws when no project loaded'
);

T.suite('Blame — Secondary Pane Integration');

// Load the real editor fragment and assert the shipped DOM contract rather
// than granting a no-op pass because the test runner is not the app shell.
const editorResponse = await fetch('../html/editor-panel.html');
T.assert(editorResponse.ok, 'editor panel fragment is available locally');
const editorDocument = new DOMParser().parseFromString(await editorResponse.text(), 'text/html');
const btnBlame = editorDocument.getElementById('btnToggleBlame');
T.assert(btnBlame instanceof HTMLButtonElement, 'blame control is a real button in the editor toolbar');
T.eq(btnBlame?.getAttribute('type'), 'button', 'blame button cannot submit a surrounding form');
T.eq(btnBlame?.getAttribute('aria-label'), 'Toggle blame view', 'blame button has an accessible label');

// Import blame toggle to verify it's exported
try {
    const mod = await import('../js/secondary-pane.js');
    T.assert(typeof mod.toggleBlamePane === 'function', 'toggleBlamePane is exported from secondary-pane');
    T.assert(typeof mod.getSecondaryPaneMode === 'function', 'getSecondaryPaneMode is exported');
} catch (e) {
    T.assert(false, `secondary-pane import failed: ${e.message}`);
}
