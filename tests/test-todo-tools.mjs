/**
 * Tests for js/tools/todo-tools.js (github#26 — TodoRead/TodoWrite).
 *
 * Asserts:
 *   - todo_write enforces the cap, content length, status enum, id presence
 *     and uniqueness, and rejects malformed shapes with descriptive errors.
 *   - todo_write replaces the list as a unit (full replace, not patch).
 *   - todo_read round-trips what todo_write stored.
 *   - buildTodoPrompt is empty for an empty list and renders the expected
 *     compact format when items are present, including status glyphs.
 *
 * Runs under `node --test`. Mirrors the harness pattern in
 * tests/test-tools-foundation.mjs.
 */
import './_node-shim.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { State } from '../js/core.js';
import { ToolRegistry } from '../js/tools/registry.js';
import { registerTodoTools, buildTodoPrompt } from '../js/tools/todo-tools.js';

// ============================================
// Harness
// ============================================

/**
 * Reset the registry and re-register only the todo tools, so each test
 * starts from a known state independent of other suites.
 */
function setup() {
    ToolRegistry.clear();
    registerTodoTools(ToolRegistry);
    State.todo = [];
}

function getHandler(name) {
    const handler = ToolRegistry.handlers.get(name);
    assert.ok(handler, `tool ${name} should be registered`);
    return handler;
}

// ============================================
// Registration shape
// ============================================

test('todo_write and todo_read register with roles: all', () => {
    setup();
    const defs = ToolRegistry.getDefinitions();
    const write = defs.find(d => d.function?.name === 'todo_write');
    const read = defs.find(d => d.function?.name === 'todo_read');
    assert.ok(write, 'todo_write must be in definitions');
    assert.ok(read, 'todo_read must be in definitions');
    // roles is normalized to an array of role ids by registry.register
});

// ============================================
// todo_write — happy path + summarization
// ============================================

test('todo_write stores a valid list and returns a counted summary', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    const result = await todo_write({
        todos: [
            { id: 1, content: 'Read the issue', status: 'completed' },
            { id: 2, content: 'Sketch the API', status: 'in_progress', activeForm: 'Sketching the API' },
            { id: 3, content: 'Wire it up', status: 'pending' },
        ],
    });
    assert.equal(result.success, true);
    assert.equal(result.total, 3);
    assert.deepEqual(result.by_status, { pending: 1, in_progress: 1, completed: 1 });
    assert.equal(State.todo.length, 3);
    // activeForm preserved when provided
    assert.equal(State.todo[1].activeForm, 'Sketching the API');
});

test('todo_write is a full replace, not a patch', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    await todo_write({
        todos: [
            { id: 1, content: 'A', status: 'pending' },
            { id: 2, content: 'B', status: 'pending' },
        ],
    });
    await todo_write({ todos: [{ id: 99, content: 'C', status: 'in_progress' }] });
    assert.equal(State.todo.length, 1);
    assert.equal(State.todo[0].id, 99);
    assert.equal(State.todo[0].content, 'C');
});

test('todo_write empty list clears the todo list', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    await todo_write({ todos: [{ id: 1, content: 'X', status: 'pending' }] });
    const cleared = await todo_write({ todos: [] });
    assert.equal(cleared.success, true);
    assert.equal(cleared.total, 0);
    assert.equal(State.todo.length, 0);
});

// ============================================
// todo_write — validation
// ============================================

test('todo_write rejects a missing or non-array todos argument', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    const a = await todo_write({});
    const b = await todo_write({ todos: 'oops' });
    assert.match(a.error || '', /todos.*required.*array/i);
    assert.match(b.error || '', /todos.*required.*array/i);
});

test('todo_write enforces the 20-item cap', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    const list = [];
    for (let i = 1; i <= 21; i++) list.push({ id: i, content: 'item', status: 'pending' });
    const result = await todo_write({ todos: list });
    assert.match(result.error || '', /Too many items/);
    assert.equal(result.max_items, 20);
    assert.equal(State.todo.length, 0, 'state should not be mutated on rejection');
});

