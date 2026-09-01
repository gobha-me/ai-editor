/**
 * Tests for the sub-agent approval card's mount lifecycle, capability
 * summary rendering, and resolution paths from docs/DESIGN-sub-agents.md.
 *
 * Browser-only because the card is a Preact component (Decision §9)
 * and the lifecycle wrapper subscribes to EventBus events that must
 * dispatch synchronously through the live DOM.
 *
 * Pins:
 *   - Card mounts on `subagent_approval:pending` with the right slot
 *     class + position.
 *   - Capability summary surface — profile, admitted tools, ceilings,
 *     memory ✗ / write-access ✗ rows are present.
 *   - **Profile-override fixture (DESIGN §Risks "high severity, trust
 *     failure"):** when the parent passes `profile: 'coder.v1'`, the
 *     write-access row flips to ✓ with the warning class on the card
 *     root. This is the security-load-bearing assertion.
 *   - Reject resolves the Promise with `{status: 'rejected', feedback}`.
 *   - External cancel resolves the Promise with cancelled envelope.
 *
 * Top-level await throughout — the test runner only awaits the module
 * import (not nested IIFEs), so each assertion sequence must run to
 * completion before the next `import('./test-…')` fires.
 */
import {
    initChatState,
    setPendingSubAgentApproval,
    cancelSubAgentApproval,
} from '../js/chat/state.js';
import { initSubAgentApprovalCard, _isMounted } from '../js/chat/subagent-approval-card.js';
import { buildCapabilitySummary } from '../js/chat/subagent-runner.js';
import { ToolRegistry } from '../js/tools/registry.js';

// 2.49.0 — register the write-class fixture tools the
// `buildCapabilitySummary({profileName: 'coder.v1'})` capability summary
// needs to surface a non-empty `writeTools` list. Avoids importing the
// full `js/chat/index.js` module which side-effects-loads scratchpad
// panel + other subsystems and can interfere with later tests.
{
    const reg = (name, roles = 'all') => ToolRegistry.register(
        name, async () => ({}),
        {
            function: { name, description: `Fixture tool ${name}.`, parameters: { type: 'object', properties: {} } },
            roles,
        }
    );
    // Coder.v1's read-class baseline.
    reg('read_file');
    reg('read_lines');
    reg('scan_file');
    reg('list_dirty_files');
    // Coder.v1's write-class admits — these are what `WRITE_TOOL_NAMES`
    // in the runner expects so the capability summary's writeTools list
    // is non-empty for the coder.v1 override fixture.
    reg('edit_file', ['coder']);
    reg('commit_files', ['coder']);
    reg('replace_lines', ['coder']);
    reg('insert_lines', ['coder']);
    reg('delete_lines', ['coder']);
}

const { T } = window;

// ============================================================================
// Container setup
// ============================================================================

function setupContainer() {
    let container = document.getElementById('test-subagent-approval-messages');
    if (container) {
        container.innerHTML = '';
        return container;
    }
    container = document.createElement('div');
    container.id = 'test-subagent-approval-messages';
    container.className = 'chat-messages';
    container.style.height = '600px';
    container.style.overflowY = 'auto';
    container.style.position = 'relative';
    document.body.appendChild(container);

    const input = document.createElement('textarea');
    input.style.display = 'none';
    document.body.appendChild(input);

    initChatState(container, input);
    initSubAgentApprovalCard();
    return container;
}

/**
 * Wait until the lifecycle wrapper has *both* mounted the slot AND the
 * Preact tree has committed (`.subagent-approval-card` is in the DOM).
 * `_isMounted()` only checks the slot — Preact's first paint happens
 * after `mountPreact`'s async import + render, so we additionally poll
 * for the card element. Loose-enough timeout for the test-framework
 * boot path which loads many modules in parallel.
 */
async function waitForMount(container, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (_isMounted() && container.querySelector('.subagent-approval-card')) return;
        await new Promise(r => setTimeout(r, 20));
    }
}

