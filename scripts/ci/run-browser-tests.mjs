import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vendorRoot = join(root, 'vendor');
const vendorRequire = createRequire(join(vendorRoot, 'package.json'));
const { build } = vendorRequire('esbuild');
const { firefox } = vendorRequire('playwright');

const SERVED_SOURCE_ROOTS = new Set([
    'assets',
    'css',
    'docs',
    'html',
    'js',
    'plugins',
    'swaggers',
    'tests',
]);
const SERVED_ROOT_FILES = new Set(['CHANGELOG.md', 'index.html']);

const MIME_TYPES = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.md', 'text/markdown; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.wasm', 'application/wasm'],
]);

function outputPathFromArgs() {
    const outputIndex = process.argv.indexOf('--output');
    if (outputIndex === -1) return resolve('browser-test-results.json');
    const value = process.argv[outputIndex + 1];
    if (!value || value.startsWith('--')) throw new Error('--output requires a path');
    return isAbsolute(value) ? value : resolve(value);
}

function isWithin(parent, candidate) {
    const pathFromParent = relative(parent, candidate);
    return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..');
}

function isAllowedSourcePath(pathname) {
    if (pathname === '/') return true;
    const components = pathname.split('/').filter(Boolean);
    if (components.length === 1) return SERVED_ROOT_FILES.has(components[0]);
    return SERVED_SOURCE_ROOTS.has(components[0]);
}

async function buildVendorAssets(destination) {
    await mkdir(destination, { recursive: true });
    const shared = {
        bundle: true,
        format: 'esm',
        minify: true,
        platform: 'browser',
        target: ['es2020'],
        treeShaking: true,
    };
    await build({
        ...shared,
        entryPoints: [join(vendorRoot, 'codemirror-entry.mjs')],
        outfile: join(destination, 'codemirror-bundle.js'),
    });
    await build({
        ...shared,
        entryPoints: [join(vendorRoot, 'preact-htm-entry.mjs')],
        outfile: join(destination, 'preact-htm-bundle.js'),
    });

    const copies = [
        ['node_modules/marked/lib/marked.umd.js', 'marked.min.js'],
        ['node_modules/dompurify/dist/purify.min.js', 'purify.min.js'],
        ['node_modules/jszip/dist/jszip.min.js', 'jszip.min.js'],
        ['node_modules/htmx.org/dist/htmx.min.js', 'htmx.min.js'],
    ];
    await Promise.all(copies.map(([source, target]) =>
        copyFile(join(vendorRoot, source), join(destination, target))));
}

function createStaticServer(generatedVendorRoot) {
    return createServer(async (request, response) => {
        try {
            if (!['GET', 'HEAD'].includes(request.method || '')) {
                response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
                return;
            }
            const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
            const pathname = decodeURIComponent(requestUrl.pathname);
            let candidate;
            let servingRoot;

            if (pathname.startsWith('/tests/vendor/')) {
                servingRoot = generatedVendorRoot;
                candidate = resolve(servingRoot, pathname.slice('/tests/vendor/'.length));
            } else {
                if (!isAllowedSourcePath(pathname)) {
                    response.writeHead(404).end('Not found');
                    return;
                }
                servingRoot = root;
                candidate = resolve(servingRoot, `.${pathname}`);
            }

            if (!isWithin(servingRoot, candidate)) {
                response.writeHead(403).end('Forbidden');
                return;
            }

            let fileStat = await stat(candidate);
            if (fileStat.isDirectory()) {
                candidate = join(candidate, 'index.html');
                if (!isWithin(servingRoot, candidate)) {
                    response.writeHead(403).end('Forbidden');
                    return;
                }
                fileStat = await stat(candidate);
            }
            const canonicalRoot = await realpath(servingRoot);
            candidate = await realpath(candidate);
            if (!isWithin(canonicalRoot, candidate)) {
                response.writeHead(403).end('Forbidden');
                return;
            }
            if (!fileStat.isFile()) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });

            response.writeHead(200, {
                'Cache-Control': 'no-store',
                'Content-Length': fileStat.size,
                'Content-Type': MIME_TYPES.get(extname(candidate)) || 'application/octet-stream',
                'X-Content-Type-Options': 'nosniff',
            });
            if (request.method === 'HEAD') {
                response.end();
                return;
            }
            createReadStream(candidate).pipe(response);
        } catch (error) {
            const statusCode = error?.code === 'ENOENT' ? 404 : 500;
            response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end(statusCode === 404 ? 'Not found' : 'Internal server error');
        }
    });
}

