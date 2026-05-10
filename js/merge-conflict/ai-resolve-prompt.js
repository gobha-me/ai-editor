// @ts-check
/**
 * LLM messages builder for the Merge Conflict Resolver "AI resolve per
 * hunk" action.
 *
 * Pure module — given a single conflict hunk's `theirs` and `ours` line
 * arrays plus a few lines of unchanged context above and below, returns
 * the exact `[{role:'system'},{role:'user'}]` array passed to
 * `LLM.chat`. Same shape as
 * [`js/pr-review/diagnose-prompt.js`](../pr-review/diagnose-prompt.js)
 * — extracted so node tests can pin the prompt without pulling in any
 * surface or LLM client.
 *
 * The system prompt locks two contracts:
 *   1. Output is JSON only — no commentary, no fences.
 *   2. `resolvedLines` is an array of strings, one per output line, no
 *      `\n` inside elements.
 *
 * @since 2.21.0 (Touch 3 Merge Conflict Resolver — slice 3)
 * @module merge-conflict/ai-resolve-prompt
 */

const SYSTEM_PROMPT = [
    'You are a merge-conflict resolution assistant.',
    '',
    'Given the two diverging variants of a code region — `Incoming` (the',
    'base branch) and `Current` (the head branch) — plus the unchanged',
    'code immediately above and below, propose the **single resolved',
    'variant** that preserves the intent of both sides. If the changes',
    'are orthogonal, combine them; if they conflict semantically, prefer',
    'the variant that keeps the program well-formed and explain the',
    'tradeoff in `rationale`.',
    '',
    'Output a single JSON object with this schema, and nothing else:',
    '',
    '{',
    '  "resolvedLines": ["<line 1>", "<line 2>", ...],',
    '  "rationale": "<one or two sentences>"',
    '}',
    '',
    'Constraints:',
    '- `resolvedLines` is an array of strings, one per output line.',
    '- Do not include `\\n` characters inside any element of',
    '  `resolvedLines`. One element = one line.',
    '- Do not include code fences. Do not include commentary outside the',
    '  JSON object. Do not include trailing prose.',
    '- Do not invent symbols not present in either variant or in the',
    '  surrounding context.',
    ''
].join('\n');

/**
 * @param {{
 *   filePath: string,
 *   theirs: string[],
 *   ours: string[],
 *   contextBefore: string[],
 *   contextAfter: string[]
 * }} ctx
 * @returns {Array<{role:'system'|'user', content:string}>}
 */
export function buildAiResolveMessages(ctx) {
    const {
        filePath = '',
        theirs = [],
        ours = [],
        contextBefore = [],
        contextAfter = []
    } = ctx || {};

    const userParts = [];
    userParts.push(`## File`);
    userParts.push(filePath || '(unknown)');
    userParts.push('');

    userParts.push('## Context before');
    if (contextBefore.length === 0) {
        userParts.push('(top of file)');
    } else {
        userParts.push('```');
        for (const line of contextBefore) userParts.push(line);
        userParts.push('```');
    }
    userParts.push('');

    userParts.push('## Incoming (base branch)');
    if (theirs.length === 0) {
        userParts.push('(empty — pure insert on the head side)');
    } else {
        userParts.push('```');
        for (const line of theirs) userParts.push(line);
        userParts.push('```');
    }
    userParts.push('');

    userParts.push('## Current (head branch)');
    if (ours.length === 0) {
        userParts.push('(empty — pure delete on the head side)');
    } else {
        userParts.push('```');
        for (const line of ours) userParts.push(line);
        userParts.push('```');
    }
    userParts.push('');

    userParts.push('## Context after');
    if (contextAfter.length === 0) {
        userParts.push('(end of file)');
    } else {
        userParts.push('```');
        for (const line of contextAfter) userParts.push(line);
        userParts.push('```');
    }

    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userParts.join('\n') }
    ];
}
