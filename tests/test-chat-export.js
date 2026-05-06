/**
 * Tests for chat-export markdown serialization (1.6.14, github#36).
 *
 * Pre-fix bug: chat exports were walking the DOM via `.message-content`
 * `textContent`, which goes through `marked.parse(content, {gfm:true})`
 * before render. GFM autolinks shapes like `s.id` / `Date.now()` /
 * `CHANGELOG.md` to `<a href="http://s.id">s.id</a>` — that markdown
 * leaked back into exports as `[s.id](http://s.id)` literals.
 *
 * Post-fix expectation: export reads message text from
 * `State.chatHistory` (the canonical LLM markdown source) keyed by
 * `data-virt-idx`. Tool-call cards still come from the DOM (rendered
 * state, escapeHtml-protected — autolink-safe). A degenerate-autolink
 * stripper runs as a belt-and-suspenders post-process.
 */
import { State } from '../js/core.js';
import { initChatState } from '../js/chat/state.js';
import { buildExportMarkdown } from '../js/chat/export.js';

const { T } = window;

// -- Helpers ----------------------------------------------------------------

function makeMessageEl(role, htmlContent, virtIdx) {
    const el = document.createElement('div');
    el.className = `chat-message ${role}`;
    if (typeof virtIdx === 'number') {
        el.setAttribute('data-virt-idx', String(virtIdx));
    }
    el.innerHTML = `
        <div class="message-header">
            <span class="message-role">${role}</span>
            <span class="message-time">12:00:00</span>
        </div>
        <div class="message-content">${htmlContent}</div>
    `;
    return el;
}

function makeToolCallEl({ name, argSummary, status, argsJson, resultJson }) {
    const el = document.createElement('div');
    el.className = 'chat-message tool-call tool-success';
    el.innerHTML = `
        <details class="tool-call-details">
            <summary class="tool-call-summary">
                <span class="tool-call-icon">🔧</span>
                <span class="tool-call-name">${name}</span>
                <span class="tool-call-args-summary">${argSummary}</span>
                <span class="tool-call-status">${status}</span>
            </summary>
            <div class="tool-call-body">
                <div class="tool-call-section">
                    <div class="tool-call-label">Arguments</div>
                    <pre class="tool-call-json">${argsJson}</pre>
                </div>
                <div class="tool-call-section">
                    <div class="tool-call-label">Result</div>
                    <pre class="tool-call-json">${resultJson}</pre>
                </div>
            </div>
        </details>
    `;
    return el;
}

function setupContainer() {
    const old = document.getElementById('__test_export_container');
    if (old) old.remove();
    const container = document.createElement('div');
    container.id = '__test_export_container';
    document.body.appendChild(container);
    initChatState(container, null);
    return container;
}

function teardown(savedHistory) {
    const container = document.getElementById('__test_export_container');
    if (container) container.remove();
    State.chatHistory.length = 0;
    if (Array.isArray(savedHistory)) {
        for (const m of savedHistory) State.chatHistory.push(m);
    }
}

// -- Test 1: code identifiers preserved verbatim -----------------------------

T.suite('Chat export — code identifiers stay bare (regression for github#36)');

(() => {
    const saved = State.chatHistory.slice();
    State.chatHistory.length = 0;
    const container = setupContainer();

    State.chatHistory.push({
        role: 'assistant',
        content: 'Use s.id and Date.now() in CHANGELOG.md. Also see TOOLS.md and roles.map.',
        timestamp: Date.now(),
    });

    // Render with the marked-autolinked HTML the production renderer
    // would produce — proves the export ignores the DOM-rendered text
    // and reads the canonical chatHistory entry instead.
    const renderedHtml = (
        'Use <a href="http://s.id">s.id</a> and ' +
        '<a href="http://Date.now">Date.now</a>() in ' +
        '<a href="http://CHANGELOG.md">CHANGELOG.md</a>. Also see ' +
        '<a href="http://TOOLS.md">TOOLS.md</a> and ' +
        '<a href="http://roles.map">roles.map</a>.'
    );
    container.appendChild(makeMessageEl('assistant', renderedHtml, 0));

    const out = buildExportMarkdown();

    T.assert(typeof out === 'string', 'returns a string');
    T.assert(!out.includes('[s.id](http://s.id)'), 'no [s.id](http://s.id) literal');
    T.assert(!out.includes('[Date.now](http://Date.now)'), 'no [Date.now](http://Date.now) literal');
    T.assert(!out.includes('[CHANGELOG.md](http://CHANGELOG.md)'), 'no [CHANGELOG.md] autolink');
    T.assert(!out.includes('[TOOLS.md](http://TOOLS.md)'), 'no [TOOLS.md] autolink');
    T.assert(!out.includes('[roles.map](http://roles.map)'), 'no [roles.map] autolink');
    T.assert(out.includes('Use s.id and Date.now() in CHANGELOG.md'), 'bare identifiers preserved');
    T.assert(out.includes('TOOLS.md and roles.map'), 'remaining identifiers preserved');

    teardown(saved);
})();

// -- Test 2: empty history ---------------------------------------------------

T.suite('Chat export — empty history produces clean header-only output');

(() => {
    const saved = State.chatHistory.slice();
    State.chatHistory.length = 0;
    setupContainer();

    const out = buildExportMarkdown();

    T.assert(typeof out === 'string', 'returns a string for empty history');
    T.assert(out.includes('# AI Editor Chat Export'), 'header present');
    T.assert(!out.includes('### 👤'), 'no user heading');
    T.assert(!out.includes('### 🤖'), 'no assistant heading');

    teardown(saved);
})();