async function waitForUnmount(timeoutMs = 1500) {
    const start = Date.now();
    while (_isMounted() && Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 20));
    }
}

// ============================================================================
// 1. Card mounts on subagent_approval:pending
// ============================================================================

T.suite('Sub-agent approval card — mount lifecycle');
{
    const container = setupContainer();

    let resolved = null;
    setPendingSubAgentApproval({
        transcriptId: 'sa-test-1',
        task: 'find every call site of parseConfig',
        contextHint: 'check src/ first',
        profileName: 'subagent.v1',
        capabilitySummary: buildCapabilitySummary({ profileName: 'subagent.v1' }),
        resolve: (v) => { resolved = v; },
    });
    await waitForMount(container);

    const slot = container.querySelector('.subagent-approval-slot');
    T.assert(slot, 'slot mounted in chat container');

    const card = slot?.querySelector('.subagent-approval-card');
    T.assert(card, 'card root rendered inside slot');

    const rejectBtn = card?.querySelector('.subagent-approval-card__reject');
    T.assert(rejectBtn, 'Reject button present in review state');
    rejectBtn?.click();
    await waitForUnmount();

    T.assert(!_isMounted(), 'card unmounted after Reject');
    T.assert(resolved?.status === 'rejected',
        `Promise resolved with rejected envelope (got: ${JSON.stringify(resolved)})`);
}

// ============================================================================
// 2. Capability summary — subagent.v1 (default) shows read-only state
// ============================================================================

T.suite('Sub-agent approval card — capability summary (default subagent.v1)');
{
    const container = setupContainer();

    setPendingSubAgentApproval({
        transcriptId: 'sa-test-2',
        task: 'small task',
        profileName: 'subagent.v1',
        capabilitySummary: buildCapabilitySummary({ profileName: 'subagent.v1' }),
        resolve: () => {},
    });
    await waitForMount(container);

    const card = container.querySelector('.subagent-approval-card');
    T.assert(card, 'card mounted');

    const profilePill = card?.querySelector('.subagent-approval-card__profile-pill');
    T.assert(profilePill?.textContent?.trim() === 'subagent.v1',
        `profile pill shows subagent.v1 (got: ${profilePill?.textContent})`);

    const writeRow = Array.from(card?.querySelectorAll('tr') || []).find(
        tr => tr.querySelector('th')?.textContent?.includes('Write access'),
    );
    T.assert(writeRow, 'Write access row present');
    T.assert(writeRow?.querySelector('.subagent-approval-card__ok'),
        'subagent.v1: write-access ✗ in OK style (no warning)');
    T.assert(!card?.classList.contains('subagent-approval-card--write-warning'),
        'subagent.v1: card root does NOT carry write-warning class');

    const memoryRow = Array.from(card?.querySelectorAll('tr') || []).find(
        tr => tr.querySelector('th')?.textContent?.includes('Memory writes'),
    );
    T.assert(memoryRow?.querySelector('.subagent-approval-card__ok'),
        'subagent.v1: memory writes ✗ in OK style');

    cancelSubAgentApproval();
    await waitForUnmount();
}

// ============================================================================
// 3. PROFILE OVERRIDE — coder.v1 flips Write access to ✓ with warning class
//    (DESIGN §Risks High-severity trust failure mitigation)
// ============================================================================

