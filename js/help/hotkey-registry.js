/**
 * Hotkey registry — single source of truth for shortcut combos.
 *
 * Drives both surfaces:
 *   - The Help page's hotkeys list (display contract).
 *   - The document-level keydown dispatcher in `js/ui/hotkey-bindings.js`,
 *     wired by `js/app.js#setupKeyboardShortcuts` (2.36.0 consolidation).
 *
 * Entries flagged `documentBound: true` are bound at the document level
 * via `bindHotkey({ id, handler, enabled? })`; the dispatcher reads the
 * `combo` here when matching events. Entries without the flag are
 * CodeMirror-bound (editor.comment), tabs/tree/quick-open/plugin-editor
 * focused-context listeners, or vim-mode bindings — their handlers live
 * in CM extensions / panel-local listeners and the registry describes
 * them informationally via `when?`.
 *
 * Combo tokens match the Kbd vocabulary in `js/help/kbd.js` (mod / shift
 * / alt / enter / esc / tab / space / arrows / single chars). The `mod`
 * token resolves to ⌘ on mac and Ctrl elsewhere.
 *
 * Shape:
 *   id              unique identifier — one per shortcut
 *   group           display group on the Help page
 *   combo           array of Kbd tokens
 *   desc            one-line description
 *   when?           optional context (informational; CM/panel-scoped
 *                   entries use this to describe the scope)
 *   documentBound?  true if `setupKeyboardShortcuts` calls bindHotkey for
 *                   this id; drives both runtime dispatch and the CI
 *                   parity check in tests/test-hotkey-bindings.mjs
 */

/** @typedef {{
 *   id: string,
 *   group: string,
 *   combo: string[],
 *   desc: string,
 *   when?: string,
 *   documentBound?: boolean
 * }} HotkeyEntry */