async function listen(server) {
    await new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolvePromise);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP address');
    return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
    if (!server.listening) return;
    await new Promise((resolvePromise, reject) => {
        server.close(error => error ? reject(error) : resolvePromise());
    });
}

function failureMessages(result) {
    const messages = [];
    if (result.failed > 0) messages.push(`${result.failed} browser assertion/import/runtime failure(s)`);
    if (result.runner.pageErrors.length > 0) messages.push(`${result.runner.pageErrors.length} page error(s)`);
    if (result.runner.externalRequests.length > 0) messages.push(`${result.runner.externalRequests.length} external request(s)`);
    if (result.runner.webSocketRequests.length > 0) messages.push(`${result.runner.webSocketRequests.length} WebSocket request(s)`);
    if (result.runner.responseFailures.length > 0) messages.push(`${result.runner.responseFailures.length} local resource failure(s)`);
    return messages;
}

const outputPath = outputPathFromArgs();
const taskRoot = await mkdtemp(join(tmpdir(), 'ai-editor-browser-'));
const generatedVendorRoot = join(taskRoot, 'vendor');
let server;
let browser;
let context;
let finalResult = {
    status: 'runner-error',
    passed: 0,
    failed: 1,
    suiteCount: 0,
    suites: [],
    importFailures: [],
    runtimeErrors: [],
    runner: { browser: 'firefox', externalRequests: [], webSocketRequests: [], responseFailures: [], pageErrors: [] },
};

try {
    await buildVendorAssets(generatedVendorRoot);
    server = createStaticServer(generatedVendorRoot);
    const origin = await listen(server);

    browser = await firefox.launch({ headless: true });
    context = await browser.newContext({ serviceWorkers: 'block' });
    const externalRequests = [];
    const webSocketRequests = [];
    const responseFailures = [];
    const pageErrors = [];

    await context.route('**/*', async route => {
        const parsed = new URL(route.request().url());
        if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin !== origin) {
            externalRequests.push(route.request().url());
            await route.abort('blockedbyclient');
            return;
        }
        await route.continue();
    });
    await context.routeWebSocket(/.*/, async webSocket => {
        webSocketRequests.push(webSocket.url());
        await webSocket.close({ code: 1008, reason: 'WebSockets are not allowed in hermetic browser tests' });
    });

    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
        const resourceType = response.request().resourceType();
        if (response.status() >= 400 && ['document', 'script', 'stylesheet'].includes(resourceType)) {
            responseFailures.push({ status: response.status(), url: response.url(), resourceType });
        }
    });

    await page.goto(`${origin}/tests/index.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(
        () => window.__AI_EDITOR_TEST_RESULTS__?.status === 'complete',
        null,
        { timeout: 120_000 },
    );
    await page.waitForTimeout(100);
    const harnessResult = await page.evaluate(() => window.__AI_EDITOR_TEST_RESULTS__);
    finalResult = {
        ...harnessResult,
        runner: {
            browser: 'firefox',
            externalRequests,
            webSocketRequests,
            responseFailures,
            pageErrors,
        },
    };
} catch (error) {
    finalResult.runtimeErrors.push({ message: error.message, stack: error.stack || '' });
} finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (server) await closeServer(server).catch(() => {});
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(finalResult, null, 2)}\n`);
    await rm(taskRoot, { recursive: true, force: true });
}

const failures = failureMessages(finalResult);
process.stdout.write(`${JSON.stringify({
    status: finalResult.status,
    passed: finalResult.passed,
    failed: finalResult.failed,
    suiteCount: finalResult.suiteCount,
    output: outputPath,
})}\n`);
if (failures.length > 0) {
    process.stderr.write(`${failures.join('; ')}\n`);
    process.exitCode = 1;
}
