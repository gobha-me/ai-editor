/**
 * Hermetic runtime dependency audit.
 *
 * The required browser suite serves generated assets from the locked vendor
 * graph. It never probes a CDN: a missing local runtime asset is a failure,
 * and the Playwright runner rejects every unexpected external request.
 */

const { T } = window;

const DEPENDENCIES = [
    { name: 'marked', path: './vendor/marked.min.js', required: true, bundled: true },
    { name: 'DOMPurify', path: './vendor/purify.min.js', required: true, bundled: true },
    { name: 'JSZip', path: './vendor/jszip.min.js', required: true, bundled: true },
    { name: 'Preact + htm', path: './vendor/preact-htm-bundle.js', required: true, bundled: true },
    { name: 'CodeMirror 6', path: './vendor/codemirror-bundle.js', required: true, bundled: true },
    { name: 'htmx', path: './vendor/htmx.min.js', required: true, bundled: true },
    { name: 'Transformers.js', path: './vendor/transformers.min.js', required: false, bundled: false },
];

T.suite('Dependencies — Locked Local Assets');

for (const dependency of DEPENDENCIES) {
    let available = false;
    try {
        const response = await fetch(dependency.path, { method: 'HEAD' });
        available = response.ok;
    } catch {
        available = false;
    }

    if (dependency.required) {
        T.assert(available, `${dependency.name}: required locked asset is served (${dependency.path})`);
    } else {
        T.eq(
            available,
            dependency.bundled,
            `${dependency.name}: optional asset availability matches the bundle policy`,
        );
    }
}

T.suite('Dependencies — Offline Runtime Policy');

const requiredDependencies = DEPENDENCIES.filter(dependency => dependency.required);
T.assert(
    requiredDependencies.every(dependency => dependency.bundled),
    `all ${requiredDependencies.length} required dependencies are locally bundled`,
);
T.deepEq(
    DEPENDENCIES.filter(dependency => !dependency.bundled).map(dependency => dependency.name),
    ['Transformers.js'],
    'only the optional local-embeddings runtime is absent from the application image',
);
