/**
 * Command palette page — inline static HTML.
 *
 * Documents the 1.3.6 ⌘K command surface. As of 1.3.10 the palette is
 * a Phase 1 file finder aliasing Quick Open; the page also names what
 * accretes onto it in 1.3.11+ so users have an honest mental model.
 */

export function renderCommandPalette() {
    return `
        <article class="help__article">
            <div class="help__crumbs">Help <span class="help__crumb-sep">›</span> Command palette</div>
            <h1 class="help__h1">Command palette</h1>
            <p class="help__lede">Press <code class="help__code">Ctrl+K</code> (or <code class="help__code">⌘K</code> on macOS) from anywhere to open the command surface.</p>

            <h2 class="help__h2">Today (1.3.10)</h2>
            <p>The palette currently aliases <strong>Quick Open</strong>: you type a filename fragment, the list ranks files by recency and match score, and Enter opens the highlighted file. <code class="help__code">Ctrl+P</code> opens the same overlay — both keys share one surface so muscle memory works either way.</p>

            <h2 class="help__h2">What it accretes</h2>
            <p>Per the 1.3.x facelift arc, the palette grows two more search modes:</p>
            <ul class="help__ul">
                <li><strong>Commands</strong> — every action wired in the editor (toggle preview, run plugin command, switch model). One source of truth shared with the keyboard handler.</li>
                <li><strong>Settings &amp; help search</strong> — jump directly to a settings tab or a help page.</li>
            </ul>
            <p>Each mode is a prefix character at the start of the input (<code class="help__code">&gt;</code> for commands, <code class="help__code">?</code> for help, file matching is the default). The palette accumulates these incrementally; today the file mode is the only one shipped.</p>

            <h2 class="help__h2">Keys inside the palette</h2>
            <ul class="help__ul">
                <li><code class="help__code">↑ / ↓</code> — move selection</li>
                <li><code class="help__code">Enter</code> — open the highlighted file (preview tab)</li>
                <li><code class="help__code">Shift+Enter</code> — open in a pinned tab</li>
                <li><code class="help__code">Esc</code> — close</li>
            </ul>
        </article>
    `;
}
