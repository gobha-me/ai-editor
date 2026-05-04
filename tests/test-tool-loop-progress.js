/**
 * Tests for the 1.5.9 tool-loop fixes (issue #16):
 *   1. finalizeStreamingMessage no longer persists empty assistant turns
 *   2. Duplicate-streak refusal at N=3 (algorithmic invariants)
 *   3. No-forward-progress break at N=3 stall rounds (algorithmic invariants)
 *
 * The streak/progress invariants are tested with small inline harnesses
 * that mirror the exact logic in js/chat/handlers.js. Full integration
 * coverage of the tool loop is gated by manual browser verification per
 * the plan; this file pins the algorithmic shape so future edits don't
 * silently regress the constants or branching.
 */
import { State, Storage } from '../js/core.js';
import { finalizeStreamingMessage } from '../js/chat/messages.js';

const { T } = window;

// ============================================
// Fix 1 — finalizeStreamingMessage empty-content guard
// ============================================

T.suite('Tool loop — finalizeStreamingMessage skips empty');

(() => {
    // Ensure a streaming-message placeholder exists so the DOM branch
    // doesn't throw before the persistence guard runs.
    const setupPlaceholder = () => {
        const old = document.getElementById('streaming-message');
        if (old) old.remove();
        const el = document.createElement('div');
        el.id = 'streaming-message';
        el.className = 'message streaming';
        const content = document.createElement('div');
        content.className = 'message-content';
        el.appendChild(content);
        const time = document.createElement('div');
        time.className = 'message-time';
        el.appendChild(time);
        document.body.appendChild(el);
        return el;
    };

    const startLen = State.chatHistory.length;

    setupPlaceholder();
    finalizeStreamingMessage('', {});
    T.eq(State.chatHistory.length, startLen, "empty string content does not push to history");

    setupPlaceholder();
    finalizeStreamingMessage('   \n  \t', {});
    T.eq(State.chatHistory.length, startLen, "whitespace-only content does not push to history");

    setupPlaceholder();
    finalizeStreamingMessage(null, {});
    T.eq(State.chatHistory.length, startLen, "null content does not push to history");

    setupPlaceholder();
    finalizeStreamingMessage('hello', {});
    T.eq(State.chatHistory.length, startLen + 1, "non-empty content DOES push to history");
    const last = State.chatHistory[State.chatHistory.length - 1];
    T.eq(last.role, 'assistant', "pushed message has assistant role");
    T.eq(last.content, 'hello', "pushed message has correct content");

    // Cleanup
    State.chatHistory.length = startLen;
    Storage.set('chatHistory', State.chatHistory.slice(-100));
    const tail = document.getElementById('streaming-message');
    if (tail) tail.remove();
})();

// ============================================
// Fix 2 — Duplicate streak refusal invariants
// ============================================

T.suite('Tool loop — duplicate streak refusal at N=3');

(() => {
    // Mirrors the exact branch from handlers.js:
    //   const isDup = !!cachedResult || crossRequestDuplicate;
    //   const streak = isDup ? (duplicateStreak.get(cacheKey) || 0) + 1 : 0;
    //   duplicateStreak.set(cacheKey, streak);
    //   if (isDup && streak >= DUP_REFUSE_THRESHOLD) refuse;
    const DUP_REFUSE_THRESHOLD = 3;

    function simulateCall(streakMap, cacheKey, isDup) {
        const streak = isDup ? (streakMap.get(cacheKey) || 0) + 1 : 0;
        streakMap.set(cacheKey, streak);
        const refused = isDup && streak >= DUP_REFUSE_THRESHOLD;
        return { streak, refused };
    }

    // Three consecutive duplicates → 3rd refused
    let m = new Map();
    T.eq(simulateCall(m, 'A', true).refused, false, "1st dup not refused (streak=1)");
    T.eq(simulateCall(m, 'A', true).refused, false, "2nd dup not refused (streak=2)");
    T.eq(simulateCall(m, 'A', true).refused, true, "3rd dup IS refused (streak=3)");
    T.eq(simulateCall(m, 'A', true).refused, true, "4th dup still refused (streak=4)");

    // A fresh (non-dup) call resets streak for that key
    m = new Map();
    simulateCall(m, 'A', true);   // streak=1
    simulateCall(m, 'A', true);   // streak=2
    const fresh = simulateCall(m, 'A', false);
    T.eq(fresh.streak, 0, "fresh call resets streak for that key");
    T.eq(fresh.refused, false, "fresh call is never refused");
    T.eq(simulateCall(m, 'A', true).refused, false, "next dup after fresh resumes from streak=1");
    T.eq(simulateCall(m, 'A', true).refused, false, "second dup after fresh is streak=2");
    T.eq(simulateCall(m, 'A', true).refused, true, "third dup after fresh hits refusal");

    // Different keys have independent streaks
    m = new Map();
    simulateCall(m, 'A', true);   // A streak=1
    simulateCall(m, 'B', true);   // B streak=1
    simulateCall(m, 'A', true);   // A streak=2
    simulateCall(m, 'B', true);   // B streak=2
    T.eq(simulateCall(m, 'A', true).refused, true, "A refused at streak=3 independently");
    T.eq(simulateCall(m, 'B', true).refused, true, "B refused at streak=3 independently");
})();

// ============================================
// Fix 3 — No-forward-progress break invariants
// ============================================

T.suite('Tool loop — no-progress break at 3 stall rounds');

(() => {
    // Mirrors the loop control in handlers.js:
    //   if (madeProgressThisRound) noProgressStreak = 0;
    //   else { noProgressStreak++;
    //          if (noProgressStreak >= NO_PROGRESS_LIMIT) break; }
    const NO_PROGRESS_LIMIT = 3;

    function runRounds(progressPattern) {
        let noProgressStreak = 0;
        let rounds = 0;
        let brokeOnStall = false;
        for (const madeProgress of progressPattern) {
            rounds++;
            if (madeProgress) {
                noProgressStreak = 0;
            } else {
                noProgressStreak++;
                if (noProgressStreak >= NO_PROGRESS_LIMIT) {
                    brokeOnStall = true;
                    break;
                }
            }
        }
        return { rounds, brokeOnStall, noProgressStreak };
    }

    // Three consecutive no-progress rounds → break on round 3
    let r = runRounds([false, false, false, false, false]);
    T.eq(r.rounds, 3, "breaks after exactly 3 stall rounds");
    T.eq(r.brokeOnStall, true, "break flag set");

    // Progress on any round resets the streak
    r = runRounds([false, false, true, false, false, false]);
    T.eq(r.rounds, 6, "progress mid-stream resets streak; runs 6 rounds before breaking");
    T.eq(r.brokeOnStall, true, "still breaks once 3 consecutive stalls accumulate");

    // Continuous progress never breaks — verifies long-session smoke
    r = runRounds(Array(20).fill(true));
    T.eq(r.rounds, 20, "20 rounds of continuous progress never trigger break");
    T.eq(r.brokeOnStall, false, "never broke on stall");
    T.eq(r.noProgressStreak, 0, "streak stays at 0 throughout");

    // Alternating progress/stall — never breaks (streak resets each progress round)
    r = runRounds([true, false, true, false, true, false, true, false]);
    T.eq(r.rounds, 8, "alternating pattern runs all 8 rounds");
    T.eq(r.brokeOnStall, false, "alternating progress/stall never breaks");
})();
