/**
 * Chat Export
 * Export chat history to markdown format
 */

import { State } from '../core.js';
import { getChatContainer } from './state.js';
import { stripThinkBlocks } from '../llm/utils.js';

// Read message text from the canonical State.chatHistory entry rather than
// DOM textContent. The DOM goes through marked.parse with gfm:true, which
// autolinks code identifiers like `s.id` / `Date.now()` / `CHANGELOG.md`
// into anchor tags; reading text from the rendered tree was leaking those
// links back into the export as `[s.id](http://s.id)` (github#36).
function _canonicalMessageText(message) {
    if (!message) return null;
    if (Array.isArray(message.content)) {
        return message.content
            .filter(c => c && c.type === 'text')
            .map(c => c.text || '')
            .join('\n')
            .trim();
    }
    const raw = (message.content || '').toString();
    const stripped = message.role === 'assistant' ? stripThinkBlocks(raw) : raw;
    return (stripped || '').trim();
}

// Strip the degenerate `[X](http://X)` / `[X](https://X)` form where the
// link target equals the link text. Belt-and-suspenders against any future
// regression that re-introduces autolink mangling through a different path
// (e.g. tool-result text, third-party plugin output, re-imported content).
function _stripDegenerateAutolinks(text) {
    return text.replace(/\[([^\]\n]+)\]\((https?:\/\/\1)\)/g, '$1');
}

/**
 * Build the markdown export string. Returns null when no chat container
 * is mounted. Exported separately from {@link exportChat} so tests can
 * assert on the produced text without stubbing the clipboard.
 */