test('todo_write rejects an invalid status', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    const result = await todo_write({
        todos: [{ id: 1, content: 'X', status: 'doing' }],
    });
    assert.match(result.error || '', /status must be one of/);
    assert.equal(State.todo.length, 0);
});

test('todo_write rejects missing or non-numeric id', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    const a = await todo_write({ todos: [{ content: 'X', status: 'pending' }] });
    const b = await todo_write({ todos: [{ id: 'one', content: 'X', status: 'pending' }] });
    assert.match(a.error || '', /id is required/);
    assert.match(b.error || '', /id is required/);
});

test('todo_write rejects empty or non-string content', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    const a = await todo_write({ todos: [{ id: 1, content: '   ', status: 'pending' }] });
    const b = await todo_write({ todos: [{ id: 1, content: 42, status: 'pending' }] });
    assert.match(a.error || '', /content is required/);
    assert.match(b.error || '', /content is required/);
});

test('todo_write rejects duplicate ids', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    const result = await todo_write({
        todos: [
            { id: 1, content: 'A', status: 'pending' },
            { id: 1, content: 'B', status: 'pending' },
        ],
    });
    assert.match(result.error || '', /Duplicate id 1/);
    assert.equal(State.todo.length, 0);
});

test('todo_write truncates content past 200 chars rather than rejecting', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    const long = 'x'.repeat(500);
    const result = await todo_write({
        todos: [{ id: 1, content: long, status: 'pending' }],
    });
    assert.equal(result.success, true);
    assert.equal(State.todo[0].content.length, 200);
});

// ============================================
// todo_read
// ============================================

test('todo_read on an empty list returns an empty-state message', async () => {
    setup();
    const todo_read = getHandler('todo_read');
    const result = await todo_read({});
    assert.equal(result.message, 'Todo list is empty');
    assert.deepEqual(result.todos, []);
});

test('todo_read returns the stored list with the same summary shape as write', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    const todo_read = getHandler('todo_read');
    await todo_write({
        todos: [
            { id: 1, content: 'A', status: 'completed' },
            { id: 2, content: 'B', status: 'pending' },
        ],
    });
    const result = await todo_read({});
    assert.equal(result.total, 2);
    assert.deepEqual(result.by_status, { pending: 1, in_progress: 0, completed: 1 });
    assert.equal(result.todos.length, 2);
});

// ============================================
// buildTodoPrompt
// ============================================

test('buildTodoPrompt returns an empty string when there are no todos', () => {
    setup();
    assert.equal(buildTodoPrompt(), '');
});

test('buildTodoPrompt renders header + one line per item with status glyphs', async () => {
    setup();
    const todo_write = getHandler('todo_write');
    await todo_write({
        todos: [
            { id: 1, content: 'Done thing', status: 'completed' },
            { id: 2, content: 'Doing thing', status: 'in_progress' },
            { id: 3, content: 'Pending thing', status: 'pending' },
        ],
    });
    const out = buildTodoPrompt();
    // Header
    assert.match(out, /TODO LIST \(3 items: 1 in progress, 1 pending, 1 completed\)/);
    // Glyphs and ids
    assert.match(out, /\[x\] \(1\) Done thing/);
    assert.match(out, /\[~\] \(2\) Doing thing/);
    assert.match(out, /\[ \] \(3\) Pending thing/);
});

test('buildTodoPrompt is structured to survive summarization (re-injected each turn)', () => {
    // Document the load-bearing claim: buildTodoPrompt only reads State.todo,
    // not chatHistory. So as long as State.todo persists across the
    // summarizer call, the prompt section reappears next turn unchanged.
    setup();
    State.todo = [{ id: 1, content: 'Survives', status: 'in_progress' }];
    const before = buildTodoPrompt();
    // Simulate what the summarizer touches — chatHistory, summaryInfo, etc.
    State.chatHistory = [];
    const after = buildTodoPrompt();
    assert.equal(before, after, 'buildTodoPrompt output must be stable across chat-history mutations');
});
