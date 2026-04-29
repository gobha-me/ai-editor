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
 */
