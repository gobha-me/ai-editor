/**
 * gitea#505 / 2.89.0 — source-scan lint pinning the sub-agent model
 * resolver chain across the runner + the profiles + the settings UI.
 *
 * Mirrors the shape of `test-plan-mode-source-scan.mjs` and
 * `test-tool-failure-shapes.mjs` — open the files, walk for the
 * load-bearing identifiers, fail loud when a future PR removes one
 * without updating the doc.
 *
 * The five-step chain in `subagent-runner.js#resolveSubAgentModel`:
 *
 *   1. per-call `delegate_task({ model })` override
 *   2. profile `subagent.model` (resolveSubAgentConfig output)
 *   3. workspace `State.settings.retrieval.subagentModelId`
 *   4. workspace `State.settings.retrieval.paraphraseModelId`
 *   5. primary `State.settings.llmModel`
 *
 * Runs under `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const RUNNER_SRC = readFileSync(
    new URL('../js/chat/subagent-runner.js', import.meta.url),
    'utf8',
);
const PROFILE_SRC = readFileSync(
    new URL('../js/profiles/subagent-v1.js', import.meta.url),
    'utf8',
);
const RESOLVE_SRC = readFileSync(
    new URL('../js/profiles/resolve.js', import.meta.url),
    'utf8',
);
const TOOLS_SRC = readFileSync(
    new URL('../js/tools/subagent-tools.js', import.meta.url),
    'utf8',
);
const SETTINGS_SRC = readFileSync(
    new URL('../js/settings/retrieval-tab.js', import.meta.url),
    'utf8',
);
const CORE_SRC = readFileSync(
    new URL('../js/core.js', import.meta.url),
    'utf8',
);
const CONTRACT_SRC = readFileSync(
    new URL('../js/profiles/profile-contract.js', import.meta.url),
    'utf8',
);

test('subagent-runner.js exports resolveSubAgentModel', () => {
    assert.match(RUNNER_SRC, /export function resolveSubAgentModel\b/,
        'resolveSubAgentModel must remain exported (called from tests + future MCP introspection)');
});

test('subagent-runner.js resolver chain reads all 5 sources', () => {
    // Step 1: per-call override (function parameter)
    assert.match(RUNNER_SRC, /perCallModel/,
        'resolver must read the per-call override parameter');
    // Step 2: profile model (function parameter, populated by resolveSubAgentConfig)
    assert.match(RUNNER_SRC, /profileModel/,
        'resolver must read the profile model parameter');
    // Steps 3, 4, 5: settings reads
    assert.match(RUNNER_SRC, /subagentModelId/,
        'resolver must read State.settings.retrieval.subagentModelId');
    assert.match(RUNNER_SRC, /paraphraseModelId/,
        'resolver must read State.settings.retrieval.paraphraseModelId');
    assert.match(RUNNER_SRC, /State\.settings\?\.llmModel|State\.settings\.llmModel/,
        'resolver must fall through to State.settings.llmModel as primary fallback');
});

test('subagent-runner.js transport uses resolved child model (no bare llmModel read)', () => {
    // Regression guard against the pre-2.89.0 bug — transport.chat read
    // `State.settings.llmModel` unconditionally. After gitea#505 the only
    // bare `State.settings.llmModel` read in subagent-runner.js lives
    // inside `resolveSubAgentModel` (as the primary fallback) and in the
    // transport.chat fallback expression `childModelId || State.settings.llmModel`.
    // Count occurrences; both expected sites are paired with the resolved
    // value or the resolver function body.
    const lines = RUNNER_SRC.split('\n');
    const llmModelLines = lines
        .map((line, idx) => ({ line: line.trim(), no: idx + 1 }))
        .filter(({ line }) => /State\.settings\??\.llmModel\b/.test(line)
            && !line.startsWith('//') && !line.startsWith('*'));
    // Two legitimate sites:
    //   - resolveSubAgentModel's `return { model: State.settings?.llmModel ... }`
    //   - transport.chat's `childModelId || State.settings.llmModel` fallback
    // If a new bare read sneaks in, this test catches it.
    assert.ok(llmModelLines.length <= 2,
        `expected ≤2 State.settings.llmModel reads in subagent-runner.js, got ${llmModelLines.length}:\n` +
        llmModelLines.map(({ no, line }) => `  L${no}: ${line}`).join('\n'));
});

test('subagent.v1 profile carries the model: null field', () => {
    // The `subagent` block must include `model:` so the resolver chain's
    // step 2 has something to read. `null` is explicit-unset (intentional
    // — the resolver normalizes missing/non-string/empty/whitespace).
    assert.match(PROFILE_SRC, /\bsubagent:\s*\{[\s\S]*?\bmodel:\s*null\b[\s\S]*?\}/,
        'subagent.v1.subagent block must declare model: null');
});

test('resolveSubAgentConfig returns model in its envelope', () => {
    assert.match(RESOLVE_SRC, /\bmodel:\s*typeof cfg\.model/,
        'resolveSubAgentConfig must normalize cfg.model into its return shape');
    assert.match(RESOLVE_SRC, /model:\s*string\|null/,
        'resolveSubAgentConfig JSDoc must declare model in its return type');
});

test('Profile typedef declares the SubAgentBlock + subagent slot', () => {
    assert.match(CONTRACT_SRC, /@typedef\s+\{Object\}\s+SubAgentBlock\b/,
        'profile-contract.js must export the SubAgentBlock typedef');
    // JSDoc form is `@property {string|null}  [model]` — type before name.
    assert.match(CONTRACT_SRC, /\{string\|null\}\s+\[model\]/,
        'SubAgentBlock typedef must declare the optional model field as string|null');
    assert.match(CONTRACT_SRC, /\{SubAgentBlock\}\s+\[subagent\]/,
        'Profile typedef must declare the optional subagent slot of type SubAgentBlock');
});

test('delegate_task JSON schema includes the model parameter', () => {
    assert.match(TOOLS_SRC, /\bmodel:\s*\{[\s\S]*?type:\s*'string'/,
        'delegate_task schema must declare the model parameter');
    assert.match(TOOLS_SRC, /modelOverride/,
        'subagent-tools.js must normalize args.model into modelOverride');
});

test('retrieval-tab.js surfaces subagentModelId in RETRIEVAL_DEFAULTS', () => {
    assert.match(SETTINGS_SRC, /\bsubagentModelId:\s*''/,
        'RETRIEVAL_DEFAULTS must include the subagentModelId entry');
    assert.match(SETTINGS_SRC, /retrievalSubagentModelId/,
        'render() must mount the subagentModelId input field');
    assert.match(SETTINGS_SRC, /key === 'subagentModelId'/,
        '_onChange handler must dispatch the subagentModelId branch');
});

test('core.js settings defaults include subagentModelId', () => {
    assert.match(CORE_SRC, /\bsubagentModelId:\s*''/,
        'State.settings.retrieval.subagentModelId default must be the empty string');
});

test('core.js State.subagents.session_cost includes byModel: {}', () => {
    assert.match(CORE_SRC, /session_cost:\s*\{\s*dollars:\s*0,\s*tokens:\s*0,\s*byModel:\s*\{\}\s*\}/,
        'State.subagents.session_cost initial shape must include byModel');
});

test('subagent-runner.js cost roll-up writes to byModel', () => {
    assert.match(RUNNER_SRC, /session_cost\.byModel\[childModelId\]/,
        'runner must accumulate per-resolved-model into session_cost.byModel');
    // Defensive init in case slice-1 single-pass init never ran.
    assert.match(RUNNER_SRC, /session_cost\.byModel\s*=\s*\{\}/,
        'runner must defensively init session_cost.byModel');
});

test('SubAgentApprovalCard.js renders a Model row in the capability table', () => {
    // 2.89.0 (gitea#505) — the resolved childModel must surface on the
    // approval card so the user sees the cost-tier choice. Test the
    // markup pattern at the source level (Preact + browser DOM not
    // available under node --test).
    const CARD_SRC = readFileSync(
        new URL('../js/chat/subagent-approval-card/SubAgentApprovalCard.js', import.meta.url),
        'utf8',
    );
    assert.match(CARD_SRC, /<th>Model<\/th>/,
        'capability table must include a Model <th> header');
    assert.match(CARD_SRC, /\bchildModelLabel\b/,
        'card must compute childModelLabel from cap.childModel');
    // The "(primary model — <id>)" / "<id>" branch must be present.
    assert.match(CARD_SRC, /primary model/,
        'card must format the primary-source fallback as "primary model — <id>"');
});

test('CONTRIBUTING.md exists and names the GitHub PR gate', () => {
    // The repository transition keeps this root-level contribution contract
    // but replaces the retired Gitea close-keyword rule with exact-SHA GitHub
    // validation and pull-request authority.
    const contributing = readFileSync(
        new URL('../CONTRIBUTING.md', import.meta.url),
        'utf8',
    );
    assert.match(contributing, /sole\s+normal code authority/,
        'CONTRIBUTING.md must name GitHub as the code authority');
    assert.match(contributing, /Node and policy/,
        'CONTRIBUTING.md must name the required source/test check');
    assert.match(contributing, /exact merge SHA/,
        'CONTRIBUTING.md must require post-merge exact-SHA validation');
});
