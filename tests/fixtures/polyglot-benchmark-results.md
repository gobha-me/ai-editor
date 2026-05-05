# Polyglot Retrieval Benchmark — Results

Run: 2026-05-05T21:22:56.768Z

Scorer: BM25 only (no embedder). Chunker: production regex.

## Index stats

| Repo | Files | Chunks | Skipped (>500K) | Read errors | Elapsed |
|---|---:|---:|---:|---:|---:|
| armature | 746 | 1752 | 1 | 0 | 297 ms |
| plinth | 404 | 776 | 0 | 0 | 129 ms |

## Aggregate

- **Overall**: 20 fixtures · meanHit@5 = 0.800 · meanRecall@5 = 0.575
- **armature**: 10 fixtures · meanHit@5 = 1.000 · meanRecall@5 = 0.883
- **plinth**: 10 fixtures · meanHit@5 = 0.600 · meanRecall@5 = 0.267

## By category

| Repo / Category | N | meanHit@5 | meanRecall@5 |
|---|---:|---:|---:|
| armature/topic | 4 | 1.000 | 0.833 |
| armature/file-discovery | 2 | 1.000 | 1.000 |
| armature/function-discovery | 1 | 1.000 | 1.000 |
| armature/task-related | 2 | 1.000 | 0.750 |
| armature/onboarding | 1 | 1.000 | 1.000 |
| plinth/topic | 6 | 0.500 | 0.167 |
| plinth/task-related | 3 | 0.667 | 0.333 |
| plinth/function-discovery | 1 | 1.000 | 0.667 |

## Per-fixture detail

