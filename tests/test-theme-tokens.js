/**
 * Tests for the `--tk-*` theme token contract (1.3.5+).
 *
 * What these assert:
 *   1. The frozen vocabulary resolves under `:root` to non-empty values.
 *      A token without a value is the failure mode that breaks plugin
 *      themes silently — the test exists to make that mode visible.
 *   2. The alias bridge in `css/base.css` works: legacy variable names
 *      (`--bg-primary`, `--accent`, etc.) resolve to the same value as
 *      their `--tk-*` counterpart. If this drifts, component CSS reads
 *      one value while authors think they're styling another.
 *   3. Switching `data-theme` attribute updates resolved values without
 *      reload — the live-swap path the Settings → Appearance dropdown
 *      relies on.
 *
 * These tests inject the theme stylesheets via dynamic <link> elements
 * because tests/index.html only loads its own test harness CSS, not the
 * app stylesheets. The theme contract is a runtime concern — it's the
 * resolved values under `getComputedStyle(documentElement)` that matter,
 * not whether the file parsed.
 */

const { T } = window;

// Inject tokens.css + refined.css + base.css so the alias bridge can
// resolve. Done in this order to mirror index.html's load order.
async function loadThemeStylesheets() {
    const links = [
        '../css/themes/tokens.css',
        '../css/themes/refined.css',
        '../css/base.css',
    ];
    for (const href of links) {
        // Skip if a link with the same href already exists (test re-runs).
        if (document.querySelector(`link[href="${href}"]`)) continue;
        await new Promise((resolve, reject) => {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = href;
            link.onload = resolve;
            link.onerror = () => reject(new Error(`failed to load ${href}`));
            document.head.appendChild(link);
        });
    }
}

await loadThemeStylesheets();

// ── Vocabulary resolves ──────────────────────────────────────────────
// Every token defined in tokens.css must resolve to a non-empty value.
// Drift from this list = drift from the public contract; update both
// in lockstep when adding/removing tokens.
const REQUIRED_TOKENS = [
    // Backgrounds
    '--tk-bg-darker', '--tk-bg-app', '--tk-bg-surface', '--tk-bg-raised',
    '--tk-bg-hover', '--tk-bg-active', '--tk-bg-overlay',
    // Text
    '--tk-text-primary', '--tk-text-secondary', '--tk-text-muted',
    '--tk-text-on-accent', '--tk-text-on-light',
    // Brand accent
    '--tk-color-accent', '--tk-color-accent-hover',
    // Semantic
    '--tk-color-success', '--tk-color-warning', '--tk-color-warning-strong',
    '--tk-color-error', '--tk-color-danger', '--tk-color-info',
    // Diff
    '--tk-color-diff-add', '--tk-color-diff-remove',
    // Issue / PR
    '--tk-color-pr', '--tk-color-merged', '--tk-color-orange', '--tk-color-gold',
    // Memory
    '--tk-color-memory',
    // Borders
    '--tk-border', '--tk-border-light',
    // Radii
    '--tk-radius-sm', '--tk-radius-md', '--tk-radius-lg', '--tk-radius-xl',
    '--tk-radius-pill',
    // Spacing
    '--tk-space-1', '--tk-space-2', '--tk-space-3', '--tk-space-4',
    '--tk-space-5', '--tk-space-6', '--tk-space-8',
    // Fonts
    '--tk-font-sans', '--tk-font-serif', '--tk-font-mono',
    // Shadows
    '--tk-shadow-sm', '--tk-shadow-md', '--tk-shadow-lg',
];

T.suite('Theme tokens — vocabulary resolves under :root');

const root = document.documentElement;
function resolved(name) {
    return getComputedStyle(root).getPropertyValue(name).trim();
}

for (const tok of REQUIRED_TOKENS) {
    T.assert(resolved(tok).length > 0, `${tok} resolves to a non-empty value`);
}

// ── Alias bridge integrity ───────────────────────────────────────────
// The legacy vars in base.css must resolve to the same final value as
// their --tk-* token. If color-mix or var() chaining drops a level,
// component CSS will paint a different color than the theme intends.
T.suite('Theme tokens — alias bridge integrity');

const bridges = [
    ['--bg-primary',     '--tk-bg-app'],
    ['--bg-secondary',   '--tk-bg-surface'],
    ['--bg-tertiary',    '--tk-bg-raised'],
    ['--bg-hover',       '--tk-bg-hover'],
    ['--bg-active',      '--tk-bg-active'],
    ['--text-primary',   '--tk-text-primary'],
    ['--text-secondary', '--tk-text-secondary'],
    ['--text-muted',     '--tk-text-muted'],
    ['--accent',         '--tk-color-accent'],
    ['--accent-hover',   '--tk-color-accent-hover'],
    ['--success',        '--tk-color-success'],
    ['--warning',        '--tk-color-warning'],
    ['--error',          '--tk-color-error'],
    ['--danger',         '--tk-color-danger'],
    ['--border',         '--tk-border'],
    ['--border-light',   '--tk-border-light'],
];

// Probe element so we resolve via the cascade rather than custom-prop
// raw text. This catches the case where one var is defined but its
// referenced var is not — getComputedStyle on an actual property
// resolves the chain.
const probe = document.createElement('div');
probe.style.position = 'absolute';
probe.style.visibility = 'hidden';
document.body.appendChild(probe);

for (const [legacy, tk] of bridges) {
    probe.style.color = `var(${legacy})`;
    const legacyResolved = getComputedStyle(probe).color;
    probe.style.color = `var(${tk})`;
    const tkResolved = getComputedStyle(probe).color;
    T.assert(
        legacyResolved === tkResolved,
        `${legacy} resolves to the same color as ${tk} ` +
        `(legacy=${legacyResolved}, tk=${tkResolved})`
    );
}

probe.remove();

// ── Theme switch updates resolved values ────────────────────────────
// Setting data-theme="editorial" should change the resolved values
// without any other DOM mutation. The dropdown live-swap path depends
// on this.
T.suite('Theme tokens — data-theme switch updates resolved values');

// Inject Editorial theme so the [data-theme="editorial"] selector
// has rules to apply.
await new Promise((resolve, reject) => {
    if (document.querySelector('link[href="../css/themes/editorial.css"]')) {
        resolve();
        return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '../css/themes/editorial.css';
    link.onload = resolve;
    link.onerror = () => reject(new Error('failed to load editorial.css'));
    document.head.appendChild(link);
});

const refinedAccent = resolved('--tk-color-accent');
root.setAttribute('data-theme', 'editorial');
const editorialAccent = resolved('--tk-color-accent');

T.assert(
    refinedAccent !== editorialAccent,
    `--tk-color-accent differs between Refined (${refinedAccent}) ` +
    `and Editorial (${editorialAccent}) — proves theme switch works`
);

// Switch back so we leave the harness in a clean state.
root.setAttribute('data-theme', 'refined');
T.assert(
    resolved('--tk-color-accent') === refinedAccent,
    'switching back to refined restores the accent value'
);
