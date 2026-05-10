/**
 * Zip Export Module — Touch 3 zip-flow
 *
 * Builds a downloadable .zip blob from a repo or branch via Git provider APIs.
 * Mirrors the upload-side module at `js/zip-upload.js` but goes the other way.
 *
 * The driver functions (exportProjectAsZip / exportBranchAsZip) walk the file
 * tree via Git.getFileTree, fetch each leaf with bounded concurrency, build a
 * JSZip blob, and trigger a browser download. Pure helpers are factored out
 * for Node testability — JSZip is injected as a constructor argument so tests
 * can mock it without loading the vendored library.
 *
 * Binary files (provider returns `encoding: 'base64'`) are zipped with
 * `{ base64: true }`. Text files go in verbatim — JSZip accepts strings.
 *
 * Concurrency cap mirrors the worker-pool precedent at branch-panel.js for
 * per-branch metadata fanout. 6 parallel fetches is well below provider
 * rate-limit thresholds and finishes a 500-file repo in seconds.
 */
import { Git } from './git.js';

const CONCURRENCY = 6;
const WARN_FILE_COUNT = 100;
const WARN_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB

// ============================================
// PURE HELPERS
// ============================================

/**
 * Filter a getFileTree result down to file leaves only.
 * @param {Array} treeEntries — getFileTree output, may include dirs
 * @returns {Array<{path: string, size?: number}>}
 */
export function filterFileLeaves(treeEntries) {
    if (!Array.isArray(treeEntries)) return [];
    return treeEntries.filter(e =>
        e && e.type === 'file' && typeof e.path === 'string' && e.path.length > 0
    );
}

/**
 * Estimate total bytes from a leaves array. Missing sizes contribute 0.
 */
export function estimateTotalBytes(leaves) {
    if (!Array.isArray(leaves)) return 0;
    return leaves.reduce((sum, e) => sum + (typeof e?.size === 'number' ? e.size : 0), 0);
}

/**
 * Build the default zip filename `${repo}-${branch}-YYYY-MM-DD.zip`.
 * Sanitizes repo and branch through the same regex zip-upload uses for
 * repo-name generation, then assembles UTC date components.
 */