T.suite('Sub-agent approval card — profile override surfaces write-access warning (DESIGN §Risks)');
{
    const container = setupContainer();

    const cap = buildCapabilitySummary({ profileName: 'coder.v1' });
    T.assert(cap.writeTools.length > 0,
        `coder.v1 admits write tools (got: ${cap.writeTools.join(', ') || '(none)'})`);

    setPendingSubAgentApproval({
        transcriptId: 'sa-test-3',
        task: 'overrides profile to coder.v1',
        profileName: 'coder.v1',
        capabilitySummary: cap,
        resolve: () => {},
    });
    await waitForMount(container);

    const card = container.querySelector('.subagent-approval-card');
    T.assert(card, 'card mounted on coder.v1 override');

    const profilePill = card?.querySelector('.subagent-approval-card__profile-pill');
    T.assert(profilePill?.textContent?.trim() === 'coder.v1',
        `profile pill shows coder.v1 (got: ${profilePill?.textContent})`);

    T.assert(card?.classList.contains('subagent-approval-card--write-warning'),
        'coder.v1 override: card root carries write-warning class');

    const writeRow = Array.from(card?.querySelectorAll('tr') || []).find(
        tr => tr.querySelector('th')?.textContent?.includes('Write access'),
    );
    T.assert(writeRow?.classList.contains('subagent-approval-card__cap-row--warn'),
        'coder.v1 override: write-access row has warning class');
    T.assert(writeRow?.querySelector('.subagent-approval-card__warn'),
        'coder.v1 override: write-access ✓ rendered in warn style');
    T.assert(writeRow?.textContent?.includes('can mutate the workspace'),
        'coder.v1 override: explicit warning text present');

    cancelSubAgentApproval();
    await waitForUnmount();
}

// ============================================================================
// 4. Reject path resolves with feedback
// ============================================================================

T.suite('Sub-agent approval card — Reject path resolves with feedback');
{
    const container = setupContainer();

    let resolved = null;
    setPendingSubAgentApproval({
        transcriptId: 'sa-test-4',
        task: 'wrong scope',
        profileName: 'subagent.v1',
        capabilitySummary: buildCapabilitySummary({ profileName: 'subagent.v1' }),
        resolve: (v) => { resolved = v; },
    });
    await waitForMount(container);

    const card = container.querySelector('.subagent-approval-card');
    const feedbackEl = card?.querySelector('.subagent-approval-card__feedback');
    T.assert(feedbackEl, 'feedback textarea present');
    if (feedbackEl) {
        // Preact's onInput handler reads `e.currentTarget.value`. We set
        // the value then dispatch an InputEvent so Preact's synthetic-
        // event layer runs through its useState update path. Give Preact
        // one microtask to flush its update queue before reading the
        // committed feedback off the resolved envelope.
        feedbackEl.value = 'use search_in_files directly';
        feedbackEl.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'use search_in_files directly' }));
        await new Promise(r => setTimeout(r, 0));
    }

    const rejectBtn = card?.querySelector('.subagent-approval-card__reject');
    rejectBtn?.click();
    await waitForUnmount();

    T.assert(resolved?.status === 'rejected',
        `resolved with rejected (got: ${JSON.stringify(resolved)})`);
    T.assert(resolved?.feedback === 'use search_in_files directly',
        `feedback carried (got: ${resolved?.feedback})`);
}

// ============================================================================
// 5. cancelSubAgentApproval externally → card unmounts + Promise cancelled
// ============================================================================

T.suite('Sub-agent approval card — external cancel resolves with cancelled envelope');
{
    const container = setupContainer();

    let resolved = null;
    setPendingSubAgentApproval({
        transcriptId: 'sa-test-5',
        task: 'external cancel',
        profileName: 'subagent.v1',
        capabilitySummary: buildCapabilitySummary({ profileName: 'subagent.v1' }),
        resolve: (v) => { resolved = v; },
    });
    await waitForMount(container);
    T.assert(_isMounted(), 'card mounted before external cancel');

    cancelSubAgentApproval({ transcript_id: 'sa-test-5' });
    await waitForUnmount();

    T.assert(!_isMounted(), 'card unmounted after external cancel');
    T.assert(resolved?.status === 'cancelled',
        `resolved with cancelled (got: ${JSON.stringify(resolved)})`);
    T.assert(resolved?.cancelled === true, 'cancelled flag set');
}
