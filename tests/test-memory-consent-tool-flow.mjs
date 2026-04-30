/**
 * End-to-end tests for the PR #6 consent flow at the LLM-tool boundary:
 * `memory_remember` with `source: 'agent_proposed'` enqueues a candidate
 * and returns `pending_consent`; subsequent `consentAccept` / `consentDismiss`
 * resolves the candidate. `user_explicit` and `inferred` sources bypass
 * the queue and write immediately, mirroring pre-PR-#6 behavior.
 */
import './_node-shim.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    consentAccept,
    consentDismiss,
    consentList,
    consentGet,
    getById,
    getByKey,
    audit,
    MEMORY_EVENTS,
    _setIDBImpl, createMemoryFakeIDB, _resetMutexForTests,
    _resetConsentQueueForTests,
    _setConsentEmbeddingsForTests,
} from '../js/intelligence/memory/index.js';
import { State, EventBus } from '../js/core.js';
import { ToolRegistry } from '../js/tools/registry.js';
import {
    registerMemoryTools,
    _setEmbeddingsClientForTests,
    _setWorkspaceIdForTests,
    _resetMemoryToolsForTests,
} from '../js/tools/memory-tools.js';

let stub;

function freshRegistry() {
    ToolRegistry.clear();
    registerMemoryTools(ToolRegistry);
    return ToolRegistry;
}

beforeEach(() => {
    _setIDBImpl(createMemoryFakeIDB());
    _resetMutexForTests();
    _resetMemoryToolsForTests();
    _resetConsentQueueForTests();

    stub = {
        embed: async (text) => [text.length, 0, 0],
        isEnabled: () => true,
    };
    _setEmbeddingsClientForTests(stub);
    _setConsentEmbeddingsForTests(stub);
    _setWorkspaceIdForTests('ws-test');

    if (typeof globalThis.localStorage !== 'undefined') {
        globalThis.localStorage.clear();
    }

    State.settings = State.settings || {};
    State.settings.role = 'full';
    State.settings.llmModel = 'opus-test';
    State.settings.embeddingModel = 'stub-model';
    State.scratchpad = {};
});

/* ============================================================ */
/* agent_proposed → pending_consent (no store write)            */
/* ============================================================ */

test('memory_remember with source=agent_proposed returns pending_consent and writes nothing', async () => {
    const reg = freshRegistry();
    /** @type {any[]} */
    const created = [];
    const off = EventBus.on(MEMORY_EVENTS.CREATED, (p) => created.push(p));

    const out = await reg.execute('memory_remember', {
        key: 'test_runner', value: 'node:test', category: 'preferences',
        // source omitted → defaults to agent_proposed.
    });

    assert.equal(out.status, 'pending_consent');
    assert.equal(typeof out.candidate_id, 'string');
    assert.equal(out.key, 'test_runner');
    assert.equal(out.value, 'node:test');
    assert.equal(out.scope, 'workspace');

    // No CREATED event because the store was never touched.
    assert.equal(created.length, 0);

    // Candidate is sitting in the queue.
    assert.equal(consentList().length, 1);
    const c = consentGet(out.candidate_id);
    assert.equal(c.actor, 'agent:opus-test');

    // Embedding was NOT called yet — that's deferred to accept time.
    // (Stub records calls via length only; we're asserting no record exists.)
    const recHit = await getByKey({
        scope: 'workspace', owner_id_or_workspace_id: 'ws-test', key: 'test_runner',
    });
    assert.equal(recHit, null);
    off();
});

test('source=user_explicit bypasses the queue and writes immediately', async () => {
    const reg = freshRegistry();
    const out = await reg.execute('memory_remember', {
        key: 'lang', value: 'rust', category: 'preferences', source: 'user_explicit',
    });
    // Old contract for user_explicit is preserved.
    assert.equal(out.success, true);
    assert.equal(out.action, 'created');
    assert.equal(typeof out.id, 'string');

    const rec = await getById(out.id);
    assert.equal(rec.source, 'user_explicit');

    // Queue is empty — nothing was deferred.
    assert.equal(consentList().length, 0);
});

test('source=inferred bypasses the queue and writes immediately', async () => {
    const reg = freshRegistry();
    const out = await reg.execute('memory_remember', {
        key: 'auth_method', value: 'oauth', category: 'project_context', source: 'inferred',
    });
    assert.equal(out.success, true);
    assert.equal(out.action, 'created');
    assert.equal(consentList().length, 0);
});

/* ============================================================ */
/* agent_proposed → consentAccept resolves to a real record     */
/* ============================================================ */

test('agent_proposed → consentAccept produces a record with source=user_explicit and the candidate value', async () => {
    const reg = freshRegistry();
    const proposal = await reg.execute('memory_remember', {
        key: 'editor_theme', value: 'oneDark', category: 'preferences',
    });
    assert.equal(proposal.status, 'pending_consent');

    const rec = await consentAccept(proposal.candidate_id);
    assert.equal(rec.source, 'user_explicit');
    assert.equal(rec.value, 'oneDark');
    assert.equal(rec.scope, 'workspace');
    assert.equal(rec.owner_id_or_workspace_id, 'ws-test');
    assert.equal(rec.md_path, '.aieditor/memory/preferences.md');

    // Candidate dropped after accept.
    assert.equal(consentList().length, 0);

    // Audit log captures the create as user_explicit.
    const entries = await audit.listForRecord(rec.id);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, 'create');
});

test('agent_proposed → Edit + accept stores the edited value', async () => {
    const reg = freshRegistry();
    const proposal = await reg.execute('memory_remember', {
        key: 'commit_style', value: 'conventional commits', category: 'workflow',
    });

    const rec = await consentAccept(proposal.candidate_id, {
        value: 'conventional commits with scope',
        reason: 'user accepted with edit',
    });
    assert.equal(rec.value, 'conventional commits with scope');
    assert.equal(rec.source, 'user_explicit');
});

test('agent_proposed → consentDismiss leaves no record + no audit', async () => {
    const reg = freshRegistry();
    const proposal = await reg.execute('memory_remember', {
        key: 'k', value: 'v', category: 'preferences',
    });
    consentDismiss(proposal.candidate_id);

    const recHit = await getByKey({
        scope: 'workspace', owner_id_or_workspace_id: 'ws-test', key: 'k',
    });
    assert.equal(recHit, null);

    const allAudit = await audit.list({});
    assert.equal(allAudit.length, 0);

    assert.equal(consentList().length, 0);
});

test('proposal that supersedes an existing key takes the supersede branch on accept', async () => {
    const reg = freshRegistry();
    // Seed a pre-existing user_explicit record at the same key.
    const seed = await reg.execute('memory_remember', {
        key: 'lang', value: 'rust', category: 'preferences', source: 'user_explicit',
    });
    assert.equal(seed.action, 'created');

    // Agent proposes a newer value.
    const proposal = await reg.execute('memory_remember', {
        key: 'lang', value: 'go', category: 'preferences',
    });
    assert.equal(proposal.status, 'pending_consent');

    const newRec = await consentAccept(proposal.candidate_id);
    assert.notEqual(newRec.id, seed.id);
    assert.equal(newRec.value, 'go');

    const oldRec = await getById(seed.id);
    assert.equal(oldRec.superseded_by, newRec.id);
});
