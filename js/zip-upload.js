/**
 * Zip Upload Module
 * 
 * Extracts zip files in the browser via JSZip, previews contents,
 * and commits to the active repo via the Git provider API.
 * 
 * Flow:
 *   1. User selects/drops a .zip
 *   2. JSZip extracts in-memory
 *   3. File tree shown with checkboxes for selection
 *   4. Optional: "Scan for Diffs" compares against repo
 *   5. User sets target dir + commit message
 *   6. All selected files committed in a SINGLE push via batch API
 *   7. Progress bar tracks completion
 *   8. File tree refreshes on completion
 */

import { State, EventBus } from './core.js';
import { Git, resolveContext } from './git.js';
import { GitProviderRegistry } from './git-providers/registry.js';
import { loadFilesIntoLocal } from './git-providers/local.js';
import { isTextFile } from './editor.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

// ============================================
// STATE
// ============================================

let extractedFiles = [];   // [{ path, content, isBinary, size, selected, diffStatus }]
let isUploading = false;
let currentZipName = '';

// Extensions that are text but not auto-selected by default
const DEFAULT_OFF_EXTENSIONS = new Set(['svg', 'xml', 'csv', 'tsv']);

// Binary extensions that are valid web assets — auto-select these
const WEB_ASSET_EXTENSIONS = new Set([
    // Images (favicon, logos, photos)
    'png', 'jpg', 'jpeg', 'gif', 'ico', 'webp', 'avif',
    // Fonts
    'woff', 'woff2', 'ttf', 'eot', 'otf',
]);

// ============================================
// MODAL LIFECYCLE
// ============================================

export function openZipUpload() {
    const modal = document.getElementById('zipUploadModal');
    if (!modal) return;
    
    // Reset state
    extractedFiles = [];
    isUploading = false;
    currentZipName = '';
    
    // Reset drop zone first (recreates #zipFileInput if it was destroyed)
    _resetDropZone();
    
    // Reset UI
    document.getElementById('zipFilePreview').style.display = 'none';
    document.getElementById('zipProgress').style.display = 'none';
    
    const targetDir = document.getElementById('zipTargetDir');
    const commitMsg = document.getElementById('zipCommitMessage');
    const btn = document.getElementById('btnZipUpload');
    if (targetDir) targetDir.value = '';
    if (commitMsg) commitMsg.value = '';
    if (btn) btn.disabled = true;

    // Show/hide git-specific controls based on whether a project is loaded
    const isLocalMode = !State.currentProject;
    const gitControls = modal.querySelectorAll('.zip-git-only');
    gitControls.forEach(el => el.style.display = isLocalMode ? 'none' : '');
    
    // Update upload button text
    if (btn) {
        btn.textContent = isLocalMode ? '📂 Load into Editor' : '📦 Upload';
    }
    
    modal.classList.add('active');
}

export function closeZipUpload() {
    if (isUploading) {
        if (!confirm('Upload in progress. Cancel?')) return;
    }
    
    const modal = document.getElementById('zipUploadModal');
    if (modal) modal.classList.remove('active');
    
    extractedFiles = [];
    isUploading = false;
    currentZipName = '';
}

// ============================================
// FILE SELECTION + EXTRACTION
// ============================================

