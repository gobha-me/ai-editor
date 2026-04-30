# NIAH Context-Attention Eval

Empirical test of the project's load-bearing assumption that *modern transformer attention is strongest at the start and end of the window* (DESIGN-retrieval.md, DESIGN-memory.md, DESIGN-intelligence.md). Plants a passcode in a long *Pride and Prejudice* haystack at varying depths, asks the model to recite it, scores hit/miss across small/medium/large context tiers.

## How to run

1. **Configure the main app once.** Open the editor, go to Settings → LLM, set provider to Venice.ai and paste your API key. The eval reads the same `localStorage.settings` — no separate key handling here.
2. **Open `evals/index.html`** in a browser served from the same origin as the app (e.g. via the dev server). File-protocol won't work because of CORS on the corpus fetch.
3. **Click "Load settings + model list"** — fetches the live provider catalog and populates per-tier dropdowns with tool-capable models that fit each tier's context-window range. Defaults to the cheapest input-token price in each tier; pick a different one if you want to compare architectures.
4. **Pick tiers** — defaults to small (short-context) only. Run small first to validate the harness (~$0.08, ~15s), then expand.
5. **Click "Estimate"** — pre-flight cost + wall-clock breakdown. Won't enable "Run" if estimate exceeds the cap.
6. **Click "Run grid"** — pacing + RPM/TPM gauges live during the run. By default, tiers run **concurrently** (each tier targets a distinct model with an independent rate-limit bucket); untick "parallel tiers" to force sequential execution.
7. **Download JSON or Markdown** when done.

## Files

- `index.html` — driver page (mounts the runner, gauges, heatmap). Tier dropdowns populate from the live provider catalog at runtime — no hardcoded model IDs, so deprecations / additions don't require a code change.
- `haystack.js` — corpus loader + needle planter
- `scoring.js` — case-insensitive substring match
- `pacing.js` — header-driven RPM/TPM pacer with **per-model bucketing** (`RateLimiterPool`). Venice publishes different caps per model (e.g. `qwen3-5-9b` = 3M TPM vs `deepseek-v3.2` = 10M TPM vs `deepseek-v4-flash` = 1000 RPM, no TPM cap).
- `cost-preflight.js` — pre-flight estimator. ETA = `max(per-tier)` in parallel mode (default), `sum(per-tier)` in sequential mode.
- `run-niah.js` — grid orchestrator. Tiers run **concurrently** by default; cells **within** a tier remain sequential because they share a model and therefore a limiter. Bypasses `LLM.chat()` to capture rate-limit response headers.
- `render-heatmap.js` — DOM heatmap + SVG line chart + JSON/Markdown export
- `fixtures/pap.txt` — pre-stripped Project Gutenberg *Pride and Prejudice* (~728K chars / ~208K est. tokens)
- `test-haystack.mjs` — synthetic unit test (Node), no API calls, free. 14 cases across haystack, scoring, pre-flight (parallel + sequential ETA), and pacer (incl. per-model `RateLimiterPool` isolation).

## Limits

See the auto-generated report for the full list. Key caveats:

- Hit/miss is binary — no attention magnitude.
- Token-count drift: we estimate via `chars/3.5`; reported `usage.prompt_tokens` is authoritative.
- Tool-call needle is out of scope for this run.
- Results don't isolate model architecture from training-data effects.

## Key handling

The Venice API key never appears in this directory's code. The eval reads it from `State.settings.llmApiKey` at runtime, which is populated by the main app's normal Settings UI. Don't paste the key anywhere under `evals/`.

## Production follow-up

Adding rate-limit-header awareness to `js/providers/venice.js` (so normal app traffic respects the same RPM/TPM caps the eval pacer respects) would be its own milestone — out of scope for this eval.
