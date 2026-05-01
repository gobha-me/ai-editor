/**
 * Themes page — inline static HTML referencing the 1.3.5 `--tk-*` token
 * contract. Documents how to ship a theme as a plugin.
 */

export function renderThemes() {
    return `
        <article class="help__article">
            <div class="help__crumbs">Building <span class="help__crumb-sep">›</span> Themes</div>
            <h1 class="help__h1">Themes</h1>
            <p class="help__lede">A theme is a CSS file that overrides the <code class="help__code">--tk-*</code> token contract. AI Editor ships two: <strong>Refined IDE</strong> (default) and <strong>Editorial Calm</strong> (bundled). Plugin authors can ship their own.</p>

            <h2 class="help__h2">The token contract</h2>
            <p>Every color, font, radius, spacing, and shadow the app renders comes from a <code class="help__code">--tk-*</code> CSS variable defined in <code class="help__code">css/themes/tokens.css</code>. The contract is <strong>frozen as of 1.3.5</strong> — once published, removing or renaming a token is a breaking change for plugin theme authors. New tokens can be added freely.</p>

            <h2 class="help__h2">Token vocabulary</h2>
            <ul class="help__ul">
                <li><strong>Backgrounds</strong> — <code class="help__code">--tk-bg-darker</code>, <code class="help__code">--tk-bg-app</code>, <code class="help__code">--tk-bg-surface</code>, <code class="help__code">--tk-bg-raised</code>, <code class="help__code">--tk-bg-hover</code>, <code class="help__code">--tk-bg-active</code>, <code class="help__code">--tk-bg-overlay</code></li>
                <li><strong>Text</strong> — <code class="help__code">--tk-text-primary</code>, <code class="help__code">--tk-text-secondary</code>, <code class="help__code">--tk-text-muted</code>, <code class="help__code">--tk-text-on-accent</code>, <code class="help__code">--tk-text-on-light</code></li>
                <li><strong>Accent</strong> — <code class="help__code">--tk-color-accent</code>, <code class="help__code">--tk-color-accent-hover</code></li>
                <li><strong>Semantic</strong> — <code class="help__code">--tk-color-success</code>, <code class="help__code">--tk-color-warning</code>, <code class="help__code">--tk-color-warning-strong</code>, <code class="help__code">--tk-color-error</code>, <code class="help__code">--tk-color-danger</code>, <code class="help__code">--tk-color-info</code></li>
                <li><strong>Diff</strong> — <code class="help__code">--tk-color-diff-add</code>, <code class="help__code">--tk-color-diff-remove</code></li>
                <li><strong>Borders</strong> — <code class="help__code">--tk-border</code>, <code class="help__code">--tk-border-light</code></li>
                <li><strong>Radii</strong> — <code class="help__code">--tk-radius-sm</code>, <code class="help__code">--tk-radius-md</code>, <code class="help__code">--tk-radius-lg</code>, <code class="help__code">--tk-radius-xl</code>, <code class="help__code">--tk-radius-pill</code></li>
                <li><strong>Spacing</strong> — <code class="help__code">--tk-space-1</code> … <code class="help__code">--tk-space-8</code></li>
                <li><strong>Fonts</strong> — <code class="help__code">--tk-font-sans</code>, <code class="help__code">--tk-font-serif</code>, <code class="help__code">--tk-font-mono</code></li>
                <li><strong>Shadows</strong> — <code class="help__code">--tk-shadow-sm</code>, <code class="help__code">--tk-shadow-md</code>, <code class="help__code">--tk-shadow-lg</code></li>
            </ul>

            <h2 class="help__h2">Shipping a theme as a plugin</h2>
            <p>A theme plugin has no JS entry. Manifest plus one CSS file:</p>
            <pre class="help__pre"><code>{
  "id": "your-theme",
  "version": "1.0.0",
  "name": "Your Theme",
  "type": "theme",
  "css": "your-theme.css"
}</code></pre>
            <p>Override every token in your CSS file's <code class="help__code">:root</code> selector. Missing tokens fall back to the placeholder values in <code class="help__code">tokens.css</code>, so a partial theme degrades gracefully but won't ship a coherent look.</p>

            <h2 class="help__h2">Component CSS rule</h2>
            <p>App CSS outside <code class="help__code">css/themes/</code> must not define hex literals as primary values. Translucent overlays (<code class="help__code">rgba(0,0,0,…)</code>) are theme-neutral and exempt; document the choice in a comment when used.</p>
        </article>
    `;
}
