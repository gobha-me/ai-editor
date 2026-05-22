/**
 * gitea#505 / 2.89.0 — sub-agent model override + cost-split.
 *
 * Pins the 5-step resolver chain in `js/chat/subagent-runner.js`:
 *
 *   1. per-call `delegate_task({ model })` override
 *   2. profile `subagent.model` (resolveSubAgentConfig output)
 *   3. workspace `State.settings.retrieval.subagentModelId`
 *   4. workspace `State.settings.retrieval.paraphraseModelId`
 *   5. primary `State.settings.llmModel`
 *
 * Also pins that `buildCapabilitySummary` populates `childModel: {id,
 * source}` so the approval card can render the resolved value. The card
 * is browser-only (Preact); we test the data shape it consumes.
 *
 * Runs under `node --test`.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State } from '../js/core.js';
import {
    resolveSubAgentModel,
    buildCapabilitySummary,
} from '../js/chat/subagent-runner.js';

// Snapshot / restore the retrieval overlay + llmModel so tests don't
// pollute each other.
function _snapshotSettings() {
    const r = State.settings?.retrieval || {};
    return {
        llmModel: State.settings.llmModel,
        subagentModelId: r.subagentModelId,
        paraphraseModelId: r.paraphraseModelId,
    };
}
function _restoreSettings(snap) {
    State.settings.llmModel = snap.llmModel;
    if (!State.settings.retrieval) State.settings.retrieval = {};
    State.settings.retrieval.subagentModelId = snap.subagentModelId;
    State.settings.retrieval.paraphraseModelId = snap.paraphraseModelId;
}

test('resolveSubAgentModel step 1 — per-call override wins over all others', () => {
    const snap = _snapshotSettings();
    try {
        State.settings.llmModel = 'primary-model';
        State.settings.retrieval.subagentModelId = 'workspace-subagent';
        State.settings.retrieval.paraphraseModelId = 'workspace-paraphrase';
        const r = resolveSubAgentModel({
            perCallModel: 'per-call-model',
            profileModel: 'profile-model',
        });
        assert.equal(r.id, 'per-call-model');
        assert.equal(r.source, 'per_call');
    } finally {
        _restoreSettings(snap);
    }
});

test('resolveSubAgentModel step 2 — profile model wins when no per-call', () => {
    const snap = _snapshotSettings();
    try {
        State.settings.llmModel = 'primary-model';
        State.settings.retrieval.subagentModelId = 'workspace-subagent';
        const r = resolveSubAgentModel({
            perCallModel: null,
            profileModel: 'profile-model',
        });
        assert.equal(r.id, 'profile-model');
        assert.equal(r.source, 'profile');
    } finally {
        _restoreSettings(snap);
    }
});

test('resolveSubAgentModel step 3 — workspace subagentModelId wins when no per-call + no profile', () => {
    const snap = _snapshotSettings();
    try {
        State.settings.llmModel = 'primary-model';
        State.settings.retrieval.subagentModelId = 'workspace-subagent';
        State.settings.retrieval.paraphraseModelId = 'workspace-paraphrase';
        const r = resolveSubAgentModel({
            perCallModel: null,
            profileModel: null,
        });
        assert.equal(r.id, 'workspace-subagent');
        assert.equal(r.source, 'workspace_subagent');
    } finally {
        _restoreSettings(snap);
    }
});

test('resolveSubAgentModel step 4 — paraphraseModelId is the next-cheapest fallback', () => {
    const snap = _snapshotSettings();
    try {
        State.settings.llmModel = 'primary-model';
        State.settings.retrieval.subagentModelId = '';            // unset
        State.settings.retrieval.paraphraseModelId = 'workspace-paraphrase';
        const r = resolveSubAgentModel({
            perCallModel: null,
            profileModel: null,
        });
        assert.equal(r.id, 'workspace-paraphrase');
        assert.equal(r.source, 'workspace_paraphrase');
    } finally {
        _restoreSettings(snap);
    }
});

test('resolveSubAgentModel step 5 — primary llmModel is the final fallback', () => {
    const snap = _snapshotSettings();
    try {
        State.settings.llmModel = 'primary-model';
        State.settings.retrieval.subagentModelId = '';
        State.settings.retrieval.paraphraseModelId = '';
        const r = resolveSubAgentModel({
            perCallModel: null,
            profileModel: null,
        });
        assert.equal(r.id, 'primary-model');
        assert.equal(r.source, 'primary');
    } finally {
        _restoreSettings(snap);
    }
});

test('resolveSubAgentModel treats empty / whitespace strings as unset', () => {
    const snap = _snapshotSettings();
    try {
        State.settings.llmModel = 'primary-model';
        State.settings.retrieval.subagentModelId = '   ';        // whitespace-only
        State.settings.retrieval.paraphraseModelId = '';
        const r = resolveSubAgentModel({
            perCallModel: '',
            profileModel: '   ',
        });
        // All three earlier sources are effectively unset.
        assert.equal(r.id, 'primary-model');
        assert.equal(r.source, 'primary');
    } finally {
        _restoreSettings(snap);
    }
});

test('resolveSubAgentModel trims the resolved id', () => {
    const snap = _snapshotSettings();
    try {
        const r = resolveSubAgentModel({
            perCallModel: '  claude-haiku-4-5  ',
            profileModel: null,
        });
        assert.equal(r.id, 'claude-haiku-4-5');
        assert.equal(r.source, 'per_call');
    } finally {
        _restoreSettings(snap);
    }
});

test('buildCapabilitySummary populates childModel for subagent.v1 (no overrides)', () => {
    const snap = _snapshotSettings();
    try {
        State.settings.llmModel = 'primary-model';
        State.settings.retrieval.subagentModelId = '';
        State.settings.retrieval.paraphraseModelId = '';
        const cap = buildCapabilitySummary({
            profileName: 'subagent.v1',
            perCallNarrow: null,
            ceilings: undefined,
            modelOverride: null,
        });
        assert.ok(cap.childModel && typeof cap.childModel === 'object',
            'capability summary carries childModel object');
        // subagent.v1.subagent.model is null, so resolver falls through
        // to primary.
        assert.equal(cap.childModel.source, 'primary');
        assert.equal(cap.childModel.id, 'primary-model');
    } finally {
        _restoreSettings(snap);
    }
});

test('buildCapabilitySummary respects per-call modelOverride', () => {
    const snap = _snapshotSettings();
    try {
        State.settings.llmModel = 'primary-model';
        const cap = buildCapabilitySummary({
            profileName: 'subagent.v1',
            modelOverride: 'haiku-cheap',
        });
        assert.equal(cap.childModel.source, 'per_call');
        assert.equal(cap.childModel.id, 'haiku-cheap');
    } finally {
        _restoreSettings(snap);
    }
});

test('buildCapabilitySummary surfaces workspace subagentModelId when no per-call / profile', () => {
    const snap = _snapshotSettings();
    try {
        State.settings.llmModel = 'primary-model';
        State.settings.retrieval.subagentModelId = 'workspace-cheap';
        const cap = buildCapabilitySummary({
            profileName: 'subagent.v1',
            modelOverride: null,
        });
        assert.equal(cap.childModel.source, 'workspace_subagent');
        assert.equal(cap.childModel.id, 'workspace-cheap');
    } finally {
        _restoreSettings(snap);
    }
});

test('buildCapabilitySummary handles unknown profile defensively (falls to primary)', () => {
    const snap = _snapshotSettings();
    const origWarn = console.warn;
    console.warn = () => {};
    try {
        State.settings.llmModel = 'primary-model';
        State.settings.retrieval.subagentModelId = '';
        State.settings.retrieval.paraphraseModelId = '';
        const cap = buildCapabilitySummary({
            profileName: 'never-registered.v9',
            modelOverride: null,
        });
        // profileRegistered: false → profileModel falls to null → resolver
        // lands on primary.
        assert.equal(cap.profileRegistered, false);
        assert.equal(cap.childModel.source, 'primary');
        assert.equal(cap.childModel.id, 'primary-model');
    } finally {
        _restoreSettings(snap);
        console.warn = origWarn;
    }
});
