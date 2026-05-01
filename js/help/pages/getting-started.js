/**
 * Getting Started page — inline static HTML, ~5 sections.
 *
 * Short orientation text covering what AI Editor is and how to start.
 * Mirrors the design's "Getting started" nav entry.
 */

export function renderGettingStarted() {
    return `
        <article class="help__article">
            <div class="help__crumbs">Help <span class="help__crumb-sep">›</span> Getting started</div>
            <h1 class="help__h1">Getting started</h1>
            <p class="help__lede">AI Editor is a browser-based code editor with built-in AI assistance.
                Everything runs client-side; the only network calls are to the LLM provider you configure
                and the git host(s) you connect.</p>

            <h2 class="help__h2">Connect a repository</h2>
            <p>Open <strong>Settings → Connections</strong> (Workspace group). Add a GitHub, Gitea, or
                GitLab connection, paste a personal access token, then pick a project from the sidebar
                project picker. Files index in the background; Quick Open
                (<code class="help__code">Ctrl+P</code>) becomes available once indexing finishes.</p>

            <h2 class="help__h2">Set up AI</h2>
            <p>Open <strong>Settings → LLM</strong> (AI group). Configure a provider (Venice, OpenAI,
                Anthropic, OpenRouter, local Ollama, etc.), select a model, and save. The chat panel on
                the right is your primary AI surface.</p>

            <h2 class="help__h2">Use the chat</h2>
            <p>Press <code class="help__code">Ctrl+J</code> to toggle the chat panel. Drag a file into the
                input to attach it; tag the editor with <code class="help__code">@editor</code> to give the
                model the current buffer. Press <code class="help__code">Enter</code> to send,
                <code class="help__code">Shift+Enter</code> for a new line.</p>

            <h2 class="help__h2">Commit changes</h2>
            <p>Edit files in the editor; dirty tabs show a dot. Press <code class="help__code">Ctrl+S</code>
                to open the commit modal. The AI can draft commit messages from your diff. Push happens
                automatically against the connected branch.</p>

            <h2 class="help__h2">Where to look next</h2>
            <ul class="help__ul">
                <li><strong>Hotkeys</strong> — every keyboard shortcut, platform-aware.</li>
                <li><strong>Plugin SDK</strong> — extend the editor with bundled or external plugins.</li>
                <li><strong>Roles</strong> — task-scoped AI personas (commit-message, review, etc.).</li>
                <li><strong>Memory</strong> — how AI Editor remembers project facts across conversations.</li>
                <li><strong>Architecture</strong> — how the pieces fit together.</li>
            </ul>
        </article>
    `;
}
