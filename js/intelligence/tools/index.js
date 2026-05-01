// @ts-check
/**
 * Public surface of the tools-admission subsystem.
 *
 * Phase 1 / 1.3.4 shipped the data foundation: the `Catalog` adapter and
 * the `computeToolID` hash. PR 2 / 1.3.14 adds the Composer (static
 * admission + authorization + budget packing) and `renderForLLM` for the
 * OpenAI tool-array rendering. Meta-tools, sticky admission, and lazy
 * expansion arrive in subsequent PRs.
 *
 * Consumers should import from this barrel rather than reaching into
 * sibling modules, so the public surface remains the only commitment
 * across PRs.
 *
 * @module intelligence/tools
 */

export { Catalog } from './catalog.js';
export { computeToolID } from './tool-id.js';
export { composeAdmission, renderForLLM } from './composer.js';
