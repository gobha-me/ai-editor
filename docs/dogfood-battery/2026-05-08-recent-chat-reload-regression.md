# 2026-05-08 — recent chats fail to reload (chatHistory alias corruption)

**Reported.** Clicking a recently-active chat in the conversation drawer
loads with no messages. Older chats (created before some unknown cutoff)
still open fine. **No console error.** User suspected the recent
"virtual chat pane" change but flagged the suspicion as a temporal
correlation, not a root-cause claim.

**Verdict.** Reproduced. Root cause is not the virtualizer (1.6.5). It
is `ConversationManager.save()` aliasing `State.chatHistory` into the
cached `conv-{id}` payload, which becomes a corruption channel once
`ChatHistoryStore.replace()` (1.11.0) starts mutating
`State.chatHistory` **in place**. Fix lands at 1.21.1.

## Reproduction

The preview at `http://localhost:8765` (server `ai-editor-tests`) had
three persisted conversations on init:

| id | age | msgs (cache) | IDB hit | schema |
|---|---|---|---|---|
| `movhf6u05qin` | 0.5h (active) | 120 | yes (120) | 1.11.0+ (`scratchpad`, `todos`) |
| `__smoke_load_test__` | 19.9h | 1 | no | 1.11.0+ |
| `mou5e43ty58e` | 53h | 10 | **no** | pre-1.11.0 (no `scratchpad`/`todos`) |

The "good" old conversation `mou5e43ty58e` survives because its IDB
entry doesn't exist — `Storage.get` falls back to the localStorage
cache, which has the correct snapshot from synchronous
`JSON.stringify` write-through. The recent `movhf6u05qin` IDB entry
exists, so its corrupted post-load IDB write is what gets hydrated on
the next page load.

Repro steps in the live page (`mcp__Claude_Preview__preview_eval`):

```js
const { State, Storage } = await import('/js/core.js');
const cm = (await import('/js/chat/conversations.js')).ConversationManager;
const { renderMessages } = await import('/js/chat/messages.js');

cm.load('mou5e43ty58e');   // chatLen → 10 (good)
renderMessages();           // 12 DOM children — renders correctly
cm.load('movhf6u05qin');   // chatLen → 0 (BROKEN — was 120 in cache)
renderMessages();           // welcome screen
```

Smoking-gun alias check:

```js
const activeId = Storage.get('activeConversation');
const cached = Storage.get(`conv-${activeId}`);
cached.messages === State.chatHistory   // → true   (alias!)
ChatHistoryStore.append({ role: 'user', content: 'probe' });
cached.messages.length === State.chatHistory.length   // → true (mutation visible)
```

## Trace

1. `ConversationManager.save()` at
   [`js/chat/conversations.js:161-189`](../../js/chat/conversations.js)
   stores `messages: messages` where `messages = State.chatHistory` —
   **a live reference**, not a snapshot.

2. `Storage.set` at [`js/core.js:626-640`](../../js/core.js) writes
   the value to three tiers:
   - **`_cache.set(key, value)`** — stores the reference verbatim. No
     copy. The cache now aliases `State.chatHistory`.
   - **localStorage** — synchronous `JSON.stringify(value)`, captures
     a deep snapshot. **Always correct.**
   - **IDB** — fire-and-forget `_idb.set(key, value).catch(...)`.
     `IDB.set` `await`s `this.open()`, then calls `objectStore.put`,
     which is when the structured clone happens. **The clone runs
     after the next microtask boundary.**

3. When the user switches conversations, `ConversationManager.load(otherId)`
   at [`js/chat/conversations.js:234-278`](../../js/chat/conversations.js):
   - Calls `this.save()` — re-aliases `cache['conv-${activeId}'].messages`
     to `State.chatHistory` (or confirms the existing alias). The async
     IDB write for the old conv is **queued**, not yet executed.
   - Calls `ChatHistoryStore.replace(payload.messages || [])` at line 247.

4. `ChatHistoryStore.replace` at
   [`js/chat/history-store.js:68-74`](../../js/chat/history-store.js)
   mutates `State.chatHistory` **in place** (intentionally, to keep
   the array reference stable for virtualizers and renderers):
   ```js
   State.chatHistory.length = 0;
   if (Array.isArray(arr) && arr.length > 0) {
       State.chatHistory.push(...arr);
   }
   ```
   Because of step 3's alias, this mutation also clears
   `cache['conv-${oldId}'].messages` — same array.

5. The microtask queued in step 3 fires next. `IDB.set` reads
   `value.messages`, structured-clones it, and writes to IDB — but
   `value.messages === State.chatHistory`, which is **now the new
   conversation's messages** (or empty if `payload.messages` was
   undefined). The IDB tier persists corrupted data.