// -- Test 3: tool-call card preserved ---------------------------------------

T.suite('Chat export — tool-call cards still serialize from DOM');

(() => {
    const saved = State.chatHistory.slice();
    State.chatHistory.length = 0;
    const container = setupContainer();

    container.appendChild(makeToolCallEl({
        name: 'read_file',
        argSummary: 'js/chat/export.js',
        status: '✅ 211 lines',
        argsJson: '{\n  "path": "js/chat/export.js"\n}',
        resultJson: '{\n  "content": "..."\n}',
    }));

    const out = buildExportMarkdown();

    T.assert(out.includes('🔧 **read_file**'), 'tool-call header present');
    T.assert(out.includes('js/chat/export.js'), 'tool-call args summary present');
    T.assert(out.includes('✅ 211 lines'), 'tool-call status present');
    T.assert(out.includes('"path": "js/chat/export.js"'), 'tool-call args JSON present');
    T.assert(out.includes('"content"'), 'tool-call result JSON present');

    teardown(saved);
})();

// -- Test 4: mixed history preserves order + canonical text -----------------

T.suite('Chat export — mixed history preserves order and canonical text');

(() => {
    const saved = State.chatHistory.slice();
    State.chatHistory.length = 0;
    const container = setupContainer();

    State.chatHistory.push({
        role: 'user',
        content: 'How does s.id work?',
        timestamp: Date.now(),
    });
    State.chatHistory.push({
        role: 'assistant',
        content: 'See result.style and mcpTool.name fields.',
        timestamp: Date.now(),
    });

    container.appendChild(makeMessageEl('user', 'How does <a href="http://s.id">s.id</a> work?', 0));
    container.appendChild(makeToolCallEl({
        name: 'scan_file',
        argSummary: 'js/foo.js',
        status: '✅ ok',
        argsJson: '{}',
        resultJson: '{}',
    }));
    container.appendChild(makeMessageEl(
        'assistant',
        'See <a href="http://result.style">result.style</a> and <a href="http://mcpTool.name">mcpTool.name</a> fields.',
        1,
    ));

    const out = buildExportMarkdown();

    const userIdx = out.indexOf('How does s.id work?');
    const toolIdx = out.indexOf('🔧 **scan_file**');
    const asstIdx = out.indexOf('See result.style and mcpTool.name');

    T.assert(userIdx >= 0, 'user message present with bare identifier');
    T.assert(toolIdx >= 0, 'tool-call card present');
    T.assert(asstIdx >= 0, 'assistant message present with bare identifiers');
    T.assert(userIdx < toolIdx && toolIdx < asstIdx, 'order preserved: user → tool → assistant');
    T.assert(!out.match(/\[[^\]]+\]\(http:\/\/[^)]+\)/), 'no degenerate autolink survives anywhere');

    teardown(saved);
})();

// -- Test 5: think blocks stripped from assistant export -------------------

T.suite('Chat export — assistant think blocks stripped, user content kept verbatim');

(() => {
    const saved = State.chatHistory.slice();
    State.chatHistory.length = 0;
    const container = setupContainer();

    State.chatHistory.push({
        role: 'assistant',
        content: '<think>internal reasoning</think>\nVisible answer about s.id.',
        timestamp: Date.now(),
    });
    State.chatHistory.push({
        role: 'user',
        content: 'Quote with <think>literal text</think> from a docs page.',
        timestamp: Date.now(),
    });

    container.appendChild(makeMessageEl('assistant', 'Visible answer about s.id.', 0));
    container.appendChild(makeMessageEl('user', 'Quote with literal text from a docs page.', 1));

    const out = buildExportMarkdown();

    T.assert(out.includes('Visible answer about s.id.'), 'visible assistant content present');
    T.assert(!out.includes('internal reasoning'), 'assistant think-block content stripped');
    T.assert(out.includes('<think>literal text</think>'), 'user content kept verbatim, no strip');

    teardown(saved);
})();

// -- Test 6: degenerate autolink stripper handles upstream contamination ---

T.suite('Chat export — degenerate-autolink stripper as belt-and-suspenders');

(() => {
    const saved = State.chatHistory.slice();
    State.chatHistory.length = 0;
    const container = setupContainer();

    // Simulate upstream contamination — a chatHistory entry already
    // contaminated with autolink markdown (e.g. re-imported from a
    // pre-fix export). The stripper should still clean it.
    State.chatHistory.push({
        role: 'assistant',
        content: 'See [s.id](http://s.id) and [Date.now](http://Date.now)() above.',
        timestamp: Date.now(),
    });
    container.appendChild(makeMessageEl('assistant', 'See s.id and Date.now() above.', 0));

    const out = buildExportMarkdown();

    T.assert(!out.includes('[s.id](http://s.id)'), 'degenerate autolink stripped from chatHistory content');
    T.assert(!out.includes('[Date.now](http://Date.now)'), 'second degenerate autolink stripped');
    T.assert(out.includes('See s.id and Date.now() above.'), 'bare identifiers remain');

    // Real (non-degenerate) markdown links must NOT be touched.
    State.chatHistory.length = 0;
    State.chatHistory[0] = {
        role: 'assistant',
        content: 'See [the docs](https://example.com/page) for details.',
        timestamp: Date.now(),
    };
    const container2 = document.getElementById('__test_export_container');
    container2.innerHTML = '';
    container2.appendChild(makeMessageEl('assistant', 'See the docs for details.', 0));

    const out2 = buildExportMarkdown();
    T.assert(out2.includes('[the docs](https://example.com/page)'), 'real link with distinct text+href preserved');

    teardown(saved);
})();
