// @ts-check
/**
 * Workspace-settings barrel — single entry point for the
 * `.aieditor/settings.json` per-workspace overrides shipped in 1.4.4.
 *
 * @module intelligence/workspace-settings
 * @since 1.4.4
 */

export { SAFELIST, DENYLIST, isSafelisted, isDenylisted, filterToSafelisted } from './safelist.js';
export { serialize, parse, FILE_PATH } from './serializer.js';
export {
    enable,
    disable,
    loadFromGit,
    recordChanges,
    resetToGlobal,
    getPendingContent,
    listPendingPaths,
    discardPendingWrites,
    getDiagnostics,
    clearDiagnostics,
    isEnabled,
    getActiveWorkspaceId,
    getAppliedOverrides,
    getOriginalGlobal,
    getOriginalGlobals,
    isOptedIn,
    setOptedIn,
    installFileLayer,
    _setGitClientForTests,
    _setReapplyVisualSettingsForTests,
    _resetForTests,
} from './file-layer.js';