export async function handleZipFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.zip')) {
        window.showToast('Please select a .zip file', 'warning');
        return;
    }
    
    if (typeof JSZip === 'undefined') {
        window.showToast('JSZip library not loaded', 'error');
        return;
    }
    
    // Show loading state
    const dropZone = document.getElementById('zipDropZone');
    dropZone.innerHTML = '<div class="zip-loading">📦 Extracting...</div>';
    
    try {
        const zip = await JSZip.loadAsync(file);
        extractedFiles = [];
        currentZipName = file.name;
        
        const promises = [];
        
        zip.forEach((relativePath, zipEntry) => {
            // Skip directories and OS metadata
            if (zipEntry.dir) return;
            if (relativePath.startsWith('__MACOSX/')) return;
            if (relativePath.endsWith('.DS_Store')) return;
            
            const fileName = relativePath.split('/').pop();
            const ext = fileName.split('.').pop().toLowerCase();
            const binary = !isTextFile(fileName);
            
            // Web assets (images, fonts) auto-select even though they're binary
            const isWebAsset = binary && WEB_ASSET_EXTENSIONS.has(ext);
            const autoSelect = (!binary || isWebAsset) && !DEFAULT_OFF_EXTENSIONS.has(ext);
            
            const promise = (async () => {
                try {
                    let content;
                    let size = zipEntry._data ? zipEntry._data.uncompressedSize : 0;
                    
                    if (binary) {
                        content = await zipEntry.async('base64');
                    } else {
                        content = await zipEntry.async('string');
                        size = content.length;
                    }
                    
                    extractedFiles.push({
                        path: relativePath,
                        content,
                        isBinary: binary,
                        size,
                        selected: autoSelect,
                        diffStatus: null  // null = not scanned, 'new'|'modified'|'unchanged'
                    });
                } catch (e) {
                    console.warn(`Failed to extract ${relativePath}:`, e);
                }
            })();
            
            promises.push(promise);
        });
        
        await Promise.all(promises);
        
        // Sort by path
        extractedFiles.sort((a, b) => a.path.localeCompare(b.path));
        
        // Strip common prefix (e.g., zip contains single root folder)
        _stripCommonPrefix();
        
        // Render preview
        _renderFilePreview(file.name);
        
    } catch (error) {
        console.error('Zip extraction failed:', error);
        window.showToast(`Failed to extract zip: ${error.message}`, 'error');
        _resetDropZone();
    }
}

/**
 * Strip a common single-directory prefix from all paths.
 * E.g., if every file starts with "project-v1.2/" strip that prefix.
 */
function _stripCommonPrefix() {
    if (extractedFiles.length === 0) return;
    
    const parts = extractedFiles[0].path.split('/');
    if (parts.length < 2) return;
    
    const prefix = parts[0] + '/';
    const allSharePrefix = extractedFiles.every(f => f.path.startsWith(prefix));
    
    if (allSharePrefix) {
        extractedFiles.forEach(f => {
            f.path = f.path.substring(prefix.length);
        });
        extractedFiles = extractedFiles.filter(f => f.path.length > 0);
    }
}

function _resetDropZone() {
    const dropZone = document.getElementById('zipDropZone');
    if (!dropZone) return;
    dropZone.innerHTML = `
        <div class="zip-drop-icon">📦</div>
        <div class="zip-drop-text">Drop a .zip file here</div>
        <div class="zip-drop-hint">or click to browse</div>
        <input type="file" id="zipFileInput" accept=".zip" 
               onchange="window.handleZipFileSelect(event)" hidden>
    `;
    dropZone.style.display = '';
}

// ============================================
// FILE PREVIEW RENDERING
// ============================================

function _renderFilePreview(zipName) {
    const dropZone = document.getElementById('zipDropZone');
    const preview = document.getElementById('zipFilePreview');
    const stats = document.getElementById('zipFileStats');
    
    dropZone.style.display = 'none';
    preview.style.display = '';
    
    const textFiles = extractedFiles.filter(f => !f.isBinary);
    const webAssets = extractedFiles.filter(f => f.isBinary && WEB_ASSET_EXTENSIONS.has(f.path.split('.').pop()?.toLowerCase()));
    const otherBinary = extractedFiles.filter(f => f.isBinary && !WEB_ASSET_EXTENSIONS.has(f.path.split('.').pop()?.toLowerCase()));
    const totalSize = extractedFiles.reduce((sum, f) => sum + f.size, 0);
    
    let statsHtml = `📦 <strong>${escapeHtml(zipName)}</strong> — `;
    statsHtml += `${textFiles.length} text`;
    if (webAssets.length > 0) {
        statsHtml += `, ${webAssets.length} asset${webAssets.length !== 1 ? 's' : ''}`;
    }
    if (otherBinary.length > 0) {
        statsHtml += `, ${otherBinary.length} binary`;
    }
    statsHtml += ` · ${_formatSize(totalSize)}`;
    stats.innerHTML = statsHtml;
    
    _renderFileList();
    
    // Auto-generate commit message
    const commitMsg = document.getElementById('zipCommitMessage');
    if (commitMsg && !commitMsg.value) {
        const selectedCount = extractedFiles.filter(f => f.selected).length;
        commitMsg.value = `Upload ${selectedCount} files from ${zipName}`;
    }
    
    _updateUploadButton();
}

