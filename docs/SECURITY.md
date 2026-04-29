# Security

AI Editor runs entirely in the browser. There is no backend, no `node_modules`, and no remote code execution server we control. The trust boundaries are:

1. **The browser ↔ your Git host** — TLS, your Git host's auth, your tokens.
2. **The browser ↔ your LLM provider** — TLS, your provider's auth, your API keys.
3. **The browser ↔ files you open or import** — code in the editor, plugins you install, settings JSON you import.

Boundary 3 is where source-level supply-chain attacks land. This document covers the threat model, the protections shipped in the editor, and what stays the user's responsibility.

## Threat model

### Glassworm (Unicode tags block)

Codepoints in the **Unicode tags block** (`U+E0000`–`U+E007F`) render as zero-width but are valid program text. A malicious actor can encode an entire payload in tag chars that look like an empty file in any standard text editor. Glassworm-class attacks were observed shipping through npm packages and IDE extensions in 2025–2026; AI Editor's plugin format inherits the same threat surface.

### Trojan Source (bidi overrides)

Codepoints `U+202A`–`U+202E` and `U+2066`–`U+2069` reorder how text renders without changing its byte sequence. A reviewer reading `if (admin) { revoke(user); }` may see a different statement than the one the runtime executes. The Trojan Source paper (CVE-2021-42574) catalogued this against C, C++, Go, JS, Python, and Rust — the renderer disagrees with the parser.

### Polyglot exfiltration / steganography (zero-width)

Codepoints `U+200B`–`U+200F`, `U+2060`–`U+206F`, and `U+FEFF` are invisible to the eye and to most diff tools. They can hide structured payloads inside otherwise-clean source. The editor's plugin format is JS — the user's browser executes it directly, no review pipeline.

### Plugin supply chain

Plugins are arbitrary JS that runs with full access to the editor's `window` and `AIEditor` globals. AI Editor does not sandbox plugins. Once a user clicks Install on a plugin URL, that code can read tokens, exfiltrate clipboard data, or modify open files. The protections below add **review surfaces** at the boundaries; they do not eliminate the underlying trust requirement on plugin authors.

## What ships in 1.1.4

### CI lint — invisible Unicode

`.gitea/workflows/ci.yaml` runs a `grep -P` step on every PR scanning `js/`, `plugins/`, `tests/` (`*.js`, `*.mjs`, `*.json`) for the codepoint ranges listed below. PRs introducing any of them fail the build with line + character output. The grep pattern is the canonical reference; if you change the ranges, change all three places (the workflow, `js/security/invisible-unicode.js`, and the table in this document).

### Editor decoration

`js/editor/invisible-unicode-decoration.js` registers a CodeMirror 6 inline decoration that replaces every flagged codepoint with a visible `U+xxxx` widget. The widget has a tooltip naming the codepoint and is clickable to delete the underlying character. `Mod-Shift-U` strips every flagged character from the current selection.

The decoration is **on by default for code/config files** and **off by default for prose** (`*.md`, `*.markdown`, `*.html`, `*.htm`, `*.xml`, `*.xhtml`) where bidi/zero-width characters are sometimes legitimate. Toggle in **Settings → Appearance → Scan for invisible Unicode**.

### Plugin install scan

When the user installs a plugin via Settings → Plugins → Install from URL, the fetched source is scanned before execution. If invisible characters are present, an inline warning band lists the first three findings and offers Cancel (default) or "Install anyway." Trust-on-first-install: subsequent reloads do **not** rescan the same source. If a plugin URL changes, the user reinstalls and the scan runs fresh.

### Settings import scan

Settings → Import-from-JSON scans the file content before parsing. If invisible characters are found, a confirmation dialog surfaces the count and the first three findings; the import is blocked unless the user explicitly clicks "Import anyway." This catches Trojan-Source-style domain spoofing in connection URLs and tampered API tokens.

## What does NOT ship (residual user responsibility)

- **Plugins are not sandboxed.** They execute with full DOM and `AIEditor` globals. Audit plugin source before installing, especially from URLs you don't control.
- **Trust-on-first-install** for plugins. The scan runs at install time only; subsequent reloads import the saved source unconditionally.
- **No plugin URL provenance / TLS pinning.** A MITM attacker who can rewrite plugin URLs can swap the source. Mitigations: use HTTPS Git hosts; pin to release commits, not branches.
- **No vendor-bundle signature verification.** `vendor/codemirror-bundle.js` is built at Docker image time from `vendor/package.json`. The build itself is the trust root.
- **No scan of arbitrary content opened for editing.** The editor decoration covers files you open in the editor surface — it does not scan the contents of arbitrary repos before checkout, nor source returned by LLM tool calls.
- **No protection against the LLM emitting invisible Unicode in suggestions.** A model that has been trained on tampered data could, in principle, generate code containing zero-width payloads. The editor decoration *will* surface them once the suggestion lands in the editor — but the user has to look.
- **No CSP / iframe isolation for the editor itself.** XSS via the chat or tool-result render path is in scope for the existing DOMPurify hardening (1.0.4); see CHANGELOG for the bypass-audit lint.

## Codepoint reference

The CI lint, the JS scanner, and this table must agree. If you add a range, add it in all three.

| Range | Family | Threat |
|---|---|---|
| `U+200B` – `U+200F` | Zero-width / directional | Steganography, polyglot exfiltration, RTL marks |
| `U+2060` – `U+206F` | Word joiner / invisible operators | Steganography, formula confusion |
| `U+FEFF` | Zero Width No-Break Space (BOM) | Hidden BOM as a payload separator |
| `U+202A` – `U+202E` | Bidi embedding / override | Trojan Source: renderer ↔ parser disagreement |
| `U+2066` – `U+2069` | Bidi isolate | Trojan Source variants |
| `U+E0000` – `U+E007F` | Tags block | Glassworm: invisible code execution |

The grep `-P` pattern that implements this in CI:

```
grep -rPn '[\x{E0000}-\x{E007F}\x{200B}-\x{200F}\x{2060}-\x{206F}\x{FEFF}\x{202A}-\x{202E}\x{2066}-\x{2069}]' js/ plugins/ tests/ --include='*.js' --include='*.mjs' --include='*.json'
```

The JS regex (in `js/security/invisible-unicode.js`):

```js
/[\u200B-\u200F\u2060-\u206F\uFEFF\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/gu
```

## Reporting a vulnerability

Open an issue on the Gitea repo with the label `security`. For sensitive disclosures, contact the maintainer at the address in the repo's `LICENSE` file. Please include reproduction steps and the affected version (the version string lives at `js/version.js`).

## Security-relevant releases

| Version | Date | Change |
|---|---|---|
| 1.0.4 | 2026-02-23 | DOMPurify hardening pass: removed bypass paths, added the `'return raw;'` CI lint, escape audit on tool-result render. |
| 1.1.4 | _this release_ | Invisible-Unicode protection: CI lint, editor decoration, plugin install scan, settings import scan, this document. |

For the detailed changelog see [CHANGELOG.md](../CHANGELOG.md).
