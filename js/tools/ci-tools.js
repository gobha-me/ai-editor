/**
 * AI Editor — CI Tools
 *
 * LLM-facing tools for querying CI state on the active project's Git provider.
 * Used standalone for one-shot status checks AND by the test-driven loop
 * (js/intelligence/test-loop/) to wait on CI between iterations.
 *
 * - get_ci_status({ ref })           — one-shot status snapshot
 * - wait_for_ci({ ref, timeoutMs })  — polls until terminal state or timeout
 * - get_ci_logs({ ref, jobName?, tailLines? }) — fetches a job's tailed log
 */

import { ToolRegistry } from './registry.js';
import { State } from '../core.js';
import { Git } from '../git.js';

// Backoff schedule (ms) for wait_for_ci polling. Steady-state polls every 30s.
const POLL_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

const DEFAULT_WAIT_MS = 5 * 60 * 1000;
const MAX_WAIT_MS = 10 * 60 * 1000;

const DEFAULT_TAIL_LINES = 200;
const MAX_TAIL_LINES = 1000;

const TERMINAL_STATES = new Set(['success', 'failure', 'error', 'cancelled']);

function projectOrError() {
    if (!State.currentProject) {
        return { error: 'No project is currently loaded. Open a project first.' };
    }
    return State.currentProject;
}

function summarizeStatuses(statuses) {
    if (!statuses?.length) return '0 checks';
    const counts = statuses.reduce((acc, s) => {
        const k = s.state || 'unknown';
        acc[k] = (acc[k] || 0) + 1;
        return acc;
    }, {});
    const parts = Object.entries(counts).map(([k, v]) => `${v} ${k}`);
    return `${statuses.length} checks: ${parts.join(', ')}`;
}

function tailLines(text, n) {
    if (!text) return { tail: '', truncated: false, totalBytes: 0 };
    const totalBytes = text.length;
    const lines = text.split('\n');
    if (lines.length <= n) return { tail: text, truncated: false, totalBytes };
    return { tail: lines.slice(-n).join('\n'), truncated: true, totalBytes };
}

// ============================================
// get_ci_status
// ============================================

async function getCiStatus({ ref }) {
    const proj = projectOrError();
    if (proj.error) return proj;
    if (!ref || typeof ref !== 'string') {
        return { error: 'Required argument "ref" (commit SHA or branch name) is missing.' };
    }
    try {
        const status = await Git.getCommitStatus(proj.owner, proj.repo, ref);
        return {
            ref,
            state: status.state || 'unknown',
            total: status.total || 0,
            statuses: status.statuses || [],
            summary: summarizeStatuses(status.statuses || [])
        };
    } catch (e) {
        return { error: `Could not fetch CI status for ${ref}: ${e.message || String(e)}` };
    }
}

ToolRegistry.register('get_ci_status', getCiStatus, {
    type: 'function',
    function: {
        name: 'get_ci_status',
        description: 'Fetch the current CI status for a commit SHA or branch ref. Returns aggregate state plus the individual checks. Useful for reading whether CI passed/failed without waiting.',
        parameters: {
            type: 'object',
            properties: {
                ref: { type: 'string', description: 'Commit SHA or branch name to query.' }
            },
            required: ['ref']
        }
    },
    roles: ['coder']
});

// ============================================
// wait_for_ci
// ============================================

async function waitForCi({ ref, timeoutMs }) {
    const proj = projectOrError();
    if (proj.error) return proj;
    if (!ref || typeof ref !== 'string') {
        return { error: 'Required argument "ref" (commit SHA or branch name) is missing.' };
    }

    const cap = Math.min(
        Math.max(Number(timeoutMs) || DEFAULT_WAIT_MS, 1000),
        MAX_WAIT_MS
    );
    const startedAt = Date.now();
    let attempt = 0;
    let lastStatus = null;

    while (Date.now() - startedAt < cap) {
        try {
            lastStatus = await Git.getCommitStatus(proj.owner, proj.repo, ref);
        } catch (e) {
            // Transient — keep polling but record the error.
            lastStatus = { state: 'unknown', total: 0, statuses: [], _fetchError: e.message };
        }

        const state = lastStatus.state || 'unknown';
        if (TERMINAL_STATES.has(state)) {
            return {
                ref,
                state,
                total: lastStatus.total || 0,
                statuses: lastStatus.statuses || [],
                summary: summarizeStatuses(lastStatus.statuses || []),
                polled_for_ms: Date.now() - startedAt,
                attempts: attempt + 1
            };
        }

        const delay = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)];
        const remaining = cap - (Date.now() - startedAt);
        if (remaining <= 0) break;
        await new Promise(r => setTimeout(r, Math.min(delay, remaining)));
        attempt++;
    }

    return {
        ref,
        state: lastStatus?.state || 'pending',
        total: lastStatus?.total || 0,
        statuses: lastStatus?.statuses || [],
        summary: lastStatus ? summarizeStatuses(lastStatus.statuses || []) : '0 checks',
        polled_for_ms: Date.now() - startedAt,
        attempts: attempt + 1,
        timed_out: true,
        warning: `CI did not reach a terminal state within ${Math.round(cap / 1000)}s. Last state: ${lastStatus?.state || 'pending'}.`
    };
}

