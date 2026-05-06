# Polyglot Retrieval Benchmark — Results

Run: 2026-05-06T22:55:29.529Z

Scorer: BM25 only (no embedder). Chunker: production regex / AST (1.7.0+).

## Index stats

| Repo | Files | Chunks | Skipped (>500K) | Read errors | Elapsed |
|---|---:|---:|---:|---:|---:|
| armature | 746 | 1752 | 1 | 0 | 298 ms |
| plinth | 404 | 4400 | 0 | 0 | 250 ms |

## Configurations compared

| Config | Weights |
|---|---|
| **baseline** | _(none — baseline)_ |
| **tests-prefix-0.5** | `{"prefixes":{"tests/":0.5,"test/":0.5,"integration_tests/":0.5}}` |
| **tests-prefix-0.3** | `{"prefixes":{"tests/":0.3,"test/":0.3,"integration_tests/":0.3}}` |

## Aggregate (side-by-side)

| Scope | baseline meanHit@5 / meanRecall@5 | tests-prefix-0.5 meanHit@5 / meanRecall@5 | tests-prefix-0.3 meanHit@5 / meanRecall@5 |
|---|---|---|---|
| **Overall** | 0.900 / 0.592 | 0.900 / 0.642 | 0.900 / 0.642 |
| **armature** | 1.000 / 0.883 | 1.000 / 0.883 | 1.000 / 0.883 |
| **plinth** | 0.800 / 0.300 | 0.800 / 0.400 | 0.800 / 0.400 |

## baseline — by category

| Repo / Category | N | meanHit@5 | meanRecall@5 |
|---|---:|---:|---:|
| armature/topic | 4 | 1.000 | 0.833 |
| armature/file-discovery | 2 | 1.000 | 1.000 |
| armature/function-discovery | 1 | 1.000 | 1.000 |
| armature/task-related | 2 | 1.000 | 0.750 |
| armature/onboarding | 1 | 1.000 | 1.000 |
| plinth/topic | 6 | 0.833 | 0.278 |
| plinth/task-related | 3 | 0.667 | 0.222 |
| plinth/function-discovery | 1 | 1.000 | 0.667 |

