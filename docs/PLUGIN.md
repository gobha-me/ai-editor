# Plugin Contract

Plugins are JavaScript modules loaded in the browser. Installed plugin URLs are
user-controlled configuration; plugin code therefore runs with application-page
authority and must be treated like code the user chose to install.

## Manifest and registration

A plugin exports a manifest with a stable `id`, display metadata, and an
initialization function. Initialization receives the supported plugin API and
may contribute tools, tabs, settings surfaces, or event handlers. IDs and tool
names must be unique.

Plugins bundled under `plugins/` use the same lifecycle as installed plugins.
Remote installation validates URL and source safety checks before persistence;
it does not make an origin trustworthy.

## Lifecycle invariants

- Load is all-or-failed from the registry's perspective. Partial contributions
  are removed when initialization fails.
- Disable, uninstall, replacement, conversation cleanup, or failed reload removes
  every tool and handler contributed by that plugin.
- Plugin tools pass through the public registry, active profile, side-effect,
  plan-mode, and output-scan boundaries.
- Plugin content is untrusted for rendering and prompt authority.
- Persisted records contain installation metadata, not credentials copied from
  unrelated settings.
- Plugin-development profile behavior is a capability overlay; activating an
  editor tab does not silently switch the user's profile.

The loader, modal, editor, registry, profile-overlay, invisible-Unicode, and tool
cleanup tests define the executable lifecycle contract.
