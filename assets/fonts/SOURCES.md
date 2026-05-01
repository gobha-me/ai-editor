# Self-hosted woff2 fonts — provenance

These font files ship with AI Editor 1.3.12+ to give every user — across
operating systems and across themes — identical typography. They are
sourced from the [`@fontsource`](https://fontsource.org/) project (each
font as an individual MIT-licensed npm package). Files were downloaded
from the jsdelivr CDN mirror once at PR-prep time and committed to this
directory; **no runtime fetch from any CDN ever happens**, matching the
offline-by-construction ethos established by 1.3.11 (Lucide icons
inlined as SVG strings).

## Subsetting

All files are the **`latin` subset** that `@fontsource` ships by default.
This covers the Latin alphabet plus common diacritics. The codebase has
no i18n layer; if exotic glyphs (Cyrillic / Greek / Vietnamese / CJK)
appear in user content, they fall through to the system stack via the
`@font-face` `local()` lookup chain in [`css/themes/fonts.css`](../../css/themes/fonts.css).

## Files

Bundle total: 19 files, ~407 KB on disk.

| Family | Used by theme | License | Package version | Files |
|---|---|---|---|---|
| **Inter** | Refined IDE (UI) | OFL 1.1 | `@fontsource/inter@5.2.8` | 400 / 500 / 600 / 700 normal + 400 italic |
| **IBM Plex Sans** | Editorial Calm (UI) | OFL 1.1 | `@fontsource/ibm-plex-sans@5.2.8` | 400 / 500 / 600 / 700 normal + 400 italic |
| **Source Serif 4** | Editorial Calm (serif slot) | OFL 1.1 | `@fontsource/source-serif-4@5.2.9` | 400 / 600 normal + 400 italic |
| **JetBrains Mono** | Refined IDE (code) | OFL 1.1 | `@fontsource/jetbrains-mono@5.2.8` | 400 / 500 / 700 normal |
| **IBM Plex Mono** | Editorial Calm (code) | OFL 1.1 | `@fontsource/ibm-plex-mono@5.2.7` | 400 / 500 / 700 normal |

Weight matrix derived from the actual `font-weight:` declarations in
`css/` at the time of the patch (grep showed 400 / 500 / 600 / 700 only;
italic only at weight 400). Adding new weights later means downloading
the matching `.woff2` from the same `@fontsource` package and registering
it in `fonts.css`.

## Source URL pattern

```
https://cdn.jsdelivr.net/npm/@fontsource/<package>@<version>/files/<package>-latin-<weight>-<style>.woff2
```

The `@fontsource` GitHub repository is at <https://github.com/fontsource/fontsource>;
the underlying font foundries are:

- **Inter** — Rasmus Andersson — <https://rsms.me/inter/>
- **IBM Plex Sans / Mono** — IBM — <https://www.ibm.com/plex/>
- **Source Serif 4** — Adobe — <https://github.com/adobe-fonts/source-serif>
- **JetBrains Mono** — JetBrains — <https://www.jetbrains.com/lp/mono/>

All five families ship under the SIL Open Font License 1.1, which permits
embedding, redistribution, and modification without attribution in the
running application (attribution remains in this file as the project's
courtesy record).

## Updating

To bump a font version, fetch the new `.woff2` files from the `@fontsource`
package's `files/` directory at the new version, replace the existing
files in this directory by name, and update the version column above.
The `@font-face` rules in `css/themes/fonts.css` reference filenames
(not versions), so no CSS changes are needed unless a weight is added
or removed.
