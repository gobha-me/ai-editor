// @ts-check
/**
 * Heatmap + line-plot rendering for NIAH grid results.
 * Pure DOM/CSS — no charting deps.
 *
 * @module evals/render-heatmap
 */

import { formatUsd, formatDuration } from './cost-preflight.js';

/**
 * @typedef {Object} CellResult
 * @property {string} model
 * @property {number} lengthTokens
 * @property {number} depthPct
 * @property {boolean} hit
 * @property {string|null} error
 * @property {number} costUsd
 * @property {number} latencyMs
 */

/**
 * Group cells by (model, length, depth), compute mean hit rate per cell.
 * @param {CellResult[]} cells
 * @returns {Map<string, Map<number, Map<number, {hits:number, n:number, errors:number, meanLatencyMs:number}>>>}
 */
function aggregate(cells) {
    /** @type {any} */
    const byModel = new Map();
    for (const c of cells) {
        if (!byModel.has(c.model)) byModel.set(c.model, new Map());
        const byLen = byModel.get(c.model);
        if (!byLen.has(c.lengthTokens)) byLen.set(c.lengthTokens, new Map());
        const byDepth = byLen.get(c.lengthTokens);
        const k = c.depthPct;
        const acc = byDepth.get(k) ?? { hits: 0, n: 0, errors: 0, latencySum: 0 };
        if (c.error) acc.errors++;
        else { acc.n++; if (c.hit) acc.hits++; acc.latencySum += c.latencyMs; }
        byDepth.set(k, acc);
    }
    // Materialize meanLatency
    for (const m of byModel.values()) {
        for (const l of m.values()) {
            for (const [d, a] of l.entries()) {
                a.meanLatencyMs = a.n > 0 ? Math.round(a.latencySum / a.n) : 0;
                l.set(d, a);
            }
        }
    }
    return byModel;
}

/**
 * @param {HTMLElement} container
 * @param {CellResult[]} cells
 */
export function renderHeatmap(container, cells) {
    container.innerHTML = '';
    if (cells.length === 0) {
        container.textContent = 'No results yet.';
        return;
    }
    const byModel = aggregate(cells);
    for (const [model, byLen] of byModel.entries()) {
        const wrap = document.createElement('div');
        wrap.className = 'eval-heatmap-block';

        const title = document.createElement('h3');
        title.textContent = model;
        wrap.appendChild(title);

        const lengths = Array.from(byLen.keys()).sort((a, b) => a - b);
        const depthSet = new Set();
        for (const l of byLen.values()) for (const d of l.keys()) depthSet.add(d);
        const depths = Array.from(depthSet).sort((a, b) => a - b);

        const table = document.createElement('table');
        table.className = 'eval-heatmap';
        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        hr.appendChild(td('th', 'length \\ depth'));
        for (const d of depths) hr.appendChild(td('th', `${(d * 100).toFixed(0)}%`));
        thead.appendChild(hr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        for (const len of lengths) {
            const row = document.createElement('tr');
            row.appendChild(td('th', `${formatTokens(len)}`));
            const depthMap = byLen.get(len);
            for (const d of depths) {
                const a = depthMap.get(d);
                const cell = document.createElement('td');
                if (!a || (a.n === 0 && a.errors === 0)) {
                    cell.textContent = '—';
                    cell.className = 'eval-cell empty';
                } else {
                    const rate = a.n > 0 ? a.hits / a.n : 0;
                    const pct = (rate * 100).toFixed(0);
                    cell.textContent = a.errors > 0
                        ? `${a.hits}/${a.n}+${a.errors}!`
                        : `${a.hits}/${a.n}`;
                    cell.title = `hit ${pct}% · ${a.meanLatencyMs}ms avg` + (a.errors ? ` · ${a.errors} errors` : '');
                    cell.className = 'eval-cell';
                    if (a.errors > 0 && a.n === 0) cell.classList.add('cell-error');
                    cell.style.background = colorForRate(rate);
                }
                row.appendChild(cell);
            }
            tbody.appendChild(row);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);

        // Depth-vs-hit-rate line plot (per length)
        wrap.appendChild(renderLineChart(byLen, depths, lengths));

        container.appendChild(wrap);
    }
}

function renderLineChart(byLen, depths, lengths) {
    const W = 480, H = 180, PAD = 32;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.classList.add('eval-line-chart');

    // Axes
    addLine(svg, PAD, H - PAD, W - PAD, H - PAD, '#888');
    addLine(svg, PAD, PAD, PAD, H - PAD, '#888');
    addText(svg, PAD - 6, PAD + 4, '1.0', 'end', 10);
    addText(svg, PAD - 6, H - PAD + 4, '0.0', 'end', 10);
    addText(svg, PAD, H - PAD + 14, '0%', 'middle', 10);
    addText(svg, W - PAD, H - PAD + 14, '100%', 'middle', 10);
    addText(svg, W / 2, H - 6, 'depth', 'middle', 10);
    addText(svg, 8, PAD - 6, 'hit rate', 'start', 10);

    const xs = (d) => PAD + d * (W - 2 * PAD);
    const ys = (r) => (H - PAD) - r * (H - 2 * PAD);

    const palette = ['#e44', '#4a4', '#48d', '#d84', '#84d'];
    let li = 0;
    const legendItems = [];
    for (const len of lengths) {
        const dm = byLen.get(len);
        const points = [];
        for (const d of depths) {
            const a = dm.get(d);
            if (!a || a.n === 0) continue;
            const r = a.hits / a.n;
            points.push([xs(d), ys(r)]);
        }
        if (points.length < 2) continue;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        path.setAttribute('points', points.map(p => p.join(',')).join(' '));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', palette[li % palette.length]);
        path.setAttribute('stroke-width', '2');
        svg.appendChild(path);
        for (const [x, y] of points) {
            const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            c.setAttribute('cx', String(x));
            c.setAttribute('cy', String(y));
            c.setAttribute('r', '3');
            c.setAttribute('fill', palette[li % palette.length]);
            svg.appendChild(c);
        }
        legendItems.push({ len, color: palette[li % palette.length] });
        li++;
    }

    const legend = document.createElement('div');
    legend.className = 'eval-line-legend';
    for (const it of legendItems) {
        const span = document.createElement('span');
        span.innerHTML = `<span style="background:${it.color}"></span> ${formatTokens(it.len)}`;
        legend.appendChild(span);
    }
    const wrap = document.createElement('div');
    wrap.className = 'eval-line-wrap';
    wrap.appendChild(svg);
    wrap.appendChild(legend);
    return wrap;
}

function addLine(svg, x1, y1, x2, y2, stroke) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    e.setAttribute('x1', String(x1)); e.setAttribute('y1', String(y1));
    e.setAttribute('x2', String(x2)); e.setAttribute('y2', String(y2));
    e.setAttribute('stroke', stroke);
    svg.appendChild(e);
}
function addText(svg, x, y, text, anchor, size) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    e.setAttribute('x', String(x)); e.setAttribute('y', String(y));
    e.setAttribute('text-anchor', anchor);
    e.setAttribute('font-size', String(size));
    e.setAttribute('fill', '#aaa');
    e.textContent = text;
    svg.appendChild(e);
}