export function buildExportMarkdown() {
    const chatContainer = getChatContainer();
    if (!chatContainer) return null;

    const lines = [];
    const modelName = State.settings.llmModel || 'unknown';
    const project = State.currentProject 
        ? `${State.currentProject.owner}/${State.currentProject.repo}` 
        : 'none';
    
    lines.push(`# AI Editor Chat Export`);
    lines.push(`- **Model:** ${modelName}`);
    lines.push(`- **Project:** ${project}`);
    lines.push(`- **Branch:** ${State.currentBranch || 'main'}`);
    lines.push(`- **Exported:** ${new Date().toLocaleString()}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    const messages = chatContainer.querySelectorAll('.chat-message');
    for (const msg of messages) {
        // Tool call messages
        if (msg.classList.contains('tool-call')) {
            const summary = msg.querySelector('.tool-call-summary');
            const nameEl = msg.querySelector('.tool-call-name');
            const argsSummEl = msg.querySelector('.tool-call-args-summary');
            const statusEl = msg.querySelector('.tool-call-status');
            const argsJson = msg.querySelector('.tool-call-section:first-child .tool-call-json');
            const resultJson = msg.querySelector('.tool-call-section:last-child .tool-call-json');

            const name = nameEl?.textContent?.trim() || 'unknown';
            const argsSumm = argsSummEl?.textContent?.trim() || '';
            const status = statusEl?.textContent?.trim() || '';

            lines.push(`> 🔧 **${name}** ${argsSumm} → ${status}`);

            // Include args and result in collapsed detail
            if (argsJson?.textContent?.trim()) {
                lines.push(`> <details><summary>Details</summary>`);
                lines.push(`>`);
                lines.push(`> **Args:**`);
                lines.push(`> \`\`\`json`);
                for (const line of argsJson.textContent.trim().split('\n')) {
                    lines.push(`> ${line}`);
                }
                lines.push(`> \`\`\``);
                if (resultJson?.textContent?.trim()) {
                    lines.push(`> **Result:**`);
                    lines.push(`> \`\`\`json`);
                    // Truncate very long results
                    const resultText = resultJson.textContent.trim();
                    const resultLines = resultText.split('\n');
                    const maxLines = 30;
                    for (const line of resultLines.slice(0, maxLines)) {
                        lines.push(`> ${line}`);
                    }
                    if (resultLines.length > maxLines) {
                        lines.push(`> ... (${resultLines.length - maxLines} more lines)`);
                    }
                    lines.push(`> \`\`\``);
                }
                lines.push(`> </details>`);
            }
            lines.push('');
            continue;
        }

        // Regular messages
        const roleEl = msg.querySelector('.message-role');
        const timeEl = msg.querySelector('.message-time');
        const contentEl = msg.querySelector('.message-content');
        const reasoningEl = msg.querySelector('.message-reasoning .reasoning-body');

        const role = roleEl?.textContent?.trim() || 'Unknown';
        const time = timeEl?.textContent?.trim() || '';

        // Prefer the canonical State.chatHistory entry over DOM textContent.
        // The virtualizer tags rendered messages with data-virt-idx; tool-call
        // and consent-slot rows skip the tag, so message rows index cleanly.
        // Fall back to textContent if the index is missing or the lookup
        // is out-of-sync with the DOM (e.g. mid-stream / error states).
        const virtIdxAttr = msg.getAttribute('data-virt-idx');
        const virtIdx = virtIdxAttr === null ? -1 : Number(virtIdxAttr);
        const canonical = Number.isInteger(virtIdx) && virtIdx >= 0
            ? _canonicalMessageText(State.chatHistory[virtIdx])
            : null;
        if (canonical === null && virtIdxAttr !== null) {
            console.warn('[exportChat] chatHistory lookup failed for virt-idx', virtIdxAttr, '— falling back to DOM textContent');
        }
        const content = canonical !== null
            ? canonical
            : (contentEl?.textContent?.trim() || '');

        if (msg.classList.contains('user')) {
            lines.push(`### 👤 You (${time})`);
        } else if (msg.classList.contains('assistant')) {
            lines.push(`### 🤖 Assistant (${time})`);
        } else if (msg.classList.contains('system')) {
            lines.push(`### ℹ️ System (${time})`);
        } else if (msg.classList.contains('error')) {
            lines.push(`### ❌ Error (${time})`);
        } else {
            lines.push(`### ${role} (${time})`);
        }

        // Reasoning bubble (1.3.1): emit captured reasoning as a collapsed
        // <details> block so 1.3.4 replay viewer can step through what the
        // model thought. Absent ≡ no block. Indented per-line so it nests
        // cleanly under the heading in markdown renderers.
        if (reasoningEl) {
            const reasoningText = reasoningEl.textContent?.trim() || '';
            if (reasoningText) {
                lines.push(`<details><summary>💭 Reasoning</summary>`);
                lines.push('');
                for (const line of reasoningText.split('\n')) {
                    lines.push(line);
                }
                lines.push('');
                lines.push(`</details>`);
                lines.push('');
            }
        }

        lines.push(content);
        lines.push('');
    }

    // Cost summary
    if (State.sessionCost.requests > 0) {
        const sc = State.sessionCost;
        const totalTok = sc.totalInputTokens + sc.totalOutputTokens;
        let summary = `**Session:** ${totalTok} tokens (${sc.totalInputTokens}↓ ${sc.totalOutputTokens}↑`;
        if (sc.cachedInputTokens > 0) summary += ` · ${sc.cachedInputTokens} cached`;
        if (sc.reasoningTokens > 0) summary += ` · ${sc.reasoningTokens} reasoning`;
        summary += `) · $${sc.totalCost.toFixed(4)}`;
        if (sc.cacheSavings > 0) summary += ` (-$${sc.cacheSavings.toFixed(4)} saved)`;
        summary += ` · ${sc.requests} requests`;
        lines.push('---');
        lines.push('');
        lines.push(summary);
    }

    return _stripDegenerateAutolinks(lines.join('\n'));
}

/**
 * Export the current chat as markdown text and copy to clipboard.
 * Walks the DOM for tool-call cards (rendered-only state) and
 * State.chatHistory for message text (canonical markdown source).
 */
export function exportChat() {
    const text = buildExportMarkdown();
    if (text === null) return;

    // Copy to clipboard
    navigator.clipboard.writeText(text).then(() => {
        window.showToast('Chat copied to clipboard', 'success');
    }).catch(() => {
        // Fallback: select in a textarea
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        window.showToast('Chat copied to clipboard', 'success');
    });
}