### baseline — per-fixture detail

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
| `plinth-session-auth-routes` | topic | ✅ | 0.33 | 18.60 | `tests/kernel/auth/auth_integration_test.cpp`<br>`data/extensions/shell/0.6.3/client/shell.js`<br>`client/shell/client/shell.js`<br>`src/kernel/auth/handlers.cpp`<br>`src/kernel/frontend/api_frontend.hpp` | `src/kernel/auth/handlers.cpp`<br>`src/kernel/auth/handlers.hpp`<br>`src/kernel/auth/middleware.hpp` |
| `plinth-capability-registry-api` | task-related | ❌ | 0.00 | 13.40 | `src/kernel/packages/install_lifecycle.cpp`<br>`tests/kernel/capabilities/bootstrap_integration_test.cpp`<br>`tests/kernel/packages/lifecycle_transitions_test.cpp`<br>`tests/kernel/capabilities/registration_integration_test.cpp`<br>`tests/kernel/rbac/anonymous_identity_test.cpp` | `src/kernel/capabilities/registration.cpp`<br>`src/kernel/capabilities/registration.hpp`<br>`src/kernel/capabilities/types.hpp` |
| `plinth-capability-tier-resolution` | function-discovery | ✅ | 0.67 | 25.92 | `src/kernel/rbac/rule_validator.cpp`<br>`src/kernel/capabilities/resolution.hpp`<br>`tests/kernel/capabilities/resolution_test.cpp`<br>`src/kernel/capabilities/resolution.cpp`<br>`tests/kernel/capabilities/batch_test.cpp` | `src/kernel/capabilities/resolution.cpp`<br>`src/kernel/capabilities/resolution.hpp`<br>`src/kernel/extensions/runtime_registry.hpp` |
| `plinth-rbac-enforcement-filter` | topic | ❌ | 0.00 | 13.12 | `tests/kernel/packages/lifecycle_transitions_http_test.cpp`<br>`tests/kernel/packages/asset_server_test.cpp`<br>`src/kernel/auth/middleware.hpp`<br>`tests/kernel/packages/migrations_test.cpp`<br>`src/kernel/packages/cross_file_validator.cpp` | `src/kernel/rbac/enforcement.cpp`<br>`src/kernel/rbac/enforcement.hpp`<br>`src/kernel/rbac/rule_registrar.hpp` |
| `plinth-group-bootstrap-rbac-setup` | task-related | ✅ | 0.33 | 30.62 | `tests/kernel/ws/ws_test_fixture.cpp`<br>`src/kernel/groups/handlers.hpp`<br>`src/kernel/auth/handlers.cpp`<br>`tests/kernel/groups/rbac_integration_test.cpp`<br>`src/kernel/rbac/rbac_manifest.hpp` | `src/kernel/groups/handlers.cpp`<br>`src/kernel/groups/handlers.hpp`<br>`src/kernel/rbac/rule_registrar.hpp` |
| `plinth-realtime-pubsub-broker` | topic | ✅ | 0.33 | 19.32 | `src/kernel/realtime/broker.cpp`<br>`tests/kernel/capabilities/batch_test.cpp`<br>`data/extensions/shell/0.6.3/client/sdk.js`<br>`client/shell/client/sdk.js`<br>`src/kernel/ws/close_codes.hpp` | `src/kernel/realtime/broker.cpp`<br>`src/kernel/realtime/broker.hpp`<br>`src/kernel/realtime/listener.hpp` |
| `plinth-websocket-call-dispatch` | topic | ✅ | 0.33 | 20.83 | `src/kernel/ws/call_dispatch.hpp`<br>`data/extensions/shell/0.6.3/client/sdk.js`<br>`client/shell/client/sdk.js`<br>`tests/integration/events_replay_integration_test.cpp`<br>`src/kernel/packages/rbac_test_runner.hpp` | `src/kernel/ws/call_dispatch.cpp`<br>`src/kernel/ws/call_dispatch.hpp`<br>`src/kernel/ws/connection_registry.hpp` |
| `plinth-package-install-state-machine` | topic | ✅ | 0.33 | 16.64 | `src/kernel/packages/rbac_test_runner.hpp`<br>`src/kernel/packages/install_lifecycle.hpp`<br>`src/kernel/realtime/broker.cpp`<br>`src/kernel/shell/firstboot.hpp`<br>`src/kernel/js/conversion.cpp` | `src/kernel/packages/install_lifecycle.cpp`<br>`src/kernel/packages/install_lifecycle.hpp`<br>`src/kernel/packages/manifest.hpp` |
| `plinth-schema-migrations-runner` | task-related | ✅ | 0.33 | 18.95 | `src/kernel/config.cpp`<br>`src/kernel/packages/migrations.hpp`<br>`tests/kernel/scheduled_tasks/cleanup_events_test.cpp`<br>`tests/kernel/realtime/cursor_store_test.cpp`<br>`tests/kernel/realtime/envelope_shape_test.cpp` | `src/kernel/packages/migration_error.hpp`<br>`src/kernel/packages/migrations.cpp`<br>`src/kernel/packages/migrations.hpp` |
| `plinth-audit-logging-write` | topic | ✅ | 0.33 | 18.04 | `src/kernel/capabilities/bootstrap.cpp`<br>`tests/kernel/scheduled_tasks/cleanup_events_test.cpp`<br>`src/kernel/logging.hpp`<br>`src/kernel/realtime/broker.hpp`<br>`src/kernel/js/stdlib/pubsub_bindings.cpp` | `src/kernel/audit/handlers.hpp`<br>`src/kernel/logging.cpp`<br>`src/kernel/logging.hpp` |

## tests-prefix-0.5 — by category