function _renderFileList() {
    const fileList = document.getElementById('zipFileList');
    if (!fileList) return;
    
    fileList.innerHTML = extractedFiles.map((f, i) => {
        const ext = f.path.split('.').pop()?.toLowerCase();
        const isWebAsset = f.isBinary && WEB_ASSET_EXTENSIONS.has(ext);
        const icon = isWebAsset ? '🖼️' : f.isBinary ? '📎' : _getIcon(f.path);
        const sizeStr = _formatSize(f.size);
        const checkedAttr = f.selected ? 'checked' : '';
        const binaryClass = f.isBinary ? ' zip-file-binary' : '';
        
        // Diff status badge
        let diffBadge = '';
        if (isWebAsset) {
            diffBadge = '<span class="zip-file-badge">asset</span>';
        } else if (f.isBinary) {
            diffBadge = '<span class="zip-file-badge">binary</span>';
        } else if (f.diffStatus === 'new') {
            diffBadge = '<span class="zip-file-badge zip-badge-new">new</span>';
        } else if (f.diffStatus === 'modified') {
            diffBadge = '<span class="zip-file-badge zip-badge-modified">modified</span>';
        } else if (f.diffStatus === 'unchanged') {
            diffBadge = '<span class="zip-file-badge zip-badge-unchanged">unchanged</span>';
        }
        
        return `
            <label class="zip-file-item${binaryClass}">
                <input type="checkbox" ${checkedAttr}
                       onchange="window.zipToggleFile(${i}, this.checked)">
                <span class="zip-file-icon">${icon}</span>
                <span class="zip-file-path">${escapeHtml(f.path)}</span>
                <span class="zip-file-size">${sizeStr}</span>
                ${diffBadge}
            </label>
        `;
    }).join('');
}

export function zipToggleFile(index, checked) {
    if (index >= 0 && index < extractedFiles.length) {
        extractedFiles[index].selected = checked;
        _updateUploadButton();
    }
}

export function zipSelectAll(checked) {
    extractedFiles.forEach(f => {
        f.selected = checked;
    });
    const checkboxes = document.querySelectorAll('#zipFileList input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = checked; });
    _updateUploadButton();
}

function _updateUploadButton() {
    const selected = extractedFiles.filter(f => f.selected).length;
    const btn = document.getElementById('btnZipUpload');
    if (!btn) return;
    btn.disabled = selected === 0 || isUploading;
    btn.textContent = selected > 0 
        ? `📤 Upload ${selected} file${selected !== 1 ? 's' : ''}`
        : '📤 Upload';
}

// ============================================
// SCAN FOR DIFFS
// ============================================

/**
 * Compare extracted files against the repo.
 * Marks each file as 'new', 'modified', or 'unchanged'.
 * Selects only new + modified files.
 */
export async function scanForDiffs() {
    if (extractedFiles.length === 0) return;
    
    const btn = document.getElementById('btnZipScanDiffs');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Scanning...';
    }
    
    const targetDir = (document.getElementById('zipTargetDir')?.value || '').trim().replace(/^\/+|\/+$/g, '');
    const { owner, repo } = State.currentProject;
    const branch = State.currentBranch || 'main';
    
    let scanned = 0;
    
    for (const file of extractedFiles) {
        const fullPath = targetDir ? `${targetDir}/${file.path}` : file.path;
        
        try {
            const remote = await Git.getFile(owner, repo, fullPath, branch);
            
            if (file.isBinary) {
                // Binary files — compare base64 if available, otherwise mark modified
                if (remote.content === file.content) {
                    file.diffStatus = 'unchanged';
                    file.selected = false;
                } else {
                    file.diffStatus = 'modified';
                    file.selected = true;
                }
            } else if (remote.content === file.content) {
                file.diffStatus = 'unchanged';
                file.selected = false;
            } else {
                file.diffStatus = 'modified';
                file.selected = true;
            }
        } catch (e) {
            if (e.status === 404) {
                file.diffStatus = 'new';
                file.selected = true;
            } else {
                console.warn(`Diff scan failed for ${fullPath}:`, e.message);
            }
        }
        
        scanned++;
        if (btn) btn.textContent = `⏳ ${scanned}/${extractedFiles.length}`;
    }
    
    // Re-render
    _renderFileList();
    _updateUploadButton();
    
    const newCount = extractedFiles.filter(f => f.diffStatus === 'new').length;
    const modCount = extractedFiles.filter(f => f.diffStatus === 'modified').length;
    const sameCount = extractedFiles.filter(f => f.diffStatus === 'unchanged').length;
    
    if (btn) {
        btn.disabled = false;
        btn.textContent = '🔍 Scan for Diffs';
    }
    
    // Update commit message to reflect diff results
    const commitMsg = document.getElementById('zipCommitMessage');
    if (commitMsg && currentZipName) {
        const parts = [];
        if (newCount > 0) parts.push(`${newCount} new`);
        if (modCount > 0) parts.push(`${modCount} modified`);
        commitMsg.value = parts.length > 0
            ? `Upload ${parts.join(', ')} files from ${currentZipName}`
            : `No changes from ${currentZipName}`;
    }
    
    window.showToast(`${newCount} new, ${modCount} modified, ${sameCount} unchanged`, 'info');
}

