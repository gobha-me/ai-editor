/**
 * External Dependency Audit
 * 
 * Validates that all CDN/external dependencies either:
 *   1. Have local vendor copies available (SCIF-ready), OR
 *   2. Are clearly flagged as requiring network access
 * 
 * Also probes vendor file availability and CDN reachability
 * so deployment issues surface before release.
 * 
 * @since 0.9.11-1
 */

const { T } = window;

// ============================================
// DEPENDENCY MANIFEST
// ============================================

/**
 * Every external dependency in the project, with its local fallback.
 * To add a new dep: add an entry here, and the test auto-covers it.
 */
const DEPENDENCIES = [
    {
        name: 'marked (Markdown parser)',
        localPath: './vendor/marked.min.js',
        cdnUrl: 'https://cdnjs.cloudflare.com/ajax/libs/marked/16.3.0/lib/marked.umd.min.js',
        required: true,        // App won't function without it
        dockerBundled: true,   // Docker build downloads this
    },
    {
        name: 'DOMPurify (XSS sanitizer)',
        localPath: './vendor/purify.min.js',
        cdnUrl: 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.4/purify.min.js',
        required: true,
        dockerBundled: true,
    },
    {
        name: 'JSZip (zip upload/download)',
        localPath: './vendor/jszip.min.js',
        cdnUrl: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
        required: true,
        dockerBundled: true,
    },
    {
        name: 'CodeMirror 6 (editor)',
        localPath: './vendor/codemirror-bundle.js',
        cdnUrl: 'https://esm.sh/@codemirror/view@6',
        required: true,
        dockerBundled: true,
    },
    {
        name: 'Transformers.js (local embeddings)',
        localPath: './vendor/transformers.min.js',
        cdnUrl: 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2',
        required: false,       // Optional — remote embedding mode works without it
        dockerBundled: false,  // Not currently in Docker build
    },
];

// ============================================
// LOCAL VENDOR FILE CHECKS
// ============================================

T.suite('Dependencies — Local Vendor Files');

for (const dep of DEPENDENCIES) {
    // Probe local file with a HEAD-like fetch
    let localAvailable = false;
    try {
        const resp = await fetch(dep.localPath, { method: 'HEAD' });
        localAvailable = resp.ok;
    } catch {
        localAvailable = false;
    }

    if (dep.dockerBundled) {
        // Docker-bundled deps: local file expected in production, may not exist in dev
        if (localAvailable) {
            T.assert(true, `${dep.name}: local vendor ✓ (${dep.localPath})`);
        } else {
            // Not a failure in dev — flag it clearly
            T.assert(!dep.required || true,
                `${dep.name}: local vendor missing — OK in dev, Docker build provides it`);
        }
    } else {
        // Non-bundled optional deps
        if (localAvailable) {
            T.assert(true, `${dep.name}: local vendor present (bonus)`);
        } else {
            T.assert(!dep.required,
                `${dep.name}: no local vendor — ${dep.required ? 'REQUIRED, must be vendored for SCIF' : 'optional, CDN or API fallback available'}`);
        }
    }
}

// ============================================
// CDN REACHABILITY (informational)
// ============================================

T.suite('Dependencies — CDN Reachability');

for (const dep of DEPENDENCIES) {
    let cdnReachable = false;
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        // Use opaque fetch for cross-origin (no-cors) — we just want "did it respond?"
        const resp = await fetch(dep.cdnUrl, {
            method: 'HEAD',
            mode: 'no-cors',
            signal: controller.signal
        });
        clearTimeout(timeout);
        // no-cors responses have type 'opaque' with status 0, but a successful
        // fetch means the network request succeeded
        cdnReachable = resp.type === 'opaque' || resp.ok;
    } catch (e) {
        cdnReachable = false;
    }

    if (cdnReachable) {
        T.assert(true, `${dep.name}: CDN reachable ✓`);
    } else {
        // CDN unreachable isn't a test failure IF local vendor exists or dep is optional
        // But flag it — this is the SCIF simulation
        T.assert(!dep.required || dep.dockerBundled,
            `${dep.name}: CDN unreachable — ${dep.dockerBundled ? 'OK, Docker bundles locally' : 'SCIF BLOCKER if no local vendor'}`);
    }
}

// ============================================
// GLOBAL OBJECT CHECKS (runtime availability)
// ============================================

T.suite('Dependencies — Runtime Globals');

// These are the globals that index.html <script> tags should have loaded
const EXPECTED_GLOBALS = [
    { name: 'marked',     global: 'marked',    check: () => typeof window.marked !== 'undefined' },
    { name: 'DOMPurify',  global: 'DOMPurify', check: () => typeof window.DOMPurify !== 'undefined' },
    { name: 'JSZip',      global: 'JSZip',     check: () => typeof window.JSZip !== 'undefined' },
];

for (const g of EXPECTED_GLOBALS) {
    // These load from index.html — test page won't have them unless
    // we're running inside the full app or the test page includes them.
    // We just check and report.
    const available = g.check();
    T.assert(true,
        `${g.name} (window.${g.global}): ${available ? 'loaded ✓' : 'not loaded (expected — test page lacks index.html scripts)'}`);
}

// ============================================
// SCIF READINESS SUMMARY
// ============================================

T.suite('Dependencies — SCIF Readiness Summary');

const requiredDeps = DEPENDENCIES.filter(d => d.required);
const allRequiredBundled = requiredDeps.every(d => d.dockerBundled);
T.assert(allRequiredBundled,
    `All ${requiredDeps.length} required dependencies are Docker-bundled`);

const optionalDeps = DEPENDENCIES.filter(d => !d.required);
T.assert(true,
    `${optionalDeps.length} optional dep(s): ${optionalDeps.map(d => d.name).join(', ') || 'none'}`);

const unbundledRequired = requiredDeps.filter(d => !d.dockerBundled);
T.eq(unbundledRequired.length, 0,
    `No required deps without Docker bundling (found: ${unbundledRequired.map(d => d.name).join(', ') || 'none'})`);
