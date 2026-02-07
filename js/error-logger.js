// ============================================
// ERROR LOGGER - Captures all errors
// ============================================

export const ErrorLogger = {
    logs: [],
    maxLogs: 500,

    init() {
        // Capture unhandled errors
        window.addEventListener('error', (e) => {
            this.logError('ERROR', e.message, e.error?.stack || '', e.filename, e.lineno, e.colno);
        });

        // Capture unhandled promise rejections
        window.addEventListener('unhandledrejection', (e) => {
            this.logError('UNHANDLED REJECTION', e.reason?.message || e.reason, e.reason?.stack || '', '', 0, 0);
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

    logError(type, message, stack, file, line, col) {
        const entry = {
            timestamp: new Date().toISOString(),
            type,
            message: String(message),
            stack: String(stack || ''),
            file: String(file || ''),
            line: line || 0,
            col: col || 0
        };

        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        this.updateBadge();
    },

    serializeValue(arg) {
        // Handle Error objects specially
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
        const btn = document.getElementById('btnErrorLog');
        if (btn) {
            const errorCount = this.logs.filter(l => l.type === 'ERROR' || l.type === 'UNHANDLED REJECTION').length;
            if (errorCount > 0) {
                btn.style.backgroundColor = '#dc3545';
                btn.style.color = 'white';
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

        countEl.textContent = this.logs.length;

        if (this.logs.length === 0) {
            container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 2rem;">No errors logged yet</div>';
            return;
        }

        const typeColors = {
            'ERROR': '#dc3545',
            'UNHANDLED REJECTION': '#dc3545',
            'WARN': '#ffc107',
            'LOG': '#6c757d'
        };

        container.innerHTML = this.logs.map((entry, i) => {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            const color = typeColors[entry.type] || '#6c757d';
            
            return `
                <div style="margin-bottom: 1rem; padding: 0.75rem; background: rgba(0,0,0,0.1); border-left: 3px solid ${color}; border-radius: 3px;">
                    <div style="display: flex; gap: 1rem; margin-bottom: 0.5rem;">
                        <span style="color: ${color}; font-weight: bold;">[${entry.type}]</span>
                        <span style="color: var(--text-muted);">${time}</span>
                        ${entry.file ? `<span style="color: var(--text-muted);">${entry.file}:${entry.line}:${entry.col}</span>` : ''}
                    </div>
                    <div style="color: var(--text-primary); margin-bottom: 0.5rem; white-space: pre-wrap;">${this.escapeHtml(entry.message)}</div>
                    ${entry.stack ? `<details style="margin-top: 0.5rem;"><summary style="cursor: pointer; color: var(--text-muted);">Stack Trace</summary><pre style="margin-top: 0.5rem; padding: 0.5rem; background: rgba(0,0,0,0.2); overflow-x: auto; font-size: 11px;">${this.escapeHtml(entry.stack)}</pre></details>` : ''}
                </div>
            `;
        }).reverse().join('');
    },

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    export() {
        return JSON.stringify(this.logs, null, 2);
    },

    exportText() {
        return this.logs.map(entry => {
            let text = `[${entry.timestamp}] [${entry.type}] ${entry.message}`;
            if (entry.file) text += `\n  at ${entry.file}:${entry.line}:${entry.col}`;
            if (entry.stack) text += `\n${entry.stack}`;
            return text;
        }).join('\n\n');
    }
};

// Window functions for modal controls
export function openErrorLog() {
    ErrorLogger.render();
    document.getElementById('errorLogModal').classList.add('active');
}

export function closeErrorLog() {
    ErrorLogger.render();
    document.getElementById('errorLogModal').classList.remove('active');
}

export function clearErrorLog() {
    if (confirm('Clear all error logs?')) {
        ErrorLogger.clear();
        ErrorLogger.render();
    }
}

export function copyErrorLog() {
    const text = ErrorLogger.exportText();
    navigator.clipboard.writeText(text).then(() => {
        alert('Error log copied to clipboard!');
    }).catch(err => {
        console.error('Failed to copy:', err);
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