// ============================================
// UPLOAD (COMMIT TO REPO)
// ============================================

export async function uploadExtractedFiles() {
    const selected = extractedFiles.filter(f => f.selected);
    if (selected.length === 0) return;

    // ========================================
    // LOCAL MODE — no active project
    // ========================================
    if (!State.currentProject) {
        await _loadLocal(selected);
        return;
    }

    // ========================================
    // GIT MODE — commit to active repo
    // ========================================
    const targetDir = (document.getElementById('zipTargetDir').value || '').trim().replace(/^\/+|\/+$/g, '');
    const commitMsg = (document.getElementById('zipCommitMessage').value || '').trim()
        || `Upload ${selected.length} files`;
    
    isUploading = true;
    const btn = document.getElementById('btnZipUpload');
    if (btn) {
        btn.disabled = true;
        btn.textContent = `⏳ Committing ${selected.length} files...`;
    }
    
    const progressBar = document.getElementById('zipProgress');
    const progressFill = document.getElementById('zipProgressFill');
    const progressText = document.getElementById('zipProgressText');
    if (progressBar) progressBar.style.display = '';
    if (progressFill) progressFill.style.width = '50%';
    if (progressText) progressText.textContent = `Preparing ${selected.length} files...`;
    
    // Build a lookup of existing files for create vs update detection
    const existingFiles = new Map();
    (State.fileTree || []).forEach(f => {
        existingFiles.set(f.path, f.sha);
    });
    
    const { provider, connection, owner, repo, branch } = resolveContext();
    
    // Build batch payload — single commit for ALL files
    const batchFiles = selected.map(file => {
        const fullPath = targetDir ? `${targetDir}/${file.path}` : file.path;
        const existingSha = existingFiles.get(fullPath);
        
        return {
            path: fullPath,
            content: file.content,
            sha: existingSha || undefined,
            operation: existingSha ? 'update' : 'create',
            // Binary files are already base64 from JSZip; text files need encoding
            encoding: file.isBinary ? 'base64' : 'text'
        };
    });
    
    if (progressText) progressText.textContent = `Committing ${batchFiles.length} files in one push...`;
    
    try {
        const { results, errors } = await provider.batchCommitFiles(
            connection, owner, repo, batchFiles, commitMsg, branch
        );
        
        // Final progress
        if (progressFill) progressFill.style.width = '100%';
        if (progressText) progressText.textContent = `Done: ${results.length} files committed`;
        
        isUploading = false;
        if (btn) btn.textContent = '✅ Done';
        
        if (errors.length > 0) {
            console.warn('Batch commit errors:', errors);
            window.showToast(`Committed ${results.length}, failed ${errors.length}`, 'warning');
        } else {
            window.showToast(`Committed ${results.length} file${results.length !== 1 ? 's' : ''} in 1 push`, 'success');
        }
    } catch (error) {
        console.error('Batch commit failed:', error);
        if (progressFill) progressFill.style.width = '0%';
        if (progressText) progressText.textContent = `Failed: ${error.message}`;
        
        isUploading = false;
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📦 Upload';
        }
        
        window.showToast(`Upload failed: ${error.message}`, 'error');
        return;
    }
    
    EventBus.emit('tree:refresh');
    
    setTimeout(() => {
        closeZipUpload();
    }, 1200);
}

