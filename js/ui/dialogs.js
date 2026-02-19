/**
 * AI Editor - Themed Dialog System (v0.9.39-1)
 *
 * Drop-in replacements for window.alert / confirm / prompt
 * using styled modals that match the editor theme.
 *
 *   showAlert(message, opts?)   → Promise<void>
 *   showConfirm(message, opts?) → Promise<boolean>
 *   showPrompt(message, opts?)  → Promise<string|null>
 *
 * All three return Promises — use `await` at the call site.
 *
 * @module ui/dialogs
 */

// ── Shared DOM bootstrap ──────────────────────────────────

let _overlay = null;

/** Lazily create the dialog overlay + inner structure once. */
function _ensureDOM() {
    if (_overlay) return;

    _overlay = document.createElement('div');
    _overlay.className = 'dialog-overlay';
    _overlay.id = 'dialogOverlay';
    _overlay.setAttribute('role', 'dialog');
    _overlay.setAttribute('aria-modal', 'true');
    _overlay.innerHTML = `
        <div class="dialog-box">
            <div class="dialog-header">
                <span class="dialog-title" id="dialogTitle"></span>
                <button type="button" class="modal-close dialog-cancel-btn" aria-label="Close">×</button>
            </div>
            <div class="dialog-body">
                <p class="dialog-message" id="dialogMessage"></p>
                <div class="dialog-input-wrap" id="dialogInputWrap" style="display:none;">
                    <textarea class="dialog-input" id="dialogInput" rows="3"></textarea>
                </div>
            </div>
            <div class="dialog-footer">
                <button type="button" class="btn btn-secondary dialog-cancel-btn" id="dialogCancelBtn" style="display:none;">Cancel</button>
                <button type="button" class="btn btn-primary dialog-ok-btn" id="dialogOkBtn">OK</button>
            </div>
        </div>
    `;
    document.body.appendChild(_overlay);

    // Close on overlay click (outside the box)
    _overlay.addEventListener('mousedown', (e) => {
        if (e.target === _overlay) {
            _overlay.querySelector('.dialog-cancel-btn')?.click();
        }
    });
}

// ── Core open / close ─────────────────────────────────────

let _resolveDialog = null;

function _open(opts) {
    _ensureDOM();

    const {
        title = '',
        message = '',
        okLabel = 'OK',
        cancelLabel = 'Cancel',
        showCancel = false,
        showInput = false,
        inputDefault = '',
        inputPlaceholder = '',
        inputRequired = false,
        variant = 'default',    // 'default' | 'danger'
    } = opts;

    // Title
    const titleEl = _overlay.querySelector('#dialogTitle');
    titleEl.textContent = title;
    titleEl.style.display = title ? '' : 'none';

    // Message — support newlines
    const msgEl = _overlay.querySelector('#dialogMessage');
    msgEl.innerHTML = _escapeAndNl(message);

    // Input
    const inputWrap = _overlay.querySelector('#dialogInputWrap');
    const inputEl = _overlay.querySelector('#dialogInput');
    inputWrap.style.display = showInput ? '' : 'none';
    if (showInput) {
        inputEl.value = inputDefault;
        inputEl.placeholder = inputPlaceholder;
        inputEl.dataset.required = inputRequired ? '1' : '';
    }

    // Buttons
    const cancelBtn = _overlay.querySelector('#dialogCancelBtn');
    const okBtn = _overlay.querySelector('#dialogOkBtn');
    cancelBtn.style.display = showCancel ? '' : 'none';
    cancelBtn.textContent = cancelLabel;
    okBtn.textContent = okLabel;
    okBtn.className = `btn dialog-ok-btn ${variant === 'danger' ? 'btn-danger' : 'btn-primary'}`;

    // Show
    _overlay.classList.add('active');

    // Focus — input if present, else OK
    requestAnimationFrame(() => {
        if (showInput) {
            inputEl.focus();
            inputEl.select();
        } else {
            okBtn.focus();
        }
    });

    // Wire handlers (fresh each time to avoid stale closures)
    const controller = new AbortController();
    const sig = { signal: controller.signal };

    return new Promise(resolve => {
        _resolveDialog = resolve;

        const finish = (value) => {
            controller.abort();
            _overlay.classList.remove('active');
            _resolveDialog = null;
            resolve(value);
        };

        // OK
        okBtn.addEventListener('click', () => {
            if (showInput) {
                const val = inputEl.value;
                if (inputRequired && !val.trim()) {
                    inputEl.classList.add('dialog-input-error');
                    inputEl.focus();
                    return;
                }
                finish(val);
            } else {
                finish(true);
            }
        }, sig);

        // Cancel (button or ×)
        _overlay.querySelectorAll('.dialog-cancel-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                finish(showInput ? null : false);
            }, sig);
        });

        // Keyboard
        _overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                finish(showInput ? null : showCancel ? false : true);
            }
            if (e.key === 'Enter' && !showInput) {
                e.preventDefault();
                okBtn.click();
            }
            // Ctrl/Cmd+Enter submits when input is present
            if (e.key === 'Enter' && showInput && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                okBtn.click();
            }
        }, sig);

        // Clear error styling on type
        if (showInput) {
            inputEl.addEventListener('input', () => {
                inputEl.classList.remove('dialog-input-error');
            }, sig);
        }
    });
}

function _escapeAndNl(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
}

// ── Public API ────────────────────────────────────────────

/**
 * Show a simple alert (replaces window.alert).
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @returns {Promise<void>}
 */
export async function showAlert(message, opts = {}) {
    await _open({
        title: opts.title || '',
        message,
        okLabel: opts.okLabel || 'OK',
        showCancel: false,
        showInput: false,
    });
}

/**
 * Show a confirm dialog (replaces window.confirm).
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @param {string} [opts.okLabel]      - Default 'Confirm'
 * @param {string} [opts.cancelLabel]  - Default 'Cancel'
 * @param {'default'|'danger'} [opts.variant] - 'danger' for destructive confirms
 * @returns {Promise<boolean>}
 */
export async function showConfirm(message, opts = {}) {
    return _open({
        title: opts.title || '',
        message,
        okLabel: opts.okLabel || 'Confirm',
        cancelLabel: opts.cancelLabel || 'Cancel',
        showCancel: true,
        showInput: false,
        variant: opts.variant || 'default',
    });
}

/**
 * Show a prompt dialog with a text input (replaces window.prompt).
 * Returns the entered string, or null if cancelled.
 * @param {string} message
 * @param {object} [opts]
 * @param {string} [opts.title]
 * @param {string} [opts.defaultValue]
 * @param {string} [opts.placeholder]
 * @param {boolean} [opts.required]    - If true, disallow empty submit
 * @param {string} [opts.okLabel]      - Default 'Submit'
 * @param {string} [opts.cancelLabel]  - Default 'Cancel'
 * @returns {Promise<string|null>}
 */
export async function showPrompt(message, opts = {}) {
    return _open({
        title: opts.title || '',
        message,
        okLabel: opts.okLabel || 'Submit',
        cancelLabel: opts.cancelLabel || 'Cancel',
        showCancel: true,
        showInput: true,
        inputDefault: opts.defaultValue || '',
        inputPlaceholder: opts.placeholder || '',
        inputRequired: opts.required || false,
    });
}
