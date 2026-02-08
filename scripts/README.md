# AI Editor Scripts

Utility scripts for maintenance and fixes.

## add-error-log-modal

**Problem:** The Error Log Modal is missing from `index.html`, causing the 🐛 button to crash.

**Solution:** Run one of these scripts to automatically add the modal:

### Python (Cross-platform)
```bash
python3 scripts/add-error-log-modal.py
```

### Bash (Unix/Linux/Mac)
```bash
chmod +x scripts/add-error-log-modal.sh
./scripts/add-error-log-modal.sh
```

Both scripts will:
- Create a timestamped backup of `index.html`
- Insert the Error Log Modal at the correct location
- Show you next steps for testing and committing

### Manual Alternative

See `docs/FIX-ERROR-LOG-MODAL.md` for manual instructions.

---

## Related Issues

- [#52 - Missing Error Log Modal in index.html causes crash](https://git.gobha.me/xcaliber/ai-editor/issues/52)

## Contributing

When adding new scripts:
1. Add them to this README
2. Include clear usage instructions
3. Add error handling and validation
4. Create backups before modifying files
5. Provide helpful output messages