/** @type {HotkeyEntry[]} */
export const HOTKEYS = [
    // Global
    { id: 'help.open',           group: 'Global',  combo: ['f1'],                 desc: 'Show this help panel', documentBound: true },
    { id: 'help.openMod',        group: 'Global',  combo: ['mod', 'slash'],       desc: 'Toggle help', when: 'editor.unfocused', documentBound: true },
    // 1.3.6 Phase 1: ⌘K is the command-surface entry point but currently
    // aliases the ⌘P quick-open overlay. Commands and settings/help search
    // accrete onto it in 1.3.7+; until then the desc reflects what it does
    // today rather than what the design canvas calls it.
    { id: 'palette.open',        group: 'Global',  combo: ['mod', 'k'],           desc: 'Open quick search (command palette stub)', documentBound: true },
    { id: 'quickopen.open',      group: 'Global',  combo: ['mod', 'p'],           desc: 'Quick-open file', documentBound: true },
    { id: 'settings.open',       group: 'Global',  combo: ['mod', 'comma'],       desc: 'Open settings', documentBound: true },
    { id: 'sidebar.toggle',      group: 'Global',  combo: ['mod', 'b'],           desc: 'Toggle sidebar', documentBound: true },
    { id: 'chat.toggle',         group: 'Global',  combo: ['mod', 'j'],           desc: 'Toggle chat panel', documentBound: true },
    { id: 'esc.close',           group: 'Global',  combo: ['esc'],                desc: 'Close panel / modal / quick-open', documentBound: true },

    // Panel focus
    { id: 'focus.sidebar',       group: 'Panel focus', combo: ['mod', '1'],       desc: 'Focus sidebar', documentBound: true },
    { id: 'focus.editor',        group: 'Panel focus', combo: ['mod', '2'],       desc: 'Focus editor', documentBound: true },
    { id: 'focus.chat',          group: 'Panel focus', combo: ['mod', '3'],       desc: 'Focus chat input', documentBound: true },

    // Files
    { id: 'file.commit',         group: 'Files',   combo: ['mod', 's'],           desc: 'Open commit modal', documentBound: true },
    { id: 'file.search',         group: 'Files',   combo: ['mod', 'shift', 'f'],  desc: 'Search in project', documentBound: true },
    { id: 'file.revert',         group: 'Files',   combo: ['mod', 'shift', 'z'],  desc: 'Revert file(s)', documentBound: true },
    { id: 'file.rename',         group: 'Files',   combo: ['f2'],                 desc: 'Rename / move current file', documentBound: true },

    // Editor
    { id: 'editor.preview',      group: 'Editor',  combo: ['mod', 'shift', 'p'],  desc: 'Toggle preview pane', documentBound: true },
    { id: 'editor.diff',         group: 'Editor',  combo: ['mod', 'shift', 'd'],  desc: 'Toggle diff view', documentBound: true },
    { id: 'editor.blame',        group: 'Editor',  combo: ['mod', 'shift', 'b'],  desc: 'Toggle blame / file history', documentBound: true },
    { id: 'editor.lineNumbers',  group: 'Editor',  combo: ['mod', 'shift', 'l'],  desc: 'Toggle line numbers', documentBound: true },
    { id: 'editor.comment',      group: 'Editor',  combo: ['mod', 'slash'],       desc: 'Toggle line comment', when: 'editor.focused' },

    // Editor tabs
    { id: 'tabs.switch',         group: 'Editor tabs', combo: ['left'],           desc: 'Previous tab', when: 'tabs.focused' },
    { id: 'tabs.switchNext',     group: 'Editor tabs', combo: ['right'],          desc: 'Next tab', when: 'tabs.focused' },
    { id: 'tabs.first',          group: 'Editor tabs', combo: ['home'],           desc: 'First tab', when: 'tabs.focused' },
    { id: 'tabs.last',           group: 'Editor tabs', combo: ['end'],            desc: 'Last tab', when: 'tabs.focused' },
    { id: 'tabs.close',          group: 'Editor tabs', combo: ['delete'],         desc: 'Close current tab', when: 'tabs.focused' },

    // File tree
    { id: 'tree.up',             group: 'File tree', combo: ['up'],               desc: 'Previous file', when: 'tree.focused' },
    { id: 'tree.down',           group: 'File tree', combo: ['down'],             desc: 'Next file', when: 'tree.focused' },
    { id: 'tree.expand',         group: 'File tree', combo: ['right'],            desc: 'Expand folder', when: 'tree.focused' },
    { id: 'tree.collapse',       group: 'File tree', combo: ['left'],             desc: 'Collapse folder / go to parent', when: 'tree.focused' },
    { id: 'tree.open',           group: 'File tree', combo: ['enter'],            desc: 'Open file / toggle folder', when: 'tree.focused' },

    // Diff viewer
    { id: 'diff.next',           group: 'Diff viewer', combo: ['alt', 'down'],    desc: 'Next change' },
    { id: 'diff.prev',           group: 'Diff viewer', combo: ['alt', 'up'],      desc: 'Previous change' },
    { id: 'diff.toggleView',     group: 'Diff viewer', combo: ['v'],              desc: 'Toggle unified / split view' },

    // Chat
    { id: 'chat.send',           group: 'Chat',    combo: ['enter'],              desc: 'Send message', when: 'chat.focused' },
    { id: 'chat.newline',        group: 'Chat',    combo: ['shift', 'enter'],     desc: 'New line in chat', when: 'chat.focused' },

    // Quick open
    { id: 'qo.up',               group: 'Quick open', combo: ['up'],              desc: 'Previous result', when: 'quickopen.focused' },
    { id: 'qo.down',             group: 'Quick open', combo: ['down'],            desc: 'Next result', when: 'quickopen.focused' },
    { id: 'qo.open',             group: 'Quick open', combo: ['enter'],           desc: 'Open file (preview)', when: 'quickopen.focused' },
    { id: 'qo.openPinned',       group: 'Quick open', combo: ['shift', 'enter'],  desc: 'Open file (pinned tab)', when: 'quickopen.focused' },

    // Plugin editor
    { id: 'plugin.save',         group: 'Plugin editor', combo: ['mod', 's'],     desc: 'Save plugin source', when: 'pluginEditor.focused' },
    { id: 'plugin.hotReload',    group: 'Plugin editor', combo: ['mod', 'enter'], desc: 'Save & hot-reload plugin', when: 'pluginEditor.focused' },

    // Vim mode (when keybinding mode = vim)
    { id: 'vim.normal',          group: 'Vim mode', combo: ['esc'],               desc: 'Enter normal mode', when: 'vim' },
    { id: 'vim.insert',          group: 'Vim mode', combo: ['i'],                 desc: 'Insert before cursor', when: 'vim.normal' },
    { id: 'vim.append',          group: 'Vim mode', combo: ['a'],                 desc: 'Append after cursor', when: 'vim.normal' },
    { id: 'vim.visual',          group: 'Vim mode', combo: ['v'],                 desc: 'Visual mode (charwise)', when: 'vim.normal' },
    { id: 'vim.delLine',         group: 'Vim mode', combo: ['d', 'd'],            desc: 'Delete (cut) line', when: 'vim.normal' },
    { id: 'vim.yankLine',        group: 'Vim mode', combo: ['y', 'y'],            desc: 'Yank line', when: 'vim.normal' },
    { id: 'vim.paste',           group: 'Vim mode', combo: ['p'],                 desc: 'Paste after cursor', when: 'vim.normal' },
    { id: 'vim.undo',            group: 'Vim mode', combo: ['u'],                 desc: 'Undo', when: 'vim.normal' },
    { id: 'vim.redo',            group: 'Vim mode', combo: ['mod', 'r'],          desc: 'Redo', when: 'vim.normal' },
    { id: 'vim.search',          group: 'Vim mode', combo: ['slash'],             desc: 'Search', when: 'vim.normal' },
    { id: 'vim.write',           group: 'Vim mode', combo: [':', 'w'],            desc: 'Save current file (commit modal)', when: 'vim.normal' },
];

/** Group entries by `.group`, preserving the order in HOTKEYS so the
 *  display order is deterministic (matches the order this file lists). */
export function hotkeysByGroup() {
    const groups = [];
    const byGroup = new Map();
    for (const hk of HOTKEYS) {
        if (!byGroup.has(hk.group)) {
            const bucket = { title: hk.group, keys: [] };
            byGroup.set(hk.group, bucket);
            groups.push(bucket);
        }
        byGroup.get(hk.group).keys.push(hk);
    }
    return groups;
}

export function findHotkey(id) {
    return HOTKEYS.find(hk => hk.id === id) || null;
}
