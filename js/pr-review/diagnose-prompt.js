// @ts-check
/**
 * LLM messages builder for the PR Review "Diagnose & fix" action.
 *
 * Pure module — given a CI failure context, returns the exact
 * `[{role:'system'},{role:'user'}]` array passed to `LLM.chat`.
 * Extracted so node tests can pin the prompt shape without pulling
 * in any surface or LLM client.
 *
 * The system prompt locks two contracts:
 *   1. Output is JSON only — no commentary, no fences.
 *   2. Exactly one file change — multi-file is a v2 concern.
 *
 * @since 2.14.0
 * @module pr-review/diagnose-prompt
 */

const SYSTEM_PROMPT = [
    'You are a CI-failure diagnostic assistant.',
    '',
    'Given the failed-CI logs of a pull request, the contents of the most',
    'likely target file, and the project tree, propose **exactly one file',
    'change** that fixes the failure. If multiple files appear to need',
    'changes, pick the most likely root cause and explain the others in',
    '`rationale`.',
    '',
    'Output a single JSON object with this schema, and nothing else:',
    '',
    '{',
    '  "path": "<repo-relative path of the file to change>",',
    '  "newContent": "<full new contents of the file>",',
    '  "rationale": "<one or two sentences on why this fixes the failure>"',
    '}',
    '',
    'Constraints:',
    '- `newContent` must be the **complete** file content, not a diff.',
    '- `path` must match a real file path from the project tree.',
    '- Do not include code fences. Do not include commentary outside the',
    '  JSON object. Do not include trailing prose.',
    ''
].join('\n');

/**
 * @param {{
 *   logs: string,
 *   fileContent: string|null,
 *   filePath: string|null,
 *   projectTree: string,
 *   prTitle?: string,
 *   logTotalBytes?: number,
 *   logTruncatedAtCap?: boolean
 * }} ctx
 * @returns {Array<{role:'system'|'user', content:string}>}
 */
export function buildDiagnoseFixMessages(ctx) {
    const {
        logs = '',
        fileContent = null,
        filePath = null,
        projectTree = '',
        prTitle = '',
        logTotalBytes = null,
        logTruncatedAtCap = false
    } = ctx || {};

    const userParts = [];
    if (prTitle) {
        userParts.push(`Pull request: ${prTitle}`);
        userParts.push('');
    }
    userParts.push('## Failed CI logs');
    if (logTruncatedAtCap && typeof logTotalBytes === 'number') {
        userParts.push(`(Tail-truncated; total log was ${logTotalBytes} bytes.)`);
    }
    userParts.push('');
    userParts.push('```');
    userParts.push(logs);
    userParts.push('```');
    userParts.push('');
    userParts.push('## Likely target file');
    if (filePath) {
        userParts.push(`Path: ${filePath}`);
        userParts.push('');
        userParts.push('```');
        userParts.push(typeof fileContent === 'string' ? fileContent : '');
        userParts.push('```');
    } else {
        userParts.push('(No specific file pre-identified — pick from the project tree.)');
    }
    userParts.push('');
    userParts.push('## Project tree');
    userParts.push('');
    userParts.push('```');
    userParts.push(projectTree);
    userParts.push('```');

    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userParts.join('\n') }
    ];
}
