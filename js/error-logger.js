// ============================================
// ERROR LOGGER - Captures all errors
// ============================================

import { escapeHtml } from './utils/html.js';
import { EditorError } from './utils/errors.js';

export const ErrorLogger = {
    logs: [],
    maxLogs: 500,

    init() {
        // Capture unhandled errors
        window.addEventListener('error', (e) => {
            this.logError('ERROR', e.message, e.error?.stack || '', e.filename, e.lineno, e.colno, e.error);
        });

        // Capture unhandled promise rejections
        window.addEventListener('unhandledrejection', (e) => {
            this.logError('UNHANDLED REJECTION', e.reason?.message || e.reason, e.reason?.stack || '', '', 0, 0, e.reason);
        });

        // Intercept console methods
        this.interceptConsole();
    },

    interceptConsole() {
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;

        console.log = (...args) => {
            this.logConsole('LOG', args);
            originalLog.apply(console, args);
        };

        console.warn = (...args) => {
            this.logConsole('WARN', args);
            originalWarn.apply(console, args);
        };

        console.error = (...args) => {
            this.logConsole('ERROR', args);
            originalError.apply(console, args);
        };
    },

    logError(type, message, stack, file, line, col, originalError = null) {
        const entry = {
            timestamp: new Date().toISOString(),
            type,
            message: String(message),
            stack: String(stack || ''),
            file: String(file || ''),
            line: line || 0,
            col: col || 0,
            // EditorError structured fields
            code: null,
            recoveryHint: null,
            status: null,
        };

        // Extract structured info from EditorError
        if (originalError instanceof EditorError) {
            entry.code = originalError.code;
            entry.recoveryHint = originalError.recoveryHint;
            entry.status = originalError.status;
        } else if (originalError?.code) {
            // Legacy errors with .code property
            entry.code = originalError.code;
        }

        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        this.updateBadge();
    },

    serializeValue(arg) {
        // Handle EditorError with structured fields
        if (arg instanceof EditorError) {
            const obj = {
                name: arg.name,
                code: arg.code,
                message: arg.message,
                ...(arg.recoveryHint && { recoveryHint: arg.recoveryHint }),
                ...(arg.status && { status: arg.status }),
                ...(arg.context && { context: arg.context }),
                stack: arg.stack,
            };
            return JSON.stringify(obj, null, 2);
        }

        // Handle other Error objects
        if (arg instanceof Error) {
            return JSON.stringify({
                name: arg.name,
                message: arg.message,
                stack: arg.stack,
                ...arg  // Include any custom properties
            }, null, 2);
        }
        
        // Handle regular objects
        if (typeof arg === 'object' && arg !== null) {
            try {
                return JSON.stringify(arg, null, 2);
            } catch (e) {
                return String(arg);
            }
        }
        
        return String(arg);
    },

    logConsole(type, args) {
        const message = args.map(arg => this.serializeValue(arg)).join(' ');

        const entry = {
            timestamp: new Date().toISOString(),
            type,
            message,
            stack: '',
            file: '',
            line: 0,
            col: 0
        };

        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        this.updateBadge();
    },

    updateBadge() {
        // 1.3.6: badge moved from the deleted #btnErrorLog onto the Debug
        // dropdown trigger (#btnDebugMenu) — the dropdown is the new home
        // for both Error log and LLM debug log.
        const btn = document.getElementById('btnDebugMenu');
        if (btn) {
            const errorCount = this.logs.filter(l => l.type === 'ERROR' || l.type === 'UNHANDLED REJECTION').length;
            if (errorCount > 0) {
                btn.style.backgroundColor = 'var(--danger)';
                btn.style.color = 'white';
            } else {
                btn.style.backgroundColor = '';
                btn.style.color = '';
            }
        }
    },

    clear() {
        this.logs = [];
        this.updateBadge();
    },

    render() {
        const container = document.getElementById('errorLogContent');
        const countEl = document.getElementById('errorLogCount');

        if (!container) return;

        if (countEl) {
            countEl.textContent = this.logs.length;
        }

        if (this.logs.length === 0) {
            container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 2rem;">No errors logged yet</div>';
            return;
        }

        const typeColors = {
            'ERROR': 'var(--danger)',
            'UNHANDLED REJECTION': 'var(--danger)',
            'WARN': 'var(--warning)',
            'LOG': 'var(--text-muted)'
        };

        container.innerHTML = this.logs.map((entry, i) => {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            const color = typeColors[entry.type] || 'var(--text-muted)';
            const codeBadge = entry.code
                ? `<span style="background: rgba(255,255,255,0.1); padding: 1px 6px; border-radius: 3px; font-size: 11px; font-family: monospace; color: ${color};">${escapeHtml(entry.code)}</span>`
                : '';
            const hintBlock = entry.recoveryHint
                ? `<div class="error-recovery-hint">💡 ${escapeHtml(entry.recoveryHint)}</div>`
                : '';
            const statusBadge = entry.status
                ? `<span style="color: var(--text-muted); font-size: 11px;">HTTP ${entry.status}</span>`
                : '';
            
            return `
                <div style="margin-bottom: 1rem; padding: 0.75rem; background: rgba(0,0,0,0.1); border-left: 3px solid ${color}; border-radius: 3px;">
                    <div style="display: flex; gap: 0.75rem; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap;">
                        <span style="color: ${color}; font-weight: bold;">[${entry.type}]</span>
                        ${codeBadge}
                        ${statusBadge}
                        <span style="color: var(--text-muted);">${time}</span>
                        ${entry.file ? `<span style="color: var(--text-muted);">${escapeHtml(entry.file)}:${escapeHtml(entry.line)}:${escapeHtml(entry.col)}</span>` : ''}
                    </div>
                    <div style="color: var(--text-primary); margin-bottom: 0.5rem; white-space: pre-wrap;">${escapeHtml(entry.message)}</div>
                    ${hintBlock}
                    ${entry.stack ? `<details style="margin-top: 0.5rem;"><summary style="cursor: pointer; color: var(--text-muted);">Stack Trace</summary><pre style="margin-top: 0.5rem; padding: 0.5rem; background: rgba(0,0,0,0.2); overflow-x: auto; font-size: 11px;">${escapeHtml(entry.stack)}</pre></details>` : ''}
                </div>
            `;
        }).reverse().join('');
    },

    export() {
        return JSON.stringify(this.logs, null, 2);
    },

    exportText() {
        return this.logs.map(entry => {
            let text = `[${entry.timestamp}] [${entry.type}]`;
            if (entry.code) text += ` [${entry.code}]`;
            if (entry.status) text += ` (HTTP ${entry.status})`;
            text += ` ${entry.message}`;
            if (entry.recoveryHint) text += `\n  💡 ${entry.recoveryHint}`;
            if (entry.file) text += `\n  at ${entry.file}:${entry.line}:${entry.col}`;
            if (entry.stack) text += `\n${entry.stack}`;
            return text;
        }).join('\n\n');
    }
};