export function defaultZipFilename({ repo, branch, date = new Date() } = {}) {
    const safe = (s) => String(s || '')
        .replace(/[^a-zA-Z0-9._-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const r = safe(repo) || 'project';
    const b = safe(branch) || 'main';
    return `${r}-${b}-${yyyy}-${mm}-${dd}.zip`;
}

/**
 * Returns `{fileCount, totalBytes}` when the caller should warn-and-confirm
 * before generating; `null` when the export is small enough to proceed silently.
 */
export function shouldWarnBeforeGenerate(leaves, { fileCap = WARN_FILE_COUNT, byteCap = WARN_TOTAL_BYTES } = {}) {
    if (!Array.isArray(leaves)) return null;
    const fileCount = leaves.length;
    const totalBytes = estimateTotalBytes(leaves);
    if (fileCount > fileCap || totalBytes > byteCap) {
        return { fileCount, totalBytes };
    }
    return null;
}

/**
 * Build a Blob from an entries array. Takes a JSZip constructor as a
 * parameter so tests can inject a mock; in browser callers pass
 * `globalThis.JSZip`.
 *
 * @param {Array<{path: string, content: string, isBinary?: boolean}>} entries
 * @param {Function} JSZipCtor
 * @returns {Promise<Blob>}
 */
export async function buildZipBlob(entries, JSZipCtor) {
    if (typeof JSZipCtor !== 'function') {
        throw new Error('buildZipBlob: JSZip constructor is required');
    }
    if (!Array.isArray(entries)) {
        throw new Error('buildZipBlob: entries must be an array');
    }
    const zip = new JSZipCtor();
    for (const e of entries) {
        if (!e || typeof e.path !== 'string' || e.path.length === 0) continue;
        if (e.isBinary) {
            zip.file(e.path, e.content, { base64: true });
        } else {
            zip.file(e.path, e.content);
        }
    }
    return zip.generateAsync({ type: 'blob' });
}

// ============================================
// I/O DRIVER
// ============================================

/**
 * Fetch every file leaf in parallel with bounded concurrency.
 *
 * `getFile` defaults to `Git.getFile`; tests inject a mock. Returns the
 * `{path, content, isBinary}` array in tree order with failed fetches
 * removed (warning logged, never thrown).
 */
export async function fetchAllFiles({
    owner, repo, ref, leaves,
    getFile = Git.getFile.bind(Git),
    concurrency = CONCURRENCY,
    onProgress
} = {}) {
    if (!Array.isArray(leaves)) throw new Error('fetchAllFiles: leaves array required');
    const total = leaves.length;
    const results = new Array(total);
    let cursor = 0;
    let done = 0;

    async function worker() {
        while (true) {
            const idx = cursor++;
            if (idx >= total) return;
            const leaf = leaves[idx];
            try {
                const file = await getFile(owner, repo, leaf.path, ref);
                results[idx] = {
                    path: leaf.path,
                    content: file?.content ?? '',
                    isBinary: file?.encoding === 'base64'
                };
            } catch (err) {
                console.warn(`[zip-export] Failed to fetch ${leaf.path}:`, err?.message || err);
                results[idx] = null;
            }
            done++;
            if (typeof onProgress === 'function') {
                onProgress({ done, total });
            }
        }
    }

    const workerCount = Math.max(1, Math.min(concurrency, total || 1));
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results.filter(Boolean);
}

/**
 * Trigger a browser download of a Blob. No-op outside the browser.
 */
export function triggerDownload(blob, filename) {
    if (typeof document === 'undefined' || typeof URL === 'undefined') return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================
// HIGH-LEVEL EXPORTS
// ============================================

/**
 * Walk repo at `ref`, fetch all files, zip, download. Returns
 * `{filename, files}` on success, `null` if user cancels at the
 * warn-and-confirm gate.
 *
 * @param {Object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} [opts.ref='main']
 * @param {string} [opts.filename]
 * @param {Function} [opts.onProgress] — `({phase, done?, total?, filename?, files?})`
 * @param {Function} [opts.confirm] — `async ({fileCount, totalBytes}) => boolean`
 */
export async function exportRepoAsZip({ owner, repo, ref = 'main', filename, onProgress, confirm } = {}) {
    if (!owner || !repo) {
        throw new Error('exportRepoAsZip: owner and repo are required');
    }

    if (typeof onProgress === 'function') onProgress({ phase: 'walking' });
    const tree = await Git.getFileTree(owner, repo, ref);
    const leaves = filterFileLeaves(tree);
    if (leaves.length === 0) {
        throw new Error(`No files found at ${owner}/${repo}@${ref}`);
    }

    const warn = shouldWarnBeforeGenerate(leaves);
    if (warn && typeof confirm === 'function') {
        const ok = await confirm(warn);
        if (!ok) return null;
    }

    if (typeof onProgress === 'function') {
        onProgress({ phase: 'fetching', done: 0, total: leaves.length });
    }
    const files = await fetchAllFiles({
        owner, repo, ref, leaves,
        onProgress: ({ done, total }) => {
            if (typeof onProgress === 'function') onProgress({ phase: 'fetching', done, total });
        }
    });

    if (typeof onProgress === 'function') onProgress({ phase: 'zipping' });
    const JSZipCtor = typeof globalThis !== 'undefined' ? globalThis.JSZip : null;
    if (typeof JSZipCtor !== 'function') {
        throw new Error('JSZip is not available — vendor script may not have loaded');
    }
    const blob = await buildZipBlob(files, JSZipCtor);

    const finalName = filename || defaultZipFilename({ repo, branch: ref });
    triggerDownload(blob, finalName);

    if (typeof onProgress === 'function') {
        onProgress({ phase: 'done', filename: finalName, files: files.length });
    }
    return { filename: finalName, files: files.length };
}

/** Project zip — typical caller passes `State.currentBranch` as `branch`. */
export async function exportProjectAsZip({ owner, repo, branch = 'main', filename, onProgress, confirm } = {}) {
    return exportRepoAsZip({ owner, repo, ref: branch, filename, onProgress, confirm });
}

/** Branch zip — explicit branch ref required. */
export async function exportBranchAsZip({ owner, repo, branch, filename, onProgress, confirm } = {}) {
    if (!branch) throw new Error('exportBranchAsZip: branch is required');
    return exportRepoAsZip({ owner, repo, ref: branch, filename, onProgress, confirm });
}