| ID | Cat | Hit | R@5 | Top score | Returned (top 5) | Expected |
|---|---|:-:|---:|---:|---|---|
| `armature-oauth-session-lifecycle` | topic | ✅ | 0.33 | 25.99 | `server/handlers/auth.go`<br>`packages/intelligence-runner/js/strategy-router.js`<br>`packages/llm-core-runner/js/citation-prompt.js`<br>`server/auth/multi.go`<br>`src/js/sw/surfaces/login/sso-panel.js` | `server/auth/github.go`<br>`server/handlers/auth.go`<br>`server/middleware/auth.go` |
| `armature-user-session-cache` | file-discovery | ✅ | 1.00 | 23.81 | `server/middleware/auth.go`<br>`server/store/sqlite/sidecar.go`<br>`server/sandbox/db_module.go`<br>`server/handlers/workflow_assignment_handlers.go`<br>`server/database/schema_freeze.go` | `server/middleware/auth.go` |
| `armature-websocket-auth-ticket` | function-discovery | ✅ | 1.00 | 43.98 | `server/middleware/auth.go`<br>`packages/icd-test-runner/js/tier-security.js`<br>`server/auth/oidc.go`<br>`server/handlers/auth.go`<br>`packages/kb-runner/js/citations.js` | `server/middleware/auth.go` |
| `armature-vault-initialization` | topic | ✅ | 1.00 | 34.15 | `server/handlers/auth.go`<br>`server/handlers/admin.go`<br>`packages/icd-test-runner/js/crud/admin.js`<br>`server/crypto/cache.go`<br>`server/handlers/settings.go` | `server/handlers/auth.go` |
| `armature-bootstrap-admin-vault` | task-related | ✅ | 1.00 | 34.54 | `server/handlers/auth.go`<br>`server/handlers/admin.go`<br>`server/notifications/email.go`<br>`packages/icd-test-runner/js/crud/admin.js`<br>`src/js/sw/surfaces/admin/users.js` | `server/handlers/auth.go` |
| `armature-starlark-package-manifest` | task-related | ✅ | 0.50 | 29.14 | `server/sandbox/packages_module.go`<br>`server/handlers/packages.go`<br>`server/handlers/ext_api.go`<br>`server/handlers/ext_file_upload.go`<br>`server/handlers/user_packages.go` | `server/handlers/package_validate.go`<br>`server/sandbox/packages_module.go` |
| `armature-package-manifest-validation` | topic | ✅ | 1.00 | 32.47 | `server/handlers/package_validate.go`<br>`server/forms/forms.go`<br>`server/sandbox/packages_module.go`<br>`server/handlers/connections.go`<br>`server/sandbox/files_module.go` | `server/handlers/package_validate.go` |
| `armature-notification-delivery` | topic | ✅ | 1.00 | 35.90 | `server/notifications/service.go`<br>`server/notifications/service_test.go`<br>`server/models/models_notification_pref.go`<br>`server/notifications/sources.go`<br>`server/sandbox/modules.go` | `server/notifications/service.go` |
| `armature-cluster-registry` | file-discovery | ✅ | 1.00 | 19.84 | `server/handlers/auth.go`<br>`server/main.go`<br>`server/cluster/registry.go`<br>`server/handlers/package_registry.go`<br>`packages/intelligence-runner/js/digest-by-theme.js` | `server/cluster/registry.go` |
| `armature-logging-configuration` | onboarding | ✅ | 1.00 | 32.38 | `server/logging/logger.go`<br>`server/middleware/logging.go`<br>`server/backup/meta.go`<br>`server/sandbox/ext_module.go`<br>`sidecars/test-sidecar/sidecar.py` | `server/logging/logger.go` |
| `plinth-session-auth-routes` | topic | ✅ | 0.33 | 16.88 | `src/kernel/auth/handlers.cpp`<br>`data/extensions/shell/0.6.3/client/shell.js`<br>`client/shell/client/shell.js`<br>`src/kernel/frontend/api_frontend.hpp`<br>`tests/kernel/auth/auth_integration_test.cpp` | `src/kernel/auth/handlers.cpp`<br>`src/kernel/auth/handlers.hpp`<br>`src/kernel/auth/middleware.hpp` |
| `plinth-capability-registry-api` | task-related | ❌ | 0.00 | 13.65 | `src/kernel/packages/install_lifecycle.cpp`<br>`tests/kernel/capabilities/dispatch_extension_test.cpp`<br>`tests/kernel/packages/lifecycle_transitions_test.cpp`<br>`tests/kernel/capabilities/registration_integration_test.cpp`<br>`src/kernel/capabilities/bootstrap.cpp` | `src/kernel/capabilities/registration.cpp`<br>`src/kernel/capabilities/registration.hpp`<br>`src/kernel/capabilities/types.hpp` |
| `plinth-capability-tier-resolution` | function-discovery | ✅ | 0.67 | 23.45 | `tests/kernel/capabilities/batch_test.cpp`<br>`src/kernel/capabilities/resolution.cpp`<br>`benchmarks/extension_dispatch_stub.cpp`<br>`src/kernel/capabilities/resolution.hpp`<br>`tests/kernel/js/async_bridge_test.cpp` | `src/kernel/capabilities/resolution.cpp`<br>`src/kernel/capabilities/resolution.hpp`<br>`src/kernel/extensions/runtime_registry.hpp` |
| `plinth-rbac-enforcement-filter` | topic | ❌ | 0.00 | 14.99 | `tests/kernel/packages/asset_server_test.cpp`<br>`src/kernel/packages/migrations.hpp`<br>`src/kernel/capabilities/resolution.hpp`<br>`src/kernel/cap/api_cap.cpp`<br>`tests/kernel/packages/http_test_fixture.hpp` | `src/kernel/rbac/enforcement.cpp`<br>`src/kernel/rbac/enforcement.hpp`<br>`src/kernel/rbac/rule_registrar.hpp` |
| `plinth-group-bootstrap-rbac-setup` | task-related | ✅ | 0.67 | 25.08 | `src/kernel/groups/handlers.hpp`<br>`src/kernel/auth/handlers.cpp`<br>`tests/kernel/rbac/enforcement_test.cpp`<br>`tests/kernel/groups/rbac_integration_test.cpp`<br>`src/kernel/groups/handlers.cpp` | `src/kernel/groups/handlers.cpp`<br>`src/kernel/groups/handlers.hpp`<br>`src/kernel/rbac/rule_registrar.hpp` |
| `plinth-realtime-pubsub-broker` | topic | ❌ | 0.00 | 22.62 | `src/kernel/ws/publish.hpp`<br>`data/extensions/shell/0.6.3/client/sdk.js`<br>`client/shell/client/sdk.js`<br>`tests/kernel/capabilities/batch_test.cpp`<br>`docs/sketches/claude-design-handoff-2026-04-27/project/shell/app.jsx` | `src/kernel/realtime/broker.cpp`<br>`src/kernel/realtime/broker.hpp`<br>`src/kernel/realtime/listener.hpp` |
| `plinth-websocket-call-dispatch` | topic | ✅ | 0.33 | 20.86 | `src/kernel/ws/call_dispatch.hpp`<br>`load-harness/internal/wssub/subscriber.go`<br>`load-harness/internal/wsclient/client.go`<br>`data/extensions/shell/0.6.3/client/sdk.js`<br>`client/shell/client/sdk.js` | `src/kernel/ws/call_dispatch.cpp`<br>`src/kernel/ws/call_dispatch.hpp`<br>`src/kernel/ws/connection_registry.hpp` |
| `plinth-package-install-state-machine` | topic | ✅ | 0.33 | 16.07 | `src/kernel/packages/rbac_test_runner.hpp`<br>`src/kernel/packages/install_lifecycle.cpp`<br>`src/kernel/packages/validator.hpp`<br>`src/kernel/realtime/replay.cpp`<br>`tests/kernel/ws/ws_test_fixture.hpp` | `src/kernel/packages/install_lifecycle.cpp`<br>`src/kernel/packages/install_lifecycle.hpp`<br>`src/kernel/packages/manifest.hpp` |
| `plinth-schema-migrations-runner` | task-related | ✅ | 0.33 | 19.11 | `src/kernel/config.cpp`<br>`src/kernel/packages/migrations.cpp`<br>`tests/kernel/capabilities/listener_integration_test.cpp`<br>`tests/kernel/packages/migrations_test.cpp`<br>`tests/kernel/capabilities/registration_integration_test.cpp` | `src/kernel/packages/migration_error.hpp`<br>`src/kernel/packages/migrations.cpp`<br>`src/kernel/packages/migrations.hpp` |
| `plinth-audit-logging-write` | topic | ❌ | 0.00 | 15.93 | `tests/kernel/realtime/envelope_shape_test.cpp`<br>`tests/kernel/realtime/events_writer_test.cpp`<br>`src/kernel/realtime/events_writer.cpp`<br>`tests/kernel/scheduled_tasks/cleanup_events_test.cpp`<br>`tests/kernel/realtime/gap_detection_test.cpp` | `src/kernel/audit/handlers.hpp`<br>`src/kernel/logging.cpp`<br>`src/kernel/logging.hpp` |
