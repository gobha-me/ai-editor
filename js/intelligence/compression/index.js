// @ts-check
/**
 * Compression module barrel — single entry point for the conversation-
 * history compaction subsystem landed in 1.2.0.
 *
 * Phase 1 surface (per `docs/ROADMAP.md` §1.2.0):
 *   - Decision factories + type guards  (`decisions.js`)
 *   - Token estimation                   (`tokens.js`)
 *   - Turn-store conversion helpers      (`turn-store.js`)
 *   - Rules 1 (Subsumption), 2 (Invalidation), 5 (Summarization adapter)
 *   - Compactor pipeline runner          (`compactor.js`)
 *
 * Subsequent tracks:
 *   - 1.2.2 Rule 3 Consumption
 *   - 1.2.3 Rule 4 Resolution
 *   - 1.2.4 tighter Rule 5 integration
 *
 * @module intelligence/compression
 */

export {
    Keep, Drop, Replace, Summarize,
    isKeep, isDrop, isReplace, isSummarize, isDecision,
} from './decisions.js';

export {
    CHARS_PER_TOKEN,
    estimateTokens,
    sumTokens,
} from './tokens.js';

export {
    makeTurnId,
    chatMessageToTurn,
    chatHistoryToTurns,
    turnsToChatMessages,
    makeSynthesizedTurn,
} from './turn-store.js';

export { compress, Compactor } from './compactor.js';

export {
    SUBSUMPTION_RULE,
    SUBSUMPTION_PRIORITY,
    rangeContains,
} from './rules/subsumption.js';

export {
    INVALIDATION_RULE,
    INVALIDATION_PRIORITY,
    rangesOverlap,
} from './rules/invalidation.js';

export {
    SUMMARIZATION_RULE,
    SUMMARIZATION_PRIORITY,
    wrapChatSummarizer,
} from './rules/summarization.js';

/**
 * Re-export typedefs so consumers can `import('./intelligence/compression')`
 * and pick up the type aliases without importing each file individually.
 *
 * @typedef {import('./contracts.js').Turn}                Turn
 * @typedef {import('./contracts.js').TurnRole}            TurnRole
 * @typedef {import('./contracts.js').TurnID}              TurnID
 * @typedef {import('./contracts.js').TurnMetadata}        TurnMetadata
 * @typedef {import('./contracts.js').FileOp}              FileOp
 * @typedef {import('./contracts.js').Decision}            Decision
 * @typedef {import('./contracts.js').KeepDecision}        KeepDecision
 * @typedef {import('./contracts.js').DropDecision}        DropDecision
 * @typedef {import('./contracts.js').ReplaceDecision}     ReplaceDecision
 * @typedef {import('./contracts.js').SummarizeDecision}   SummarizeDecision
 * @typedef {import('./contracts.js').CompressionRule}     CompressionRule
 * @typedef {import('./contracts.js').CompressionRequest}  CompressionRequest
 * @typedef {import('./contracts.js').CompressionResult}   CompressionResult
 * @typedef {import('./contracts.js').Diagnostics}         Diagnostics
 * @typedef {import('./contracts.js').SummarizedSpan}      SummarizedSpan
 * @typedef {import('./contracts.js').SummarizerFn}        SummarizerFn
 */
