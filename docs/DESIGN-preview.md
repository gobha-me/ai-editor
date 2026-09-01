# Workspace Preview Contract

**Status:** Implemented and profile-gated.

Preview serves workspace content through the service-worker bridge and exposes
bounded observation and interaction tools. `js/preview/preview-host.js` owns
server state; the preview service worker and shim isolate page execution from the
editor application.

## Invariants

- Each preview has a generated server ID and a normalized workspace root.
- Paths remain within that workspace; traversal, unknown servers, invalid
  selectors, and malformed messages fail closed.
- Starting, stopping, and listing previews are distinct lifecycle operations.
- Console, error, route, network, inspect, and snapshot results are bounded.
- Click, fill, and resize are explicit preview actions and remain subject to
  profile and plan/approval policy.
- Preview-origin messages are correlated to pending requests and accepted only
  from the expected channel and server.
- Stopping a preview releases pending state. A failed preview cannot grant or
  retain tool authority.

The preview does not deploy code and does not make repository writes by itself.
Coverage is split across preview host, service-worker bridge, tool, and
profile-resolution tests.