ToolRegistry.register('wait_for_ci', waitForCi, {
    type: 'function',
    function: {
        name: 'wait_for_ci',
        description: 'Poll the CI status for a commit SHA or branch until it reaches a terminal state (success/failure/error/cancelled) or the timeout elapses. Backs off from 1s up to 30s between polls. Useful inside agentic loops where the next step depends on CI passing.',
        parameters: {
            type: 'object',
            properties: {
                ref: { type: 'string', description: 'Commit SHA or branch name to wait on.' },
                timeoutMs: { type: 'number', description: `Wall-clock cap in ms (default ${DEFAULT_WAIT_MS}, hard max ${MAX_WAIT_MS}).` }
            },
            required: ['ref']
        }
    },
    roles: ['coder']
});

// ============================================
// get_ci_logs
// ============================================

async function getCiLogs({ ref, jobName, tailLines: tailN }) {
    const proj = projectOrError();
    if (proj.error) return proj;
    if (!ref || typeof ref !== 'string') {
        return { error: 'Required argument "ref" (commit SHA or branch name) is missing.' };
    }

    const tail = Math.min(Math.max(Number(tailN) || DEFAULT_TAIL_LINES, 1), MAX_TAIL_LINES);

    let runs;
    try {
        runs = await Git.listWorkflowRuns(proj.owner, proj.repo);
    } catch (e) {
        return { error: `Could not list workflow runs: ${e.message || String(e)}` };
    }
    if (!runs || runs.length === 0) {
        return { error: 'No workflow runs visible to the active provider. CI Actions may be disabled for this repo.' };
    }

    // Resolve ref → most-recent run for that SHA. ref may be a short SHA.
    const refLow = ref.toLowerCase();
    const matching = runs.filter(r => {
        const sha = (r.headSha || '').toLowerCase();
        return sha && (sha === refLow || sha.startsWith(refLow) || refLow.startsWith(sha));
    });
    const candidate = matching[0] || runs[0];
    if (!candidate) {
        return { error: `No workflow run found for ref ${ref}.` };
    }
    const usedFallback = !matching.length;

    let jobs;
    try {
        jobs = await Git.listWorkflowJobs(proj.owner, proj.repo, candidate.id);
    } catch (e) {
        return { error: `Could not list jobs for run ${candidate.id}: ${e.message || String(e)}` };
    }
    if (!jobs || jobs.length === 0) {
        return {
            run_id: candidate.id,
            error: `Run ${candidate.id} has no jobs (yet). Status: ${candidate.status || 'unknown'}.`
        };
    }

    let job;
    if (jobName) {
        job = jobs.find(j => j.name === jobName);
        if (!job) {
            return {
                run_id: candidate.id,
                error: `No job named "${jobName}" in run ${candidate.id}. Available: ${jobs.map(j => j.name).join(', ')}.`
            };
        }
    } else {
        // Default: first failed job; otherwise first job.
        const failedConclusions = new Set(['failure', 'error', 'cancelled']);
        job = jobs.find(j => failedConclusions.has(j.conclusion)) || jobs[0];
    }

    let logText;
    try {
        logText = await Git.getJobLog(proj.owner, proj.repo, job.id);
    } catch (e) {
        return { error: `Could not fetch log for job ${job.id}: ${e.message || String(e)}` };
    }
    if (logText == null) {
        return {
            run_id: candidate.id,
            job_id: job.id,
            job_name: job.name,
            conclusion: job.conclusion,
            error: 'Provider returned no log content. The job may still be running, or logs may have expired.'
        };
    }

    const { tail: logTail, truncated, totalBytes } = tailLines(logText, tail);
    return {
        run_id: candidate.id,
        run_head_sha: candidate.headSha || null,
        job_id: job.id,
        job_name: job.name,
        conclusion: job.conclusion,
        log_tail: logTail,
        truncated,
        total_bytes: totalBytes,
        tail_lines: tail,
        used_fallback_run: usedFallback,
        ...(usedFallback ? { warning: `No run matched ref ${ref}; returned the most recent run (${candidate.headSha || 'unknown SHA'}).` } : {})
    };
}

ToolRegistry.register('get_ci_logs', getCiLogs, {
    type: 'function',
    function: {
        name: 'get_ci_logs',
        description: 'Fetch the tailed log output of a CI job for a given commit SHA. Defaults to the first failed job in the most recent matching run. Truncates to a line cap so log size stays bounded. Use this after wait_for_ci returns a failure to diagnose what broke.',
        parameters: {
            type: 'object',
            properties: {
                ref: { type: 'string', description: 'Commit SHA or branch name. Used to find the matching workflow run.' },
                jobName: { type: 'string', description: 'Optional: specific job name to fetch. If omitted, picks the first failed job (or the first job if all passed).' },
                tailLines: { type: 'number', description: `Optional: how many trailing log lines to return (default ${DEFAULT_TAIL_LINES}, hard max ${MAX_TAIL_LINES}).` }
            },
            required: ['ref']
        }
    },
    roles: ['coder']
});

// Exported for tests; not part of the LLM-facing surface.
export const __test__ = {
    getCiStatus,
    waitForCi,
    getCiLogs,
    summarizeStatuses,
    tailLines,
    POLL_BACKOFF_MS,
    DEFAULT_WAIT_MS,
    MAX_WAIT_MS,
    DEFAULT_TAIL_LINES,
    MAX_TAIL_LINES,
    TERMINAL_STATES
};