// ============================================
// DRAG & DROP HANDLERS
// ============================================

export function initZipDragDrop() {
    const dropZone = document.getElementById('zipDropZone');
    if (!dropZone) return;
    
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
    });
    
    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
    });
    
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
        
        const file = e.dataTransfer?.files?.[0];
        if (file) handleZipFile(file);
    });
    
    dropZone.addEventListener('click', () => {
        document.getElementById('zipFileInput')?.click();
    });
}

export function handleZipFileSelect(event) {
    const file = event.target?.files?.[0];
    if (file) handleZipFile(file);
}

// ============================================
// LOCAL MODE (in-memory filesystem)
// ============================================

/**
 * Load selected zip files into the local provider and activate as a project.
 * No network calls — everything stays in-memory.
 */
async function _loadLocal(selected) {
    const btn = document.getElementById('btnZipUpload');
    const progressBar = document.getElementById('zipProgress');
    const progressFill = document.getElementById('zipProgressFill');
    const progressText = document.getElementById('zipProgressText');

    if (btn) btn.disabled = true;
    if (progressBar) progressBar.style.display = '';
    if (progressFill) progressFill.style.width = '50%';
    if (progressText) progressText.textContent = 'Loading files...';

    try {
        // Ensure a "local" connection exists in the registry
        const LOCAL_CONN_ID = '__local__';
        const existingConns = GitProviderRegistry.listConnections();
        if (!existingConns.find(c => c.id === LOCAL_CONN_ID)) {
            GitProviderRegistry.addConnection({
                id: LOCAL_CONN_ID,
                provider: 'local',
                label: 'Local',
                url: 'local://',
                token: '',
                enabled: true
            });
        }

        // Generate a project name from the zip filename
        const repoName = currentZipName
            .replace(/\.zip$/i, '')
            .replace(/[^a-zA-Z0-9._-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
            || 'untitled';
        const owner = 'local';

        // Load files into the in-memory store
        loadFilesIntoLocal(owner, repoName, selected);

        if (progressFill) progressFill.style.width = '80%';
        if (progressText) progressText.textContent = 'Activating project...';

        // Switch to the local project using the standard flow
        const { switchProject } = await import('./project-manager.js');
        await switchProject(LOCAL_CONN_ID, owner, repoName);

        // Also add to projects list for the selector
        const { refreshProjects } = await import('./project-manager.js');
        await refreshProjects();

        if (progressFill) progressFill.style.width = '100%';
        if (progressText) progressText.textContent = `Loaded ${selected.length} files`;
        if (btn) btn.textContent = '✅ Done';

        window.showToast(`Loaded ${selected.length} files from ${currentZipName}`, 'success');

        setTimeout(() => closeZipUpload(), 800);

    } catch (error) {
        console.error('Local load failed:', error);
        if (progressFill) progressFill.style.width = '0%';
        if (progressText) progressText.textContent = `Failed: ${error.message}`;
        if (btn) { btn.disabled = false; btn.textContent = '📂 Load into Editor'; }
        window.showToast(`Load failed: ${error.message}`, 'error');
    }
}

// ============================================
// HELPERS
// ============================================

function _formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function _getIcon(path) {
    const ext = path.split('.').pop().toLowerCase();
    const icons = {
        js: '📜', jsx: '⚛️', ts: '📘', tsx: '⚛️',
        html: '🌐', css: '🎨', scss: '🎨',
        json: '📋', yaml: '📋', yml: '📋', toml: '📋',
        md: '📝', txt: '📄', py: '🐍', go: '🔵',
        rs: '🦀', c: '⚙️', cpp: '⚙️', h: '⚙️',
        sh: '🐚', bash: '🐚', dockerfile: '🐳',
        svg: '🖼️', xml: '📋'
    };
    return icons[ext] || '📄';
}