| Repo / Category | N | meanHit@5 | meanRecall@5 |
|---|---:|---:|---:|
| armature/topic | 4 | 1.000 | 0.833 |
| armature/file-discovery | 2 | 1.000 | 1.000 |
| armature/function-discovery | 1 | 1.000 | 1.000 |
| armature/task-related | 2 | 1.000 | 0.750 |
| armature/onboarding | 1 | 1.000 | 1.000 |
| plinth/topic | 6 | 0.833 | 0.333 |
| plinth/task-related | 3 | 0.667 | 0.444 |
| plinth/function-discovery | 1 | 1.000 | 0.667 |

### tests-prefix-0.5 — per-fixture detail

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
| `plinth-session-auth-routes` | topic | ✅ | 0.33 | 17.71 | `data/extensions/shell/0.6.3/client/shell.js`<br>`client/shell/client/shell.js`<br>`src/kernel/auth/handlers.cpp`<br>`src/kernel/frontend/api_frontend.hpp`<br>`src/kernel/rbac/enforcement.cpp` | `src/kernel/auth/handlers.cpp`<br>`src/kernel/auth/handlers.hpp`<br>`src/kernel/auth/middleware.hpp` |
| `plinth-capability-registry-api` | task-related | ❌ | 0.00 | 13.40 | `src/kernel/packages/install_lifecycle.cpp`<br>`src/kernel/capabilities/listener.hpp`<br>`src/kernel/capabilities/bootstrap.cpp`<br>`src/kernel/capabilities/resolution.cpp`<br>`src/kernel/realtime/cursor_store.hpp` | `src/kernel/capabilities/registration.cpp`<br>`src/kernel/capabilities/registration.hpp`<br>`src/kernel/capabilities/types.hpp` |
| `plinth-capability-tier-resolution` | function-discovery | ✅ | 0.67 | 25.92 | `src/kernel/rbac/rule_validator.cpp`<br>`src/kernel/capabilities/resolution.hpp`<br>`src/kernel/capabilities/resolution.cpp`<br>`src/kernel/js/stdlib/cap_bindings.cpp`<br>`benchmarks/tier1_benchmark.cpp` | `src/kernel/capabilities/resolution.cpp`<br>`src/kernel/capabilities/resolution.hpp`<br>`src/kernel/extensions/runtime_registry.hpp` |
| `plinth-rbac-enforcement-filter` | topic | ❌ | 0.00 | 11.51 | `src/kernel/auth/middleware.hpp`<br>`src/kernel/packages/cross_file_validator.cpp`<br>`src/kernel/capabilities/resolution.hpp`<br>`src/kernel/cap/api_cap.cpp`<br>`src/kernel/js/eval.hpp` | `src/kernel/rbac/enforcement.cpp`<br>`src/kernel/rbac/enforcement.hpp`<br>`src/kernel/rbac/rule_registrar.hpp` |
| `plinth-group-bootstrap-rbac-setup` | task-related | ✅ | 0.67 | 27.96 | `src/kernel/groups/handlers.hpp`<br>`src/kernel/auth/handlers.cpp`<br>`src/kernel/rbac/rbac_manifest.hpp`<br>`src/kernel/groups/handlers.cpp`<br>`src/kernel/capabilities/bootstrap.hpp` | `src/kernel/groups/handlers.cpp`<br>`src/kernel/groups/handlers.hpp`<br>`src/kernel/rbac/rule_registrar.hpp` |
| `plinth-realtime-pubsub-broker` | topic | ✅ | 0.67 | 19.32 | `src/kernel/realtime/broker.cpp`<br>`data/extensions/shell/0.6.3/client/sdk.js`<br>`client/shell/client/sdk.js`<br>`src/kernel/ws/close_codes.hpp`<br>`src/kernel/realtime/broker.hpp` | `src/kernel/realtime/broker.cpp`<br>`src/kernel/realtime/broker.hpp`<br>`src/kernel/realtime/listener.hpp` |
| `plinth-websocket-call-dispatch` | topic | ✅ | 0.33 | 20.83 | `src/kernel/ws/call_dispatch.hpp`<br>`data/extensions/shell/0.6.3/client/sdk.js`<br>`client/shell/client/sdk.js`<br>`src/kernel/packages/rbac_test_runner.hpp`<br>`src/kernel/js/eval.hpp` | `src/kernel/ws/call_dispatch.cpp`<br>`src/kernel/ws/call_dispatch.hpp`<br>`src/kernel/ws/connection_registry.hpp` |
| `plinth-package-install-state-machine` | topic | ✅ | 0.33 | 16.64 | `src/kernel/packages/rbac_test_runner.hpp`<br>`src/kernel/packages/install_lifecycle.hpp`<br>`src/kernel/realtime/broker.cpp`<br>`src/kernel/shell/firstboot.hpp`<br>`src/kernel/js/conversion.cpp` | `src/kernel/packages/install_lifecycle.cpp`<br>`src/kernel/packages/install_lifecycle.hpp`<br>`src/kernel/packages/manifest.hpp` |
| `plinth-schema-migrations-runner` | task-related | ✅ | 0.67 | 18.95 | `src/kernel/config.cpp`<br>`src/kernel/packages/migrations.hpp`<br>`src/kernel/packages/migrations.cpp`<br>`src/kernel/db/bootstrap.cpp`<br>`src/kernel/packages/migrations_internal.hpp` | `src/kernel/packages/migration_error.hpp`<br>`src/kernel/packages/migrations.cpp`<br>`src/kernel/packages/migrations.hpp` |
| `plinth-audit-logging-write` | topic | ✅ | 0.33 | 18.04 | `src/kernel/capabilities/bootstrap.cpp`<br>`src/kernel/logging.hpp`<br>`src/kernel/realtime/broker.hpp`<br>`src/kernel/js/stdlib/pubsub_bindings.cpp`<br>`src/kernel/realtime/listener.hpp` | `src/kernel/audit/handlers.hpp`<br>`src/kernel/logging.cpp`<br>`src/kernel/logging.hpp` |

