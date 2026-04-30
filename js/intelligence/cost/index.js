// @ts-check
/**
 * Cost intelligence subsystem barrel — 1.2.1.
 *
 * Sibling to `js/intelligence/compression/` (1.2.0). Sequenced per
 * Decision §8 ("Measurement before scale"): Rules 1+2 ship before the
 * dashboard, then the dashboard ships before Rule 3 to verify the
 * projected ≥40% savings before stacking more rules.
 *
 * @module intelligence/cost
 */

export {
    recordTurn,
    getConvCost,
    removeConvCost,
    getDailyMap,
    getDailySeries,
    getMonthSpend,
    getTodaySpend,
    getBudget,
    setBudget,
    localDateKey,
    monthKey,
    daysBetween,
    DAILY_RETENTION_DAYS,
} from './cost-store.js';

export { checkThresholds, pickWorse, WARN_THRESHOLD, OVER_THRESHOLD } from './budget.js';

export { init as initCostRecorder } from './cost-recorder.js';
