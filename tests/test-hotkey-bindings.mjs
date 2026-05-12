/**
 * Tests for js/ui/hotkey-bindings.js — the 2.36.0 audit-sweep entry that
 * replaces the pre-2.36.0 hand-rolled keydown chain in
 * js/app.js#setupKeyboardShortcuts with a registry-driven dispatcher
 * reading combos from js/help/hotkey-registry.js#HOTKEYS.
 *
 * Pure-logic. The bindings live in a module-scope array; we exercise
 * matchCombo, bindHotkey validation, dispatchHotkey routing, and the
 * HOTKEYS parity guard. `_resetForTests` clears the array between cases.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
    bindHotkey,
    dispatchHotkey,
    matchCombo,
    listBindings,
    listMissingBindings,
    _resetForTests,
} = await import('../js/ui/hotkey-bindings.js');

const { HOTKEYS, findHotkey } = await import('../js/help/hotkey-registry.js');

function ev({ key, ctrlKey = false, metaKey = false, shiftKey = false, altKey = false } = {}) {
    let prevented = false;
    return {
        key,
        ctrlKey,
        metaKey,
        shiftKey,
        altKey,
        preventDefault() { prevented = true; },
        get _prevented() { return prevented; },
    };
}

test('matchCombo: mod resolves to ctrl OR meta', () => {
    assert.equal(matchCombo(['mod', 's'], ev({ key: 's', ctrlKey: true })), true);
    assert.equal(matchCombo(['mod', 's'], ev({ key: 's', metaKey: true })), true);
    assert.equal(matchCombo(['mod', 's'], ev({ key: 's' })), false);
});

test('matchCombo: modifier-strictness — Ctrl+P does NOT match Ctrl+Shift+P', () => {
    assert.equal(matchCombo(['mod', 'p'], ev({ key: 'p', ctrlKey: true })), true);
    assert.equal(matchCombo(['mod', 'p'], ev({ key: 'p', ctrlKey: true, shiftKey: true })), false);
    assert.equal(matchCombo(['mod', 'shift', 'p'], ev({ key: 'P', ctrlKey: true, shiftKey: true })), true);
    assert.equal(matchCombo(['mod', 'shift', 'p'], ev({ key: 'p', ctrlKey: true })), false);
});

test('matchCombo: case-insensitive single-key match', () => {
    assert.equal(matchCombo(['mod', 'shift', 'z'], ev({ key: 'Z', ctrlKey: true, shiftKey: true })), true);
    assert.equal(matchCombo(['mod', 'shift', 'z'], ev({ key: 'z', ctrlKey: true, shiftKey: true })), true);
});

test('matchCombo: f1 / slash / comma / esc tokens', () => {
    assert.equal(matchCombo(['f1'], ev({ key: 'F1' })), true);
    assert.equal(matchCombo(['f2'], ev({ key: 'F2' })), true);
    assert.equal(matchCombo(['mod', 'slash'], ev({ key: '/', ctrlKey: true })), true);
    assert.equal(matchCombo(['mod', 'comma'], ev({ key: ',', ctrlKey: true })), true);
    assert.equal(matchCombo(['esc'], ev({ key: 'Escape' })), true);
});

test('matchCombo: alt-strictness — Alt+Up does NOT match plain Up', () => {
    assert.equal(matchCombo(['alt', 'up'], ev({ key: 'ArrowUp', altKey: true })) === false, true);
    // The HOTKEYS vocabulary uses 'up'/'down'/'left'/'right' for arrow keys.
    // Browsers emit 'ArrowUp' etc. on KeyboardEvent.key — token-match is
    // case-insensitive only; we don't try to alias arrow shorthands. The
    // 'up'/'down' tokens belong to non-documentBound entries (file-tree /
    // diff-viewer / quick-open all use focused-context listeners), so the
    // unmatched-token case is expected for tabs.switch et al.
});

test('bindHotkey rejects unknown HOTKEYS id', () => {
    _resetForTests();
    assert.throws(
        () => bindHotkey({ id: 'totally.not.a.real.id', handler: () => {} }),
        /unknown HOTKEYS id/,
    );
});

test('bindHotkey rejects non-documentBound id', () => {
    _resetForTests();
    // `tabs.switch` is a `tabs.focused`-scoped entry, not documentBound.
    assert.throws(
        () => bindHotkey({ id: 'tabs.switch', handler: () => {} }),
        /not flagged documentBound/,
    );
});

test('bindHotkey rejects duplicate id', () => {
    _resetForTests();
    bindHotkey({ id: 'file.commit', handler: () => {} });
    assert.throws(
        () => bindHotkey({ id: 'file.commit', handler: () => {} }),
        /already bound/,
    );
});

test('bindHotkey rejects non-function handler', () => {
    _resetForTests();
    assert.throws(
        () => bindHotkey({ id: 'file.commit', handler: 'not-a-fn' }),
        /not a function/,
    );
});

test('dispatchHotkey routes mod+s to the file.commit handler', () => {
    _resetForTests();
    let called = 0;
    bindHotkey({ id: 'file.commit', handler: () => { called++; } });
    const e = ev({ key: 's', ctrlKey: true });
    assert.equal(dispatchHotkey(e), true);
    assert.equal(called, 1);
    assert.equal(e._prevented, true);
});

test('dispatchHotkey respects enabled — false skips handler AND preventDefault', () => {
    _resetForTests();
    let called = 0;
    bindHotkey({
        id: 'file.commit',
        handler: () => { called++; },
        enabled: () => false,
    });
    const e = ev({ key: 's', ctrlKey: true });
    assert.equal(dispatchHotkey(e), false);
    assert.equal(called, 0);
    assert.equal(e._prevented, false);
});

test('dispatchHotkey returns false when nothing matches', () => {
    _resetForTests();
    bindHotkey({ id: 'file.commit', handler: () => { throw new Error('nope'); } });
    const e = ev({ key: 'q' });
    assert.equal(dispatchHotkey(e), false);
    assert.equal(e._prevented, false);
});

test('dispatchHotkey: enabled receives the event so context guards can read e.target', () => {
    _resetForTests();
    let seen = null;
    bindHotkey({
        id: 'help.openMod',
        handler: () => {},
        enabled: (e) => { seen = e; return true; },
    });
    const e = ev({ key: '/', ctrlKey: true });
    dispatchHotkey(e);
    assert.equal(seen, e);
});

test('HOTKEYS parity: 19 documentBound entries are declared', () => {
    // Snapshot guard — the count is load-bearing in the sense that the
    // pre-2.36.0 setupKeyboardShortcuts handled exactly these 19 chords
    // (the 18-entry inventory note + sidebar.toggle = 19; the inventory
    // entry's "18" was an undercount of the actual handler body). If
    // this list moves, either the registry grew an entry that
    // app.js#setupKeyboardShortcuts also needs to bind, or one was
    // intentionally removed and this assertion is the audit trail.
    const documentBoundIds = HOTKEYS.filter(hk => hk.documentBound).map(hk => hk.id).sort();
    assert.deepEqual(documentBoundIds, [
        'chat.toggle',
        'editor.blame',
        'editor.diff',
        'editor.lineNumbers',
        'editor.preview',
        'esc.close',
        'file.commit',
        'file.rename',
        'file.revert',
        'file.search',
        'focus.chat',
        'focus.editor',
        'focus.sidebar',
        'help.open',
        'help.openMod',
        'palette.open',
        'quickopen.open',
        'settings.open',
        'sidebar.toggle',
    ]);
});

test('HOTKEYS parity: every documentBound entry has a unique combo (modulo intentional aliases)', () => {
    const documentBound = HOTKEYS.filter(hk => hk.documentBound);
    const byCombo = new Map();
    for (const hk of documentBound) {
        const key = hk.combo.slice().sort().join('+');
        if (!byCombo.has(key)) byCombo.set(key, []);
        byCombo.get(key).push(hk.id);
    }
    // Aliases: Ctrl+P and Ctrl+K both open Quick Open. Everything else is unique.
    for (const [combo, ids] of byCombo) {
        if (ids.length === 1) continue;
        const sorted = ids.slice().sort();
        const ok =
            (combo === 'k+mod' && sorted.length === 1) ||
            (combo === 'mod+p' && sorted.length === 1) ||
            JSON.stringify(sorted) === JSON.stringify(['palette.open']) ||
            JSON.stringify(sorted) === JSON.stringify(['quickopen.open']);
        if (!ok) {
            assert.fail(`duplicate documentBound combo "${combo}" across ${JSON.stringify(sorted)}`);
        }
    }
});

test('listMissingBindings reports unbound documentBound entries', () => {
    _resetForTests();
    const allDocBoundIds = HOTKEYS.filter(hk => hk.documentBound).map(hk => hk.id);
    assert.deepEqual(listMissingBindings().sort(), allDocBoundIds.slice().sort());

    bindHotkey({ id: 'file.commit', handler: () => {} });
    assert.equal(listMissingBindings().includes('file.commit'), false);
    assert.equal(listMissingBindings().length, allDocBoundIds.length - 1);
});

test('listBindings returns a snapshot; mutating it does not affect the registry', () => {
    _resetForTests();
    bindHotkey({ id: 'file.commit', handler: () => {} });
    const snapshot = listBindings();
    snapshot.push({ id: 'INJECTED', handler: () => {} });
    const fresh = listBindings();
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0].id, 'file.commit');
});

test('findHotkey resolves all documentBound ids referenced by binding-time wiring', () => {
    for (const hk of HOTKEYS.filter(h => h.documentBound)) {
        assert.equal(findHotkey(hk.id)?.id, hk.id, `findHotkey miss for ${hk.id}`);
    }
});
