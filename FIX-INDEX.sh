#!/bin/bash
# Fix index.html by adding Error Log Modal
# Usage: bash FIX-INDEX.sh

set -e

echo "🔧 Fixing index.html - Adding Error Log Modal..."

# Create backup
BACKUP="index.html.backup.$(date +%Y%m%d_%H%M%S)"
cp index.html "$BACKUP"
echo "✅ Created backup: $BACKUP"

# Check if modal already exists
if grep -q 'id="errorLogModal"' index.html; then
    echo "⚠️  Error Log Modal already exists in index.html"
    echo "No changes made."
    exit 0
fi

# Insert the modal before Toast Container
MODAL_HTML='
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
'

# Use sed to insert before Toast Container
sed -i.tmp "/<!-- Toast Container -->/i\\
$MODAL_HTML" index.html

rm -f index.html.tmp

echo "✅ Error Log Modal added successfully!"
echo ""
echo "📝 Next steps:"
echo "  1. Review changes: git diff index.html"
echo "  2. Test the application"
echo "  3. Commit: git add index.html && git commit -m 'Add Error Log Modal (fixes #52)'"
echo ""
echo "🎉 Done! The 🐛 button should now work without errors."
