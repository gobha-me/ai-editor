/**
 * 2.8.0 — `pickProfileName(conversationProfile, settings)` precedence.
 *
 * The new-chat chip selector writes a per-conversation `profile` field
 * via `ConversationManager.setActiveProfile`. System-prompt assembly
 * (`js/prompts.js`), tool admission (`js/tools/registry.js`), compression
 * config (`js/chat/compactor-integration.js`), the coder.v1 ledger gate
 * (`js/chat/handlers.js`), and the model status-bar badge
 * (`js/model-manager.js`) all read through
 * `ConversationManager.getEffectiveProfileName()` which delegates to
 * `pickProfileName`. This test pins the resolution order so the
 * lifetime contract ("one profile for the life of a chat") survives
 * future refactors.
 *
 * Pure logic; no DOM/Storage/fetch — `pickProfileName` takes the
 * conversation profile string and settings shape directly. Runs under
 * `node --test`.
 *
 * @module tests/test-pick-profile-name
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickProfileName } from '../js/profiles/resolve.js';

// ============================================
// Per-chat binding wins
// ============================================

test('pickProfileName: conversation profile wins over settings.profile', () => {
    // The whole point — picking "KB" via the chip when settings is "coder.v1"
    // means the chat runs as KB.
    assert.equal(pickProfileName('kb.v1', { profile: 'coder.v1' }), 'kb.v1');
});

test('pickProfileName: conversation profile wins even when settings is also chat.v1', () => {
    // Idempotent in the same-name case.
    assert.equal(pickProfileName('chat.v1', { profile: 'chat.v1' }), 'chat.v1');
});

test('pickProfileName: synthetic conversation profile wins (full.v1)', () => {
    // Synthetic profiles still resolve via Profiles.has — `full.v1` etc.
    // are valid bindings even though they don't appear in the picker.
    assert.equal(pickProfileName('full.v1', { profile: 'chat.v1' }), 'full.v1');
});

// ============================================
// Falls back to settings when no per-chat binding
// ============================================

test('pickProfileName: null conversation profile falls back to settings', () => {
    assert.equal(pickProfileName(null, { profile: 'coder.v1' }), 'coder.v1');
});

test('pickProfileName: undefined conversation profile falls back to settings', () => {
    assert.equal(pickProfileName(undefined, { profile: 'kb.v1' }), 'kb.v1');
});

test('pickProfileName: empty-string conversation profile falls back to settings', () => {
    // Empty string isn't a registered profile — falls through to settings.
    assert.equal(pickProfileName('', { profile: 'coder.v1' }), 'coder.v1');
});

// ============================================
// Falls back to chat.v1 when neither resolves
// ============================================

test('pickProfileName: both null → chat.v1 baseline', () => {
    assert.equal(pickProfileName(null, null), 'chat.v1');
});

test('pickProfileName: both undefined → chat.v1 baseline', () => {
    assert.equal(pickProfileName(undefined, undefined), 'chat.v1');
});

test('pickProfileName: settings without profile field → chat.v1 baseline', () => {
    assert.equal(pickProfileName(null, {}), 'chat.v1');
});

// ============================================
// Permissive validation (matches getActiveProfileName)
// ============================================

test('pickProfileName: unknown conversation profile string falls through to settings', () => {
    // Defensive — `Profiles.has('mystery.v9')` returns false, so the
    // unknown name doesn't take effect. Settings provides the answer.
    assert.equal(pickProfileName('mystery.v9', { profile: 'coder.v1' }), 'coder.v1');
});

test('pickProfileName: unknown both → chat.v1 baseline (matches getActiveProfileName fallback)', () => {
    assert.equal(pickProfileName('mystery.v9', { profile: 'still.v8' }), 'chat.v1');
});

test('pickProfileName: non-string conversation arg coerces to fallback', () => {
    // Defensive — guards against runtime callers passing wrong types.
    assert.equal(pickProfileName(42, { profile: 'coder.v1' }), 'coder.v1');
    assert.equal(pickProfileName({}, { profile: 'kb.v1' }), 'kb.v1');
});
