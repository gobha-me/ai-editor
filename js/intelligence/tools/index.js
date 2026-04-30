// @ts-check
/**
 * Public surface of the tools-admission subsystem.
 *
 * Phase 1 / 1.3.4 ships only the data foundation: the `Catalog` adapter
 * and the `computeToolID` hash. The Composer (admission algorithm) lands
 * in 1.4.0 PR 2; meta-tools in PR 3; sticky admission in PR 4.
 *
 * Consumers should import from this barrel rather than reaching into
 * sibling modules, so the public surface remains the only commitment
 * across PRs.
 *
 * @module intelligence/tools
 */

export { Catalog } from './catalog.js';
export { computeToolID } from './tool-id.js';
