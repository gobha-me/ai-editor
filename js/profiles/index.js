// @ts-check
/**
 * Profiles barrel — single entry point for the scaffolding landed in 1.1.0.
 *
 * No consumers wire up to this module yet. Re-export surface kept narrow so
 * the next track (1.2.0 compression) only needs to add to the `Profile`
 * typedef, not retrofit the file layout.
 *
 * @module profiles
 */

export {
    DEFAULT_LEDGER_CAPACITY,
    createTaskLedger,
    isTaskLedger,
} from './task-ledger.js';

export { isProfile } from './profile-contract.js';

export { CODER_V1 } from './coder-v1.js';
export { CHAT_V1 } from './chat-v1.js';

// 1.23.0 — synthetic profiles for the 2.0.0 migration script (slice 3).
// Registered in `registry.js` for `Profiles.get/has`, excluded from
// `Profiles.list()`. `PLUGIN_DEV_SYSTEM_PROMPT` is re-exported so
// `js/core.js` can share the SDK addendum string with `BUILTIN_ROLES`
// without duplicating the content.
export { FULL_V1 } from './full-v1.js';
export { PLUGIN_DEV_V1, PLUGIN_DEV_SYSTEM_PROMPT } from './plugin-dev-v1.js';
export { PM_V1 } from './pm-v1.js';
export { REVIEWER_V1 } from './reviewer-v1.js';

// 2.49.0.0 — slice 1 of github#24 Phase 1 sub-agents. Registered in
// `registry.js` for `Profiles.get/has`, excluded from `Profiles.list()`
// (sub-agents are invoked by the parent agent, not picked by the user).
export { SUBAGENT_V1 } from './subagent-v1.js';

export { resolveProfile } from './inheritance.js';

export { diffProfiles, formatProfileDiff } from './diff.js';

export { Profiles } from './registry.js';

export {
    resolveCompressionConfig,
    resolveMemoryConfig,
    resolveTools,
    resolveRetrievalConfig,
    resolveDefaultRememberScope,
    resolveScriptAutomationConfig,
    resolvePreviewConfig,
    resolvePluginConfig,
    resolveSubAgentConfig,
    PLUGIN_TOOL_NAMES,
    getActiveProfileName,
} from './resolve.js';

/**
 * Re-export the typedefs so consumers can `import('./profiles')` and pick
 * up the type aliases without importing each file individually.
 *
 * @typedef {import('./profile-contract.js').Profile}            Profile
 * @typedef {import('./profile-contract.js').BudgetSpec}         BudgetSpec
 * @typedef {import('./profile-contract.js').RetrievalConfig}    RetrievalConfig
 * @typedef {import('./profile-contract.js').MemoryConfig}       MemoryConfig
 * @typedef {import('./profile-contract.js').CompressionConfig}  CompressionConfig
 * @typedef {import('./profile-contract.js').SummarizerConfig}   SummarizerConfig
 * @typedef {import('./profile-contract.js').ToolsConfig}        ToolsConfig
 * @typedef {import('./profile-contract.js').TaskLedgerConfig}   TaskLedgerConfig
 * @typedef {import('./profile-contract.js').MemoryScope}        MemoryScope
 *
 * @typedef {import('./task-ledger.js').TaskLedger}              TaskLedger
 * @typedef {import('./task-ledger.js').AdmissionRecord}         AdmissionRecord
 * @typedef {import('./task-ledger.js').ExclusionRecord}         ExclusionRecord
 * @typedef {import('./task-ledger.js').ToolAdmissionRecord}     ToolAdmissionRecord
 * @typedef {import('./task-ledger.js').ToolInvocationRecord}    ToolInvocationRecord
 * @typedef {import('./task-ledger.js').ChunkID}                 ChunkID
 * @typedef {import('./task-ledger.js').ToolID}                  ToolID
 * @typedef {import('./task-ledger.js').TurnID}                  TurnID
 * @typedef {import('./task-ledger.js').TaskID}                  TaskID
 *
 * @typedef {import('./diff.js').ProfileDiff}                    ProfileDiff
 * @typedef {import('./diff.js').ProfileDiffEntry}               ProfileDiffEntry
 * @typedef {import('./diff.js').DiffOptions}                    DiffOptions
 */