6. The localStorage tier still holds the correct snapshot from step 2.
   But `Storage.init` at [`js/core.js:509-547`](../../js/core.js)
   hydrates `_cache` from IDB on every page load (line 527-530), and
   the migration flag prevents localStorage→IDB re-migration. So the
   stale localStorage snapshot is shadowed by the corrupted IDB entry.

The compounding case (which is how the user noticed): if `payload.messages`
itself happens to be aliased to `State.chatHistory` (because that conv
was once active in this session, and a `save()` aliased its cache),
then `replace(payload.messages)` does:
```js
State.chatHistory.length = 0;       // wipes both — same array
State.chatHistory.push(...arr);     // arr is now empty, push is a no-op
// → State.chatHistory ends up empty.
```

## Hypotheses considered

| Hypothesis | Verdict |
|---|---|
| Virtual pane introduced bypass write or schema change | ❌ Falsified. Virtualizer is 1.6.5, doesn't touch persistence. |
| IDB vs localStorage divergence (payload split across tiers) | ❌ Not divergence — IDB is corrupted, localStorage is correct. Hydration order makes IDB authoritative on read. |
| `QuotaExceededError` swallowed | ❌ No quota errors in console; payload loss happens even with plenty of room. |
| Async write race from unmount | ✅ **Partial match.** The race is real, but it's between `Storage.set`'s sync return and the queued IDB `put`, not unmount. |
| Schema bump on `conv-{id}` payload | ❌ Schema is additive (1.11.0 added `scratchpad`, `todos`). Older payloads without those fields still load. |
| **Alias of `State.chatHistory` into cached payload** | ✅ **Root cause.** Confirmed via `cached.messages === State.chatHistory`. |

## Why "recent" chats specifically

Older conversations (`mou5e43ty58e` here) survive only because their
IDB entry was never written — they predate the bug's effective trigger
in this user's history. `Storage.get` falls back to the
synchronously-snapshotted localStorage entry. Once *any* conv-switch
runs while a conversation is in IDB, that IDB entry gets clobbered on
the next race window.

## Fix

[`js/chat/conversations.js:182`](../../js/chat/conversations.js) —
snapshot `messages` with `.slice()` before storing. Same pattern the
scratchpad already used since 1.11.0 (line 181):

```diff
+ // Snapshot `messages` so the cached payload doesn't alias
+ // `State.chatHistory`. ChatHistoryStore mutates that array in place
+ // (length=0 + push), so without the copy a later `load(otherId)` call
+ // would clear the previously-saved conversation's cached messages —
+ // and the queued async IDB write would persist the corrupted state.
  Storage.set(`conv-${id}`, {
-     messages,
+     messages: messages.slice(),
      summaryInfo,
      pruneStash,
      toolActionLog: toolActionLog.slice(-50),
      todos,
      scratchpad
  });
```

`messages.slice()` is shallow — message objects are shared. That's
fine: the bug is about array-length mutation, not per-message
mutation. Per-message mutation is not a pattern in the codebase
(messages are append-only by `ChatHistoryStore.append`).

## Regression test

[`tests/test-conversation-load-alias.mjs`](../../tests/test-conversation-load-alias.mjs)
— two assertions:

1. After `save()`, `cache['conv-${id}'].messages !== State.chatHistory`
   (snapshot, not alias).
2. The save → load(B) → save → load(A) round-trip preserves A's
   messages. **Pre-fix this fails with `2 !== 3`** because A's three
   messages get clobbered by `replace()` running for B.

Verified: test fails on `git stash` of the fix, passes with the fix
re-applied.

## Why the virtualizer was the wrong suspect

The virtualizer holds `_state.history = State.chatHistory` (a live
reference) intentionally — so `ChatHistoryStore.replace`'s in-place
mutation is *visible* to the next render. But the virtualizer is torn
down + re-mounted by `renderMessages()` on every conv switch
([`js/chat/messages.js:646-705`](../../js/chat/messages.js)), so the
virtualizer's reference doesn't survive into the corrupted state.

The virtualizer correlation in the user's mind was probably timing:
the in-place mutation (1.11.0) was introduced to support the
virtualizer's reference-stability assumption. Both shipped in the
1.6.x → 1.11.0 chat-stability arc. The bug is the unintended pairing,
not either one alone.

## Branch / version

- Branch: `fix/recent-chat-reload` (off `origin/main` after the
  picker merge `b4040ef`).
- Version: `1.21.0` → `1.21.1`. Per `feedback_version_bump.md`:
  this fix touches chat persistence (data integrity) so it bumps.
- CHANGELOG: `[1.21.1]` entry added.