// Window functions for modal controls
export function openErrorLog() {
    const errorLogModal = document.getElementById('errorLogModal');
    if (!errorLogModal) {
        console.error('[ErrorLogger] Error log modal element not found - cannot open error log');
        window.showToast?.('Error log modal not found — page may not have loaded correctly', 'error');
        return;
    }
    
    ErrorLogger.render();
    errorLogModal.classList.add('active');
}

export function closeErrorLog() {
    const errorLogModal = document.getElementById('errorLogModal');
    if (!errorLogModal) {
        console.error('[ErrorLogger] Error log modal element not found - cannot close error log');
        return;
    }
    
    errorLogModal.classList.remove('active');
}

export async function clearErrorLog() {
    const { showConfirm } = await import('./ui/dialogs.js');
    if (await showConfirm('Clear all error logs?', { title: 'Clear Logs', okLabel: 'Clear', variant: 'danger' })) {
        ErrorLogger.clear();
        ErrorLogger.render();
    }
}

export function copyErrorLog() {
    const text = ErrorLogger.exportText();
    navigator.clipboard.writeText(text).then(() => {
        window.showToast?.('Error log copied to clipboard', 'success');
    }).catch(err => {
        console.error('Failed to copy:', err);
        window.showToast?.('Failed to copy error log', 'error');
    });
}

export function exportErrorLog() {
    const text = ErrorLogger.exportText();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `error-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
}
