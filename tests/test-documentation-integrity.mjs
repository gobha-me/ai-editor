import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const thisFile = fileURLToPath(import.meta.url);
const scanRoots = ['css', 'docs', 'html', 'js', 'tests'];
const rootMarkdown = ['CHANGELOG.md', 'CONTAINERS.md', 'CONTRIBUTING.md', 'README.md', 'REPOS.md'];
const retiredReferences = [
    'docs/audit-2026-Q2',
    'docs/discussion',
    'docs/dogfood-battery',
    'docs/design/',
    'docs/measurements',
    'DESIGN-CHANGES-2026-05-21.md',
    'DESIGN-cross-device-sync.md',
    'DESIGN-persona.md',
    'METHODOLOGY-coherence-at-speed.md',
    'ICD-',
    'DESIGN-git-providers-and-ui-extensions.md',
    'DESIGN-html-inline-handlers-migration.md',
    'inline-handlers migration',
    'ROADMAP §',
    'ROADMAP.md §',
    'DESIGN-sub-agents.md §',
];

async function walk(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await walk(entryPath));
        else if (entry.isFile()) files.push(entryPath);
    }
    return files;
}

test('surviving Markdown has no broken relative links', async () => {
    const markdown = [
        ...rootMarkdown.map(file => path.join(root, file)),
        ...(await walk(path.join(root, 'docs'))).filter(file => file.endsWith('.md')),
    ];
    const broken = [];
    const linkPattern = /\]\(([^)]+)\)/gu;
    for (const file of markdown) {
        const source = await readFile(file, 'utf8');
        for (const match of source.matchAll(linkPattern)) {
            let target = match[1].trim().replace(/^<|>$/gu, '');
            if (!target || target.startsWith('#') || /^(?:https?|mailto):/u.test(target)) continue;
            target = target.split('#', 1)[0];
            const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
            if (!existsSync(resolved)) broken.push(`${path.relative(root, file)} -> ${target}`);
        }
    }
    assert.deepEqual(broken, []);
});

test('active source contains no references to retired context', async () => {
    const files = [];
    for (const directory of scanRoots) files.push(...await walk(path.join(root, directory)));
    files.push(...rootMarkdown.map(file => path.join(root, file)));

    const findings = [];
    for (const file of files.filter(file => file !== thisFile && /\.(?:css|html|js|json|md|mjs)$/u.test(file))) {
        const source = await readFile(file, 'utf8');
        for (const retired of retiredReferences) {
            if (source.includes(retired)) findings.push(`${path.relative(root, file)}: ${retired}`);
        }
    }
    assert.deepEqual(findings, []);
});

test('current documentation remains concise and names one contract layer', async () => {
    const architecture = await readFile(path.join(root, 'docs/ARCHITECTURE.md'), 'utf8');
    const roadmap = await readFile(path.join(root, 'docs/ROADMAP.md'), 'utf8');
    const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');

    assert.ok((await stat(path.join(root, 'docs/ARCHITECTURE.md'))).size < 12_000);
    assert.ok((await stat(path.join(root, 'CHANGELOG.md'))).size < 12_000);
    assert.doesNotMatch(architecture, /Last sync|RE-EVAL/u);
    assert.doesNotMatch(roadmap, /github\.com\/gobha-me\/ai-editor\/issues\/\d+/u);
    assert.match(changelog, /^## \[2\.93\.0\]/mu);
    assert.doesNotMatch(changelog, /^## \[2\.(?:94|95|96)\.0\]/mu);
    assert.equal((await readdir(path.join(root, 'docs'))).some(name => name.startsWith('ICD-')), false);
});
