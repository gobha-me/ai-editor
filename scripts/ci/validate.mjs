#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const VERSION_RE = /^export const VERSION = '([^']+)';/m;
const RELEASE_HEADING_RE = /^## \[([0-9]+(?:\.[0-9]+){2})\](?:\s+-\s+\d{4}-\d{2}-\d{2})?\s*$/m;
const THREE_SEGMENT_RE = /^\d+\.\d+\.\d+$/;
const FOUR_SEGMENT_RE = /^\d+\.\d+\.\d+\.\d+$/;
const HEX_RE = /#[0-9a-fA-F]{3,8}\b/;
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.json']);
const INVISIBLE_RANGES = [
    [0xe0000, 0xe007f],
    [0x200b, 0x200f],
    [0x2060, 0x206f],
    [0xfeff, 0xfeff],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
];

function compareThreeSegmentVersions(left, right) {
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);
    for (let index = 0; index < 3; index += 1) {
        if (leftParts[index] !== rightParts[index]) {
            return leftParts[index] < rightParts[index] ? -1 : 1;
        }
    }
    return 0;
}

export function validateVersionText(versionSource, changelogSource, releaseTag = null) {
    const version = VERSION_RE.exec(versionSource)?.[1] ?? '';
    const latestRelease = RELEASE_HEADING_RE.exec(changelogSource)?.[1] ?? '';

    if (!version) throw new Error('Could not parse VERSION from js/version.js');
    if (!latestRelease) throw new Error('Could not find a released X.Y.Z heading in CHANGELOG.md');

    if (FOUR_SEGMENT_RE.test(version)) {
        const target = version.slice(0, version.lastIndexOf('.'));
        if (target === latestRelease) {
            throw new Error(`In-flight version ${version} conflicts with released ${latestRelease}`);
        }
        if (compareThreeSegmentVersions(target, latestRelease) < 0) {
            throw new Error(`In-flight target ${target} must be newer than released ${latestRelease}`);
        }
        if (!/^## \[Unreleased\]\s*$/m.test(changelogSource)) {
            throw new Error('In-flight versions require a CHANGELOG.md [Unreleased] section');
        }
        if (releaseTag) throw new Error(`In-flight version ${version} cannot be released`);
        return { version, latestRelease, inFlight: true };
    }

    if (!THREE_SEGMENT_RE.test(version)) {
        throw new Error(`VERSION must be X.Y.Z or X.Y.Z.N, got ${version}`);
    }
    if (version !== latestRelease) {
        throw new Error(`Version drift: js/version.js=${version}, CHANGELOG.md=${latestRelease}`);
    }
    if (releaseTag && releaseTag !== `v${version}`) {
        throw new Error(`Release tag ${releaseTag} does not match v${version}`);
    }
    return { version, latestRelease, inFlight: false };
}

export function findUnsafeRawReturns(source) {
    return source.split(/\r?\n/u)
        .map((line, index) => ({ line: index + 1, text: line }))
        .filter(({ text }) => text.includes('return raw;'));
}

export function findInvisibleUnicode(source) {
    const findings = [];
    let line = 1;
    let column = 1;
    for (const character of source) {
        const codePoint = character.codePointAt(0);
        if (INVISIBLE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)) {
            findings.push({ line, column, codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}` });
        }
        if (character === '\n') {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    return findings;
}

export function findThemeTokenViolations(source) {
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//gu, comment => comment.replace(/[^\r\n]/gu, ' '));
    return withoutComments.split(/\r?\n/u)
        .map((line, index) => ({ line: index + 1, text: line }))
        .filter(({ text }) => HEX_RE.test(text) && !text.includes('var(--'));
}

function walkFiles(directory) {
    if (!fs.existsSync(directory)) return [];
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...walkFiles(entryPath));
        else if (entry.isFile()) files.push(entryPath);
    }
    return files;
}

function formatFindings(root, file, findings) {
    return findings.map(finding => {
        const suffix = finding.codePoint ? ` ${finding.codePoint}` : '';
        return `${path.relative(root, file)}:${finding.line}${suffix}`;
    });
}

export function validateRepository(root, { releaseTag = null } = {}) {
    const errors = [];
    const versionSource = fs.readFileSync(path.join(root, 'js/version.js'), 'utf8');
    const changelogSource = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    let versionResult;
    try {
        versionResult = validateVersionText(versionSource, changelogSource, releaseTag);
    } catch (error) {
        errors.push(error.message);
    }

    for (const file of walkFiles(path.join(root, 'js')).filter(file => file.endsWith('.js'))) {
        errors.push(...formatFindings(root, file, findUnsafeRawReturns(fs.readFileSync(file, 'utf8')))
            .map(finding => `Unsafe raw HTML fallback: ${finding}`));
    }

    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    if (!dockerfile.includes('purify.min.js')) {
        errors.push('Dockerfile does not install the DOMPurify runtime asset purify.min.js');
    }

    for (const directory of ['js', 'plugins', 'tests']) {
        for (const file of walkFiles(path.join(root, directory))
            .filter(file => SCANNED_EXTENSIONS.has(path.extname(file)))) {
            errors.push(...formatFindings(root, file, findInvisibleUnicode(fs.readFileSync(file, 'utf8')))
                .map(finding => `Invisible Unicode: ${finding}`));
        }
    }

    const themesRoot = path.resolve(root, 'css/themes');
    for (const file of walkFiles(path.join(root, 'css')).filter(file => file.endsWith('.css'))) {
        if (path.resolve(file).startsWith(`${themesRoot}${path.sep}`)) continue;
        errors.push(...formatFindings(root, file, findThemeTokenViolations(fs.readFileSync(file, 'utf8')))
            .map(finding => `Standalone theme color: ${finding}`));
    }

    if (errors.length) throw new Error(errors.join('\n'));
    return versionResult;
}

function parseArguments(argv) {
    const releaseTagIndex = argv.indexOf('--release-tag');
    if (releaseTagIndex === -1) return { releaseTag: null };
    const releaseTag = argv[releaseTagIndex + 1];
    if (!releaseTag) throw new Error('--release-tag requires a value');
    return { releaseTag };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const result = validateRepository(process.cwd(), parseArguments(process.argv.slice(2)));
        console.log(`CI source policy passed for ${result.version}${result.inFlight ? ' (in flight)' : ''}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
