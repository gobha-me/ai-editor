# UI Event Dispatch Contract

**Status:** Implemented.

Application actions use event listeners and delegated `data-action` dispatch.
Inline HTML event attributes are forbidden by the Node source-policy tests.

## Invariants

- Static application actions register during startup through narrow UI modules.
- Repeated/dynamic surfaces delegate from the nearest stable container and match
  an explicit action name.
- Dispatchers verify the event target belongs to their container before reading
  data attributes or invoking an action.
- Action arguments come from validated element data or current application
  state, never evaluated JavaScript strings.
- Mount/unmount paths do not accumulate duplicate listeners.
- Global `window.*` exposure is not an event-dispatch API. Compatibility globals
  may remain only where an external browser boundary requires them and must be
  individually documented.

Regression tests cover the application shell, chat, file tree, issue and PR
surfaces, dialogs, and the repository-wide absence of inline handlers.
