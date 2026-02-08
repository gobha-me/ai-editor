#!/usr/bin/env python3
"""
Script to add the missing Error Log Modal to index.html

Usage:
    python3 scripts/add-error-log-modal.py

This script will:
1. Read index.html
2. Find the Toast Container insertion point  
3. Insert the Error Log Modal before it
4. Save the updated file
5. Create a backup at index.html.backup
"""

import os
import shutil
from datetime import datetime

ERROR_LOG_MODAL_HTML = '''    <!-- Error Log Modal -->
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

'''

def main():
    index_path = 'index.html'
    
    if not os.path.exists(index_path):
        print(f"❌ Error: {index_path} not found!")
        print("   Make sure you run this script from the repository root.")
        return 1
    
    # Create backup
    backup_path = f"{index_path}.backup.{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(index_path, backup_path)
    print(f"✅ Backup created: {backup_path}")
    
    # Read the file
    with open(index_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Check if modal already exists
    if 'id="errorLogModal"' in content:
        print("⚠️  Error Log Modal already exists in index.html")
        print("   No changes needed!")
        return 0
    
    # Find the insertion point (before Toast Container)
    marker = '    <!-- Toast Container -->'
    
    if marker not in content:
        print(f"❌ Error: Could not find insertion point")
        print(f"   Looking for: {marker}")
        return 1
    
    # Insert the modal
    updated_content = content.replace(marker, ERROR_LOG_MODAL_HTML + marker)
    
    # Write the updated file
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write(updated_content)
    
    print(f"✅ Successfully added Error Log Modal to {index_path}")
    print(f"   Modal inserted before Toast Container")
    print(f"\n📝 Next steps:")
    print(f"   1. Review the changes: git diff {index_path}")
    print(f"   2. Test: Open the app and click the 🐛 button")
    print(f"   3. Commit: git add {index_path} && git commit -m 'Add Error Log Modal'")
    
    return 0

if __name__ == '__main__':
    exit(main())
