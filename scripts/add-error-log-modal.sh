#!/bin/bash
# Script to add the missing Error Log Modal to index.html
# Usage: ./scripts/add-error-log-modal.sh

set -e

INDEX_FILE="index.html"
BACKUP_FILE="index.html.backup.$(date +%Y%m%d_%H%M%S)"

# Check if index.html exists
if [ ! -f "$INDEX_FILE" ]; then
    echo "❌ Error: $INDEX_FILE not found!"
    echo "   Make sure you run this script from the repository root."
    exit 1
fi

# Check if modal already exists
if grep -q 'id="errorLogModal"' "$INDEX_FILE"; then
    echo "⚠️  Error Log Modal already exists in index.html"
    echo "   No changes needed!"
    exit 0
fi

# Create backup
cp "$INDEX_FILE" "$BACKUP_FILE"
echo "✅ Backup created: $BACKUP_FILE"

# Create modal HTML in a temp file
cat > /tmp/error-log-modal.html << 'EOF'
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

EOF

# Find the line number of the Toast Container comment
TOAST_LINE=$(grep -n '<!-- Toast Container -->' "$INDEX_FILE" | head -1 | cut -d: -f1)

if [ -z "$TOAST_LINE" ]; then
    echo "❌ Error: Could not find '<!-- Toast Container -->' in $INDEX_FILE"
    exit 1
fi

# Insert modal before the Toast Container line
head -n $((TOAST_LINE - 1)) "$INDEX_FILE" > /tmp/index_new.html
cat /tmp/error-log-modal.html >> /tmp/index_new.html
tail -n +$TOAST_LINE "$INDEX_FILE" >> /tmp/index_new.html

# Replace original file
mv /tmp/index_new.html "$INDEX_FILE"
rm /tmp/error-log-modal.html

echo "✅ Successfully added Error Log Modal to $INDEX_FILE"
echo "   Modal inserted before Toast Container (line $TOAST_LINE)"
echo ""
echo "📝 Next steps:"
echo "   1. Review the changes: git diff $INDEX_FILE"
echo "   2. Test: Open the app and click the 🐛 button"
echo "   3. Commit: git add $INDEX_FILE && git commit -m 'Add Error Log Modal'"
