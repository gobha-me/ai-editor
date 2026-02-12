/**
 * Tests for ContextManager.shouldIndex — file path filtering.
 * Validates binary/generated/vendor exclusions and edge cases.
 */
import { ContextManager } from '../js/context-manager.js';

const { T } = window;

// ============================================
// Source files (should index)
// ============================================

T.suite('shouldIndex — Source Files');

T.assert(ContextManager.shouldIndex('src/app.js'), 'JavaScript source');
T.assert(ContextManager.shouldIndex('lib/utils.ts'), 'TypeScript source');
T.assert(ContextManager.shouldIndex('main.py'), 'Python source');
T.assert(ContextManager.shouldIndex('cmd/server/main.go'), 'Go source');
T.assert(ContextManager.shouldIndex('src/lib.rs'), 'Rust source');
T.assert(ContextManager.shouldIndex('README.md'), 'Markdown');
T.assert(ContextManager.shouldIndex('config.yaml'), 'YAML');
T.assert(ContextManager.shouldIndex('config.yml'), 'YML variant');
T.assert(ContextManager.shouldIndex('Makefile'), 'Makefile (no extension)');
T.assert(ContextManager.shouldIndex('docker-compose.yml'), 'Docker compose');
T.assert(ContextManager.shouldIndex('.gitignore'), 'Dotfile with no matching extension');
T.assert(ContextManager.shouldIndex('src/deep/path/component.jsx'), 'Deep path JSX');

// ============================================
// Binary / media (should NOT index)
// ============================================

T.suite('shouldIndex — Binary / Media Exclusions');

T.assert(!ContextManager.shouldIndex('logo.png'), 'PNG image');
T.assert(!ContextManager.shouldIndex('photo.jpg'), 'JPG image');
T.assert(!ContextManager.shouldIndex('icon.svg'), 'SVG image');
T.assert(!ContextManager.shouldIndex('video.mp4'), 'MP4 video');
T.assert(!ContextManager.shouldIndex('audio.mp3'), 'MP3 audio');
T.assert(!ContextManager.shouldIndex('font.woff2'), 'WOFF2 font');
T.assert(!ContextManager.shouldIndex('font.ttf'), 'TTF font');
T.assert(!ContextManager.shouldIndex('archive.zip'), 'ZIP archive');
T.assert(!ContextManager.shouldIndex('archive.tar'), 'TAR archive');
T.assert(!ContextManager.shouldIndex('module.wasm'), 'WebAssembly');
T.assert(!ContextManager.shouldIndex('cache.pyc'), 'Python compiled');
T.assert(!ContextManager.shouldIndex('lib.so'), 'Shared object');
T.assert(!ContextManager.shouldIndex('app.exe'), 'Windows executable');
T.assert(!ContextManager.shouldIndex('data.sqlite'), 'SQLite database');
T.assert(!ContextManager.shouldIndex('report.pdf'), 'PDF document');
T.assert(!ContextManager.shouldIndex('sheet.xlsx'), 'Excel file');

// ============================================
// Lock files (should NOT index)
// ============================================

T.suite('shouldIndex — Lock File Exclusions');

T.assert(!ContextManager.shouldIndex('Cargo.lock'), '.lock extension');
T.assert(!ContextManager.shouldIndex('node_modules/express/package.json'), 'node_modules path');
T.assert(!ContextManager.shouldIndex('package-lock.json'), 'package-lock.json');
T.assert(!ContextManager.shouldIndex('yarn.lock'), 'yarn.lock');
T.assert(!ContextManager.shouldIndex('pnpm-lock.yaml'), 'pnpm-lock.yaml');

// ============================================
// Path pattern exclusions
// ============================================

T.suite('shouldIndex — Path Pattern Exclusions');

T.assert(!ContextManager.shouldIndex('node_modules/lodash/index.js'), 'node_modules/');
T.assert(!ContextManager.shouldIndex('vendor/jquery/jquery.js'), 'vendor/');
T.assert(!ContextManager.shouldIndex('.git/objects/pack/abc'), '.git/');
T.assert(!ContextManager.shouldIndex('dist/bundle.js'), 'dist/');
T.assert(!ContextManager.shouldIndex('build/output.js'), 'build/');
T.assert(!ContextManager.shouldIndex('app.min.js'), '.min.js');
T.assert(!ContextManager.shouldIndex('styles.min.css'), '.min.css');
T.assert(!ContextManager.shouldIndex('vendor.bundle.js'), 'bundle.js');
T.assert(!ContextManager.shouldIndex('styles.bundle.css'), 'bundle.css');

// ============================================
// Edge cases
// ============================================

T.suite('shouldIndex — Edge Cases');

T.assert(!ContextManager.shouldIndex('source.map'), '.map files excluded');
T.assert(ContextManager.shouldIndex('src/mapping.js'), '"map" in filename OK');
T.assert(ContextManager.shouldIndex('src/vendor-utils.js'), '"vendor" in filename OK (not path segment)');
T.assert(ContextManager.shouldIndex('utils/build-helpers.py'), '"build" in filename OK (not path segment)');
T.assert(!ContextManager.shouldIndex('dist/app.js'), 'dist/ path still excluded');
