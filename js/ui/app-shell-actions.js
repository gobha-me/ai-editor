/**
 * App-Shell Delegated Actions
 *
 * Bind a single delegated click handler for non-modal action buttons rendered
 * into the editor-panel and chat-panel app-shell containers. Phase 2b of the
 * inline-handlers migration (DESIGN-ui-event-dispatch.md).
 *
 * Replicates the `mountCommitModal` (js/ui/commit.js:116) shape, scoped to
 * `.editor-panel, .chat-panel` since the buttons split across two top-level
 * panels and no other surface emits these actions.
 */

let _wired = false;
export function mountAppShellActions({
    onOpenSettings, onOpenZipUpload,
    onToggleSecondaryFullscreen, onCloseSecondaryPane,
    onOpenReplayModal,
} = {}) {
    if (_wired) return;
    _wired = true;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (!btn.closest('.editor-panel, .chat-panel')) return;
        const action = btn.getAttribute('data-action');
        if (action === 'openSettings' && typeof onOpenSettings === 'function') {
            onOpenSettings();
        } else if (action === 'openZipUpload' && typeof onOpenZipUpload === 'function') {
            onOpenZipUpload();
        } else if (action === 'toggleSecondaryFullscreen' && typeof onToggleSecondaryFullscreen === 'function') {
            onToggleSecondaryFullscreen();
        } else if (action === 'closeSecondaryPane' && typeof onCloseSecondaryPane === 'function') {
            onCloseSecondaryPane();
        } else if (action === 'openReplayModal' && typeof onOpenReplayModal === 'function') {
            onOpenReplayModal();
        }
    });
}