function colorForRate(rate) {
    // 0 = red (0deg), 1 = green (120deg)
    const hue = Math.round(rate * 120);
    return `hsl(${hue} 65% 35%)`;
}

function td(tag, text) {
    const e = document.createElement(tag);
    e.textContent = text;
    return e;
}

function formatTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return String(n);
}

/** @returns {Blob}  Downloadable JSON of full grid result. */
export function exportJson(cells, meta) {
    const body = { meta, cells };
    return new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
}

/** Markdown report stub for `docs/EVAL-attention-scaling.md`. */
export function exportMarkdown(cells, meta) {
    const byModel = aggregate(cells);
    const lines = [];
    lines.push('# Context-Attention Scaling Eval — Report');
    lines.push('');
    lines.push(`Generated: ${new Date(meta.generatedAt || Date.now()).toISOString()}`);
    lines.push(`Total spend: ${formatUsd(meta.totalCost || 0)}  ·  cells: ${cells.length}`);
    lines.push('');
    lines.push('## Configuration');
    lines.push('```json');
    lines.push(JSON.stringify(meta.config, null, 2));
    lines.push('```');
    lines.push('');

    for (const [model, byLen] of byModel.entries()) {
        lines.push(`## ${model}`);
        lines.push('');
        const depthSet = new Set();
        for (const l of byLen.values()) for (const d of l.keys()) depthSet.add(d);
        const depths = Array.from(depthSet).sort((a, b) => a - b);
        const lengths = Array.from(byLen.keys()).sort((a, b) => a - b);

        lines.push('| length \\ depth | ' + depths.map(d => `${(d * 100).toFixed(0)}%`).join(' | ') + ' |');
        lines.push('|' + '---|'.repeat(depths.length + 1));
        for (const len of lengths) {
            const dm = byLen.get(len);
            const row = [`${formatTokens(len)}`];
            for (const d of depths) {
                const a = dm.get(d);
                if (!a || a.n === 0) row.push('—');
                else {
                    const rate = a.hits / a.n;
                    row.push(`${(rate * 100).toFixed(0)}% (${a.hits}/${a.n})`);
                }
            }
            lines.push('| ' + row.join(' | ') + ' |');
        }
        lines.push('');
    }

    lines.push('## Limits');
    lines.push('');
    lines.push('1. **Architecture vs training-data confound.** Results reflect both attention mechanics and training distribution; do not generalize to "transformer attention shape is X."');
    lines.push('2. **Hit/miss is binary** — measures retrieval success, not attention magnitude.');
    lines.push('3. **Token-count drift.** Estimated lengths use chars/3.5; reported `usage.prompt_tokens` is authoritative. See raw JSON.');
    lines.push('4. **Single-shot, no prompt-cache reuse.** Per-call cost is higher than production traffic that hits caches.');
    lines.push('5. **Provider truncation.** Cells where reported tokens deviated > 5% from estimate are flagged in the JSON; treat as warnings.');
    lines.push('6. **Tool-call needle out of scope.** This run probed text retrieval only.');
    lines.push('');
    lines.push('## Conclusion');
    lines.push('');
    lines.push('_(write your conclusion here — does the U-shape hold across context tiers? Should head-priority memory injection be kept, dropped, or re-tuned for which models?)_');
    return lines.join('\n');
}
