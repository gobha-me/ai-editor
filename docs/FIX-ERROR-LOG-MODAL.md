# Fix: Add Missing Error Log Modal to index.html

## Problem
The Error Log Modal (`id="errorLogModal"`) is **missing** from `index.html`, causing this error when clicking the 🐛 button:

```
Cannot read properties of null (reading 'classList') @ error-logger.js:185:45
```

## Solution
Add the Error Log Modal HTML to `index.html` **before** the closing `</body>` tag, after the Settings Modal.

## Step-by-Step Fix

### 1. Locate the insertion point in `index.html`

Find this section near the end of the file (around line 529):

```html
    <!-- Toast Container -->
    <div class="toast-container" id="toastContainer"></div>

    <!-- Main Application Module -->
    <script type="module" src="./editor/js/app.js"></script>
</body>
```

### 2. Insert the Error Log Modal BEFORE the Toast Container

Add this code **before** the `<!-- Toast Container -->` line:

```html
    <!-- Error Log Modal -->
    <div class="modal-overlay" id="errorLogModal">
        <div class="modal" style="max-width: 800px;">
            <div class="modal-header">
                <h2>🐛 Error Log (<span id="errorLogCount">0</span>)</h2>
                <button class="modal-close" onclick="window.closeErrorLog()">×</button>
            </div>
            <div class="modal-body" style="max-height: 600px; overflow-y: auto;">
                <div id="errorLogContent">
                    <!-- Error logs will be rendered here by error-logger.js -->
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="window.clearErrorLog()">🗑️ Clear</button>
                <button class="btn btn-secondary" onclick="window.copyErrorLog()">📋 Copy</button>
                <button class="btn btn-primary" onclick="window.exportErrorLog()">📥 Export</button>
            </div>
        </div>
    </div>

    <!-- Toast Container -->
    <div class="toast-container" id="toastContainer"></div>
```

### 3. Verify the fix

After saving:
1. Reload the application
2. Click the 🐛 Error Log button
3. The modal should open successfully showing all logged errors

## What This Fixes

- ✅ Prevents `Cannot read properties of null` error
- ✅ Allows viewing application errors and warnings
- ✅ Enables error export/copy functionality
- ✅ Makes debugging infrastructure failures (like Gitea crashes) possible

## Related Files

- `js/error-logger.js` - Requires these element IDs:
  - `errorLogModal` - The modal container
  - `errorLogCount` - Error count display
  - `errorLogContent` - Where errors are rendered
- `html/error-log-modal.html` - Standalone template file (for reference)