## tests-prefix-0.3 — by category

| Repo / Category | N | meanHit@5 | meanRecall@5 |
|---|---:|---:|---:|
| armature/topic | 4 | 1.000 | 0.833 |
| armature/file-discovery | 2 | 1.000 | 1.000 |
| armature/function-discovery | 1 | 1.000 | 1.000 |
| armature/task-related | 2 | 1.000 | 0.750 |
| armature/onboarding | 1 | 1.000 | 1.000 |
| plinth/topic | 6 | 0.833 | 0.333 |
| plinth/task-related | 3 | 0.667 | 0.444 |
| plinth/function-discovery | 1 | 1.000 | 0.667 |

### tests-prefix-0.3 — per-fixture detail

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
| `plinth-session-auth-routes` | topic | ✅ | 0.33 | 17.71 | `data/extensions/shell/0.6.3/client/shell.js`<br>`client/shell/client/shell.js`<br>`src/kernel/auth/handlers.cpp`<br>`src/kernel/frontend/api_frontend.hpp`<br>`src/kernel/rbac/enforcement.cpp` | `src/kernel/auth/handlers.cpp`<br>`src/kernel/auth/handlers.hpp`<br>`src/kernel/auth/middleware.hpp` |
| `plinth-capability-registry-api` | task-related | ❌ | 0.00 | 13.40 | `src/kernel/packages/install_lifecycle.cpp`<br>`src/kernel/capabilities/listener.hpp`<br>`src/kernel/capabilities/bootstrap.cpp`<br>`src/kernel/capabilities/resolution.cpp`<br>`src/kernel/realtime/cursor_store.hpp` | `src/kernel/capabilities/registration.cpp`<br>`src/kernel/capabilities/registration.hpp`<br>`src/kernel/capabilities/types.hpp` |
| `plinth-capability-tier-resolution` | function-discovery | ✅ | 0.67 | 25.92 | `src/kernel/rbac/rule_validator.cpp`<br>`src/kernel/capabilities/resolution.hpp`<br>`src/kernel/capabilities/resolution.cpp`<br>`src/kernel/js/stdlib/cap_bindings.cpp`<br>`benchmarks/tier1_benchmark.cpp` | `src/kernel/capabilities/resolution.cpp`<br>`src/kernel/capabilities/resolution.hpp`<br>`src/kernel/extensions/runtime_registry.hpp` |
| `plinth-rbac-enforcement-filter` | topic | ❌ | 0.00 | 11.51 | `src/kernel/auth/middleware.hpp`<br>`src/kernel/packages/cross_file_validator.cpp`<br>`src/kernel/capabilities/resolution.hpp`<br>`src/kernel/cap/api_cap.cpp`<br>`src/kernel/js/eval.hpp` | `src/kernel/rbac/enforcement.cpp`<br>`src/kernel/rbac/enforcement.hpp`<br>`src/kernel/rbac/rule_registrar.hpp` |
| `plinth-group-bootstrap-rbac-setup` | task-related | ✅ | 0.67 | 27.96 | `src/kernel/groups/handlers.hpp`<br>`src/kernel/auth/handlers.cpp`<br>`src/kernel/rbac/rbac_manifest.hpp`<br>`src/kernel/groups/handlers.cpp`<br>`src/kernel/capabilities/bootstrap.hpp` | `src/kernel/groups/handlers.cpp`<br>`src/kernel/groups/handlers.hpp`<br>`src/kernel/rbac/rule_registrar.hpp` |
| `plinth-realtime-pubsub-broker` | topic | ✅ | 0.67 | 19.32 | `src/kernel/realtime/broker.cpp`<br>`data/extensions/shell/0.6.3/client/sdk.js`<br>`client/shell/client/sdk.js`<br>`src/kernel/ws/close_codes.hpp`<br>`src/kernel/realtime/broker.hpp` | `src/kernel/realtime/broker.cpp`<br>`src/kernel/realtime/broker.hpp`<br>`src/kernel/realtime/listener.hpp` |
| `plinth-websocket-call-dispatch` | topic | ✅ | 0.33 | 20.83 | `src/kernel/ws/call_dispatch.hpp`<br>`data/extensions/shell/0.6.3/client/sdk.js`<br>`client/shell/client/sdk.js`<br>`src/kernel/packages/rbac_test_runner.hpp`<br>`src/kernel/js/eval.hpp` | `src/kernel/ws/call_dispatch.cpp`<br>`src/kernel/ws/call_dispatch.hpp`<br>`src/kernel/ws/connection_registry.hpp` |
| `plinth-package-install-state-machine` | topic | ✅ | 0.33 | 16.64 | `src/kernel/packages/rbac_test_runner.hpp`<br>`src/kernel/packages/install_lifecycle.hpp`<br>`src/kernel/realtime/broker.cpp`<br>`src/kernel/shell/firstboot.hpp`<br>`src/kernel/js/conversion.cpp` | `src/kernel/packages/install_lifecycle.cpp`<br>`src/kernel/packages/install_lifecycle.hpp`<br>`src/kernel/packages/manifest.hpp` |
| `plinth-schema-migrations-runner` | task-related | ✅ | 0.67 | 18.95 | `src/kernel/config.cpp`<br>`src/kernel/packages/migrations.hpp`<br>`src/kernel/packages/migrations.cpp`<br>`src/kernel/db/bootstrap.cpp`<br>`src/kernel/packages/migrations_internal.hpp` | `src/kernel/packages/migration_error.hpp`<br>`src/kernel/packages/migrations.cpp`<br>`src/kernel/packages/migrations.hpp` |
| `plinth-audit-logging-write` | topic | ✅ | 0.33 | 18.04 | `src/kernel/capabilities/bootstrap.cpp`<br>`src/kernel/logging.hpp`<br>`src/kernel/realtime/broker.hpp`<br>`src/kernel/js/stdlib/pubsub_bindings.cpp`<br>`src/kernel/realtime/listener.hpp` | `src/kernel/audit/handlers.hpp`<br>`src/kernel/logging.cpp`<br>`src/kernel/logging.hpp` |
