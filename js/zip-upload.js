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
 *   4. User sets target dir + commit message
 *   5. Files created/updated one at a time via Git facade
 *   6. Progress bar tracks completion
 *   7. File tree refreshes on completion
 */

import { State, EventBus } from './core.js';
import { Git, resolveContext } from './git.js';
import { isTextFile } from './editor.js';
import { escapeHtml, escapeAttr } from './utils/html.js';

// ============================================
// STATE
// ============================================

let extractedFiles = [];   // [{ path, content, isBinary, size }]
let isUploading = false;

// ============================================
// MODAL LIFECYCLE
// ============================================

export function openZipUpload() {
    if (!State.currentProject) {
        window.showToast('Load a project first', 'warning');
        return;
    }
    
    const modal = document.getElementById('zipUploadModal');
    if (!modal) return;
    
    // Reset state
    extractedFiles = [];
    isUploading = false;
    
    // Reset UI
    document.getElementById('zipDropZone').style.display = '';
    document.getElementById('zipFilePreview').style.display = 'none';
    document.getElementById('zipProgress').style.display = 'none';
    document.getElementById('zipFileInput').value = '';
    document.getElementById('zipTargetDir').value = '';
    document.getElementById('zipCommitMessage').value = '';
    document.getElementById('btnZipUpload').disabled = true;
    
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
    const preview = document.getElementById('zipFilePreview');
    dropZone.innerHTML = '<div class="zip-loading">📦 Extracting...</div>';
    
    try {
        const zip = await JSZip.loadAsync(file);
        extractedFiles = [];
        
        const promises = [];
        
        zip.forEach((relativePath, zipEntry) => {
            // Skip directories and OS metadata
            if (zipEntry.dir) return;
            if (relativePath.startsWith('__MACOSX/')) return;
            if (relativePath.endsWith('.DS_Store')) return;
            
            const binary = !isTextFile(relativePath.split('/').pop());
            
            const promise = (async () => {
                try {
                    let content;
                    let size = zipEntry._data ? zipEntry._data.uncompressedSize : 0;
                    
                    if (binary) {
                        // Read as base64 for binary files
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
                        selected: !binary  // Auto-select text files, skip binaries
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
        // Reset drop zone
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
    if (parts.length < 2) return;  // No directory prefix
    
    const prefix = parts[0] + '/';
    const allSharePrefix = extractedFiles.every(f => f.path.startsWith(prefix));
    
    if (allSharePrefix) {
        extractedFiles.forEach(f => {
            f.path = f.path.substring(prefix.length);
        });
        // Remove entries that are now empty (was just the directory)
        extractedFiles = extractedFiles.filter(f => f.path.length > 0);
    }
}

function _resetDropZone() {
    const dropZone = document.getElementById('zipDropZone');
    dropZone.innerHTML = `
        <div class="zip-drop-icon">📦</div>
        <div class="zip-drop-text">Drop a .zip file here</div>
        <div class="zip-drop-hint">or click to browse</div>
        <input type="file" id="zipFileInput" accept=".zip" 
               onchange="window.handleZipFileSelect(event)" hidden>
    `;
    dropZone.style.display = '';
    document.getElementById('zipFilePreview').style.display = 'none';
}

// ============================================
// FILE PREVIEW RENDERING
// ============================================

function _renderFilePreview(zipName) {
    const dropZone = document.getElementById('zipDropZone');
    const preview = document.getElementById('zipFilePreview');
    const fileList = document.getElementById('zipFileList');
    const stats = document.getElementById('zipFileStats');
    
    dropZone.style.display = 'none';
    preview.style.display = '';
    
    const textFiles = extractedFiles.filter(f => !f.isBinary);
    const binaryFiles = extractedFiles.filter(f => f.isBinary);
    const totalSize = extractedFiles.reduce((sum, f) => sum + f.size, 0);
    
    let statsHtml = `📦 <strong>${escapeHtml(zipName)}</strong> — `;
    statsHtml += `${textFiles.length} text file${textFiles.length !== 1 ? 's' : ''}`;
    if (binaryFiles.length > 0) {
        statsHtml += `, ${binaryFiles.length} binary (skipped)`;
    }
    statsHtml += ` · ${_formatSize(totalSize)}`;
    stats.innerHTML = statsHtml;
    
    fileList.innerHTML = extractedFiles.map((f, i) => {
        const icon = f.isBinary ? '📎' : _getIcon(f.path);
        const sizeStr = _formatSize(f.size);
        const disabledAttr = f.isBinary ? 'disabled' : '';
        const checkedAttr = f.selected ? 'checked' : '';
        const binaryClass = f.isBinary ? ' zip-file-binary' : '';
        
        return `
            <label class="zip-file-item${binaryClass}">
                <input type="checkbox" ${checkedAttr} ${disabledAttr}
                       onchange="window.zipToggleFile(${i}, this.checked)">
                <span class="zip-file-icon">${icon}</span>
                <span class="zip-file-path">${escapeHtml(f.path)}</span>
                <span class="zip-file-size">${sizeStr}</span>
                ${f.isBinary ? '<span class="zip-file-badge">binary</span>' : ''}
            </label>
        `;
    }).join('');
    
    // Auto-generate commit message
    if (!document.getElementById('zipCommitMessage').value) {
        document.getElementById('zipCommitMessage').value = 
            `Upload ${textFiles.length} files from ${zipName}`;
    }
    
    _updateUploadButton();
}

export function zipToggleFile(index, checked) {
    if (index >= 0 && index < extractedFiles.length) {
        extractedFiles[index].selected = checked;
        _updateUploadButton();
    }
}

export function zipSelectAll(checked) {
    extractedFiles.forEach(f => {
        if (!f.isBinary) f.selected = checked;
    });
    // Update checkboxes in DOM
    const checkboxes = document.querySelectorAll('#zipFileList input[type="checkbox"]:not([disabled])');
    checkboxes.forEach(cb => { cb.checked = checked; });
    _updateUploadButton();
}

function _updateUploadButton() {
    const selected = extractedFiles.filter(f => f.selected).length;
    const btn = document.getElementById('btnZipUpload');
    btn.disabled = selected === 0 || isUploading;
    btn.textContent = selected > 0 
        ? `📤 Upload ${selected} file${selected !== 1 ? 's' : ''}`
        : '📤 Upload';
}

// ============================================
// UPLOAD (COMMIT TO REPO)
// ============================================

export async function uploadExtractedFiles() {
    const selected = extractedFiles.filter(f => f.selected);
    if (selected.length === 0) return;
    
    const targetDir = (document.getElementById('zipTargetDir').value || '').trim().replace(/^\/+|\/+$/g, '');
    const commitMsg = (document.getElementById('zipCommitMessage').value || '').trim()
        || `Upload ${selected.length} files`;
    
    isUploading = true;
    const btn = document.getElementById('btnZipUpload');
    btn.disabled = true;
    btn.textContent = '⏳ Uploading...';
    
    const progressBar = document.getElementById('zipProgress');
    const progressFill = document.getElementById('zipProgressFill');
    const progressText = document.getElementById('zipProgressText');
    progressBar.style.display = '';
    
    // Build a lookup of existing files for create vs update detection
    const existingFiles = new Map();
    (State.fileTree || []).forEach(f => {
        existingFiles.set(f.path, f.sha);
    });
    
    const { provider, connection, owner, repo, branch } = resolveContext();
    
    let succeeded = 0;
    let failed = 0;
    const errors = [];
    
    for (let i = 0; i < selected.length; i++) {
        const file = selected[i];
        const fullPath = targetDir ? `${targetDir}/${file.path}` : file.path;
        
        // Update progress
        const pct = Math.round(((i) / selected.length) * 100);
        progressFill.style.width = pct + '%';
        progressText.textContent = `${i + 1}/${selected.length}: ${file.path}`;
        
        try {
            const existingSha = existingFiles.get(fullPath);
            
            if (existingSha) {
                // Update existing file
                await provider.updateFile(
                    connection, owner, repo,
                    fullPath, file.content,
                    commitMsg, existingSha, branch
                );
            } else {
                // Create new file
                await provider.createFile(
                    connection, owner, repo,
                    fullPath, file.content,
                    commitMsg, branch
                );
            }
            
            succeeded++;
        } catch (error) {
            failed++;
            errors.push({ path: fullPath, error: error.message });
            console.error(`Upload failed for ${fullPath}:`, error);
        }
    }
    
    // Final progress
    progressFill.style.width = '100%';
    progressText.textContent = `Done: ${succeeded} uploaded${failed > 0 ? `, ${failed} failed` : ''}`;
    
    isUploading = false;
    btn.textContent = '✅ Done';
    
    // Show results
    if (failed > 0) {
        const failedPaths = errors.map(e => `  ${e.path}: ${e.error}`).join('\n');
        console.warn('Upload errors:\n' + failedPaths);
        window.showToast(`Uploaded ${succeeded}, failed ${failed}`, 'warning');
    } else {
        window.showToast(`Uploaded ${succeeded} file${succeeded !== 1 ? 's' : ''}`, 'success');
    }
    
    // Refresh file tree
    EventBus.emit('tree:refresh');
    
    // Close modal after brief delay
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

// Called from inline onchange on the hidden file input
export function handleZipFileSelect(event) {
    const file = event.target?.files?.[0];
    if (file) handleZipFile(file);
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
