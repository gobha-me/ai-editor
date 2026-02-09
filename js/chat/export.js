/**
 * Chat Export
 * Export chat history to markdown format
 */

import { State } from '../core.js';
import { getChatContainer } from './state.js';

/**
 * Export the current chat as markdown text and copy to clipboard.
 * Walks the DOM to capture all messages including tool call details.
 */
export function exportChat() {
    const chatContainer = getChatContainer();
    if (!chatContainer) return;

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

        const role = roleEl?.textContent?.trim() || 'Unknown';
        const time = timeEl?.textContent?.trim() || '';
        const content = contentEl?.textContent?.trim() || '';

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

    const text = lines.join('\n');

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
