# DESIGN — Cross-Device Settings Sync via QR / P2P

**Status:** Draft — ready for roadmap integration
**Depends on:** Settings persistence (`js/settings/persistence.js`), workspace-settings safelist (`js/intelligence/workspace-settings/safelist.js`), invisible-unicode security scanner (`js/security/invisible-unicode.js`).
**Sibling subsystems:** `DESIGN-memory.md` (memory has its own Git-based cross-device path via `.aieditor/memory/*.md`), `DESIGN-git-providers-and-ui-extensions.md` (multi-provider registry).
**Consumed by:** Settings UI (export/import buttons), mobile onboarding flow, any surface where a user needs to replicate their AI Editor configuration across devices without a central server.

---

## Problem

AI Editor stores all configuration locally — `localStorage` for `State.settings`, IndexedDB for connections, MCP servers, plugins, memories, and retrieval indices. There is no cloud account or central settings server. This is an architectural strength (zero data leaves the browser), but it creates a friction point: users who run the editor on multiple devices (desktop + laptop, desktop + phone via PWA) must manually re-enter LLM endpoints, API keys, connection tokens, model selections, theme preferences, plugin installations, and every other setting.

The existing `exportSettings()` / `importSettings()` flow in `js/settings/persistence.js` solves this partially — it produces a JSON file the user can transfer manually — but it requires a file-system intermediary and offers no guided pairing experience. For a browser-native app, QR-code pairing with a direct peer-to-peer transfer is the natural UX: scan a code, approve the transfer, settings arrive.

---

## What Cross-Device Sync Is (and Isn't)

**Cross-Device Sync IS:**
- A QR-based pairing protocol that establishes an encrypted WebRTC DataChannel between two browser instances.
- A selective settings transfer: the user chooses what to sync (credentials, plugins, memories, workspace settings).
- A one-time push from a *source* device to a *target* device. No ongoing background sync daemon.
- Fully peer-to-peer — no relay server stores or observes settings payloads.

**Cross-Device Sync IS NOT:**
- A cloud sync service. No settings are uploaded to any server.
- A continuous bidirectional sync engine. There is no conflict-resolution daemon running in the background.
- A replacement for the existing JSON export/import. That flow remains for backup, archival, and air-gapped transfers.
- A way to sync code, files, or git state. Only settings and metadata travel.

**Non-Goals:** Real-time continuous sync; multi-device mesh (more than two devices in one session); syncing active chat conversations (that is `js/chat/sessions-sync.js`'s domain, which uses Git); syncing retrieval indices (too large for QR-initiated P2P; target device re-indexes locally).

---

## Core Architecture

```
┌──────────────────┐                          ┌──────────────────┐
│   Source Device  │                          │   Target Device  │
│                  │      WebRTC DataChannel   │                  │
│  ┌────────────┐  │    ┌──────────────────┐   │  ┌────────────┐  │
│  │ Settings   │──┼───▶│ Encrypted Stream │──▶│  │ Settings   │  │
│  │ Collector  │  │    └──────────────────┘   │  │ Applier    │  │
│  └────────────┘  │                           │  └────────────┘  │
│  ┌────────────┐  │                           │  ┌────────────┐  │
│  │ QR Encoder │  │                           │  │ QR Scanner │  │
│  │ (offer     │  │  QR code carries ICE      │  │ (reads     │  │
│  │  + nonce)  │  │  candidates + ephemeral   │  │  offer     │  │
│  └────────────┘  │  public key               │  │  + nonce)  │  │
└──────────────────┘                           └──────────────────┘
```

The sync session is **initiator-driven**: the source device generates a WebRTC offer, encodes it into a QR code (along with a session nonce and ephemeral public key), and the target device scans it, creates an answer, and sends it back via a secondary QR or via a signaling fallback. Once the DataChannel is open, the source streams a structured settings payload.

### Why WebRTC DataChannel

- **No server required.** ICE candidates can be exchanged via QR codes (offer) and a return QR or clipboard paste (answer). Once connected, data flows peer-to-peer.
- **Built-in encryption.** DTLS-SRTP encrypts all DataChannel traffic.
- **Browser-native.** No native dependencies; works in the same browser environment AI Editor already runs in.
- **Ordered, reliable delivery.** DataChannels support ordered, reliable mode — perfect for a settings blob.

### Why Not Alternatives

| Alternative | Why rejected |
|---|---|
| Cloud sync account | Violates zero-server architecture; adds credential management complexity. |
| Bluetooth / NFC | Not available in browsers; platform-dependent. |
| Local network discovery (mDNS/Bonjour) | Requires same subnet; fails for remote devices; browser APIs are limited. |
| Manual JSON file transfer | Already exists; doesn't solve the UX gap this feature addresses. |

---

## Threat Model

Settings transfers carry **high-value credentials**: LLM API keys, Git provider tokens, MCP server bearer tokens. The threat model is explicit:

### Threats

| Threat | Mitigation |
|---|---|
| **Eavesdropping on DataChannel** | WebRTC DTLS encryption. All traffic is encrypted in transit. |
| **QR code photographed by bystander** | The QR carries only the WebRTC offer (ICE candidates + ephemeral public key), **not** settings. Without the DataChannel answer, the offer is useless. The offer expires after 5 minutes. |
| **Man-in-the-middle during pairing** | The session nonce is displayed on both devices for visual verification ("does the code on your screen match?"). Ephemeral key pairs are generated per session. |
| **Malicious settings injection** | The target device runs the same invisible-unicode scanner (`js/security/invisible-unicode.js`) on the received payload as `importSettings()` does. Additionally, the safelist/denylist from `js/intelligence/workspace-settings/safelist.js` is applied to workspace-settings overrides. |
| **Replay attack** | Each session uses a fresh ephemeral key pair and a random nonce. The nonce is included in the settings payload and verified on the target. |
| **Source device compromised** | Out of scope — if the source is compromised, the user shouldn't be syncing from it. The sync UI warns the user to verify the source device is trusted. |

### Credential Categories

The settings payload is partitioned into categories with different transfer defaults:

| Category | Default | Examples |
|---|---|---|
| **Credentials** | ⚠️ Opt-in (explicit toggle) | `llmApiKey`, `embeddingApiKey`, `connections[*].token`, `mcpServers[*].headers` |
| **Configuration** | ✅ Opt-out (transferred by default) | `llmEndpoint`, `llmModel`, `theme`, `uiScale`, `role`, `advancedParams`, `summarizer`, `ghostText` |
| **Plugins** | ✅ Opt-out | `pluginState`, `installedPlugins`, `userPlugins` |
| **Memories** | ⚠️ Opt-in | Memory store records (large; user must explicitly enable) |
| **Workspace settings** | ✅ Opt-out | `.aieditor/settings.json` overrides (safelist-filtered) |

---

## Data Format

The settings payload is a structured JSON object with a versioned schema, mirroring the existing `exportSettings()` format but with explicit category partitioning:

```json
{
  "syncVersion": "1.0",
  "nonce": "a1b2c3d4...",
  "sourceDevice": {
    "userAgent": "AI Editor 1.4.8 (Chrome 131, Linux)",
    "exportedAt": "2026-01-15T10:30:00Z"
  },
  "categories": {
    "credentials": {
      "llmApiKey": "...",
      "embeddingApiKey": "...",
      "connections": [...],
      "mcpServers": [...]
    },
    "configuration": {
      "llmEndpoint": "...",
      "llmModel": "...",
      "commitModel": "...",
      "apiProvider": "...",
      "timeouts": { ... },
      "appearance": { ... },
      "advancedParams": { ... },
      "providerParameters": { ... },
      "embeddings": { ... },
      "role": "coder",
      "summarizerMode": "balanced",
      "summarizer": { ... },
      "ghostText": { ... },
      "tools": { ... },
      "testLoop": { ... },
      "ignorePatterns": "..."
    },
    "plugins": {
      "pluginState": { ... },
      "installedPlugins": [...],
      "userPlugins": { ... }
    },
    "memories": {
      "records": [...]
    },
    "workspaceSettings": {
      "overrides": { ... }
    }
  }
}
```

**Design decisions:**

- **Flat category partitioning** rather than a deep nested structure. This makes it easy for the UI to render per-category toggles and for the applier to process categories independently.
- **`syncVersion`** at the root enables future schema evolution. The current version is `1.0`.
- **`nonce`** is a 32-byte random hex string, generated per session, included in the payload for replay detection.
- **Credentials are isolated** in their own category so the UI can present a single "Include credentials" toggle with appropriate warnings.
- **Memories are isolated** because they can be large (hundreds of records with embeddings). The UI warns about transfer size.
- **Workspace settings use the existing safelist.** The `workspaceSettings.overrides` object is filtered through `filterToSafelisted()` on the target side — defense in depth even if the source is trusted.

---

## QR Encoding Protocol

### Offer QR (Source → Target)

The source device generates a WebRTC `RTCPeerConnection` offer and encodes a compact JSON payload into a QR code:

```json
{
  "v": 1,
  "type": "offer",
  "nonce": "a1b2c3d4...",
  "sdp": "v=0\r\no=- ...",
  "ice": [
    {"candidate": "candidate:...", "sdpMid": "0", "sdpMLineIndex": 0},
    ...
  ]
}
```

**Size constraints:** QR codes have a maximum capacity of ~3KB for alphanumeric data. A typical WebRTC offer with ICE candidates can exceed this. Two strategies:

1. **Trickle ICE.** The QR carries only the SDP offer (no ICE candidates). ICE candidates are exchanged after the DataChannel is established via a secondary mechanism (clipboard paste or a second QR). This is the **recommended default**.
2. **Compressed SDP.** Base64-encode and gzip-compress the SDP before QR encoding. The target decompresses before creating the answer. Adds complexity but keeps everything in one QR.

**Decision:** Use **trickle ICE with clipboard fallback**. The QR carries the SDP offer + nonce. After scanning, the target creates an answer and displays it as a text block the user copies to the source device (or scans a return QR if the source has a camera). ICE candidates flow through the DataChannel once it's open — but wait, the DataChannel isn't open until ICE completes. So we need ICE candidates to establish the connection in the first place.

**Revised decision:** Use **compressed SDP in the QR**. The source compresses the full offer (SDP + initial ICE candidates) with gzip + base64. The target decompresses, creates an answer, and returns it via clipboard paste or return QR. This keeps the pairing to two steps (scan → paste answer) without requiring a shared network.

### Answer QR / Clipboard (Target → Source)

The target device creates a WebRTC answer and presents it to the user:

```json
{
  "v": 1,
  "type": "answer",
  "nonce": "a1b2c3d4...",
  "sdp": "v=0\r\no=- ...",
  "ice": [...]
}
```

The same compression applies. The user copies the answer text and pastes it into the source device's "Paste Answer" field, or scans a return QR if the source device has camera access.

### Session Nonce Verification

Both devices display the first 8 characters of the nonce (e.g., `a1b2c3d4`). The user visually confirms they match before proceeding. This prevents pairing with a rogue device that happens to be on the same network.

---

## Transfer Flow

### Step-by-Step

1. **Source device:** User clicks "Send Settings to Another Device" in Settings → General.
2. **Source device:** A category-selection panel appears. The user toggles which categories to include (credentials, configuration, plugins, memories, workspace settings). Defaults: configuration + plugins + workspace settings ON; credentials + memories OFF.
3. **Source device:** User clicks "Generate QR Code". A WebRTC offer is created, compressed, and rendered as a QR code. The nonce is displayed below.
4. **Target device:** User clicks "Receive Settings from Another Device" in Settings → General. The camera/QR scanner activates.
5. **Target device:** User scans the QR code. The offer is decompressed and validated. The nonce is displayed for visual confirmation.
6. **Target device:** User confirms the nonce matches and clicks "Accept". A WebRTC answer is created, compressed, and displayed as text (and optionally as a return QR).
7. **Source device:** User pastes the answer text (or scans the return QR). The WebRTC connection is established.
8. **Source device:** The selected settings categories are collected, serialized into the sync payload format, and streamed over the DataChannel.
9. **Target device:** The payload is received, the invisible-unicode scanner runs, and a preview panel shows what will be applied.
10. **Target device:** User reviews the preview and clicks "Apply Settings". The settings are applied and the browser reloads.

### Error Handling

| Error | User-facing message | Recovery |
|---|---|---|
| QR decode fails | "Could not read QR code. Try again or paste the code manually." | Manual paste input appears. |
| Offer expired (>5 min) | "This QR code has expired. Generate a new one." | Source regenerates. |
| Nonce mismatch | "Session codes don't match. Do not proceed — this may be a rogue device." | Abort. |
| DataChannel fails to open | "Connection failed. Check that both devices are online and try again." | Retry from step 3. |
| Payload too large (>50MB) | "Settings payload is too large. Try excluding memories or plugins." | User deselects categories. |
| Invisible-unicode detected | "Settings file contains suspicious characters. Review before applying." | User can cancel or proceed with warning. |
| Version mismatch | "This device is running an incompatible version. Update AI Editor and try again." | Abort. |

---

## Conflict Resolution

When settings are applied on the target device, there are three possible states for each setting:

1. **Target has no value** (fresh install or never configured): Apply the source value directly.
2. **Target has a different value**: Present a per-category merge strategy in the preview:
   - **Overwrite** (default): Replace target values with source values.
   - **Keep existing**: Skip settings where the target already has a value.
   - **Merge** (for arrays/objects): Combine where possible (e.g., merge plugin lists, union ignore patterns).
3. **Target has the same value**: No action needed.

**Decision:** The preview panel shows a summary ("12 settings will change, 3 will be added, 5 are already the same") with a per-category expand/collapse. The user selects the merge strategy before applying. There is no automatic conflict resolution — the user is always in control.

### Workspace Settings Conflict

When workspace settings are transferred, the target device applies the safelist filter (`filterToSafelisted()`) before merging. Any keys not on the safelist are stripped and listed in the preview as "ignored (not safelisted)". This is defense in depth — even if the source device is compromised, unsafe keys cannot be injected.

### Memory Conflict

Memory records use the same supersession model as the memory subsystem (`DESIGN-memory.md`). When memory records are transferred:
- Records with the same `key + scope` are compared by `updated_at`.
- The newer record wins; the older is marked `superseded_by`.
- The preview shows how many memories will be added, updated, or superseded.

---

## Security Considerations

### Ephemeral Key Pairs

Each sync session generates a fresh `CryptoKeyPair` using the Web Crypto API (`window.crypto.subtle.generateKey`). The public key is included in the QR offer; the private key stays on the source device. The DataChannel encryption uses WebRTC's built-in DTLS, but the ephemeral key pair provides an additional layer: the settings payload is encrypted with the target's public key before transmission, and the target decrypts with its private key. This is defense in depth — even if DTLS were somehow compromised, the payload remains encrypted.

### Payload Encryption

```
source collects settings → JSON.stringify → gzip → encrypt(targetPublicKey) → base64 → DataChannel
```

On the target:
```
DataChannel → base64 decode → decrypt(privateKey) → gunzip → JSON.parse → validate → preview → apply
```

### No Persistent Pairing

After a sync session completes, all WebRTC state, key pairs, and ICE candidates are discarded. There is no "paired device" list. Each sync is a fresh session. This minimizes the attack surface — a compromised device cannot reconnect to a previously paired device.

### Clipboard Security

When the user copies the WebRTC answer to the clipboard, the clipboard content is the compressed SDP answer (no settings). This is safe to paste. The settings payload only flows over the encrypted DataChannel.

### Rate Limiting

The QR offer expires after 5 minutes. The source device enforces this by discarding the `RTCPeerConnection` and key pair after the timeout. This limits the window for replay attacks.

---

## Implementation Plan

### Phase 1: Core Sync Engine (1.5.0)

**New module:** `js/settings/sync/`

| File | Purpose |
|---|---|
| `sync/collector.js` | Collects settings from `State.settings`, `Storage`, registries into the sync payload format. Mirrors `exportSettings()` logic but with category partitioning. |
| `sync/applier.js` | Receives a sync payload, validates it, runs the invisible-unicode scanner, applies settings to `State.settings` and `Storage`. Mirrors `importSettings()` logic. |
| `sync/webrtc.js` | WebRTC offer/answer creation, ICE candidate handling, DataChannel management. Encapsulates all WebRTC complexity. |
| `sync/qr.js` | QR code generation (source) and scanning (target). Uses a lightweight QR library (e.g., `qrcode` for encoding, `jsQR` for decoding). |
| `sync/crypto.js` | Ephemeral key pair generation, payload encryption/decryption using Web Crypto API. |
| `sync/protocol.js` | Payload schema definition, version negotiation, nonce generation/validation. |
| `sync/ui.js` | Settings UI surfaces: send/receive buttons, category toggles, QR display, scanner view, preview panel, nonce display. |

**Dependencies to add:**
- `qrcode` (npm) — QR code generation for the offer.
- `jsQR` (npm or vendored) — QR code scanning for the target.
- Both are small, well-maintained, and browser-compatible.

**What ships:**
- Settings → General tab gets "Send to Device" and "Receive from Device" buttons.
- Full QR-based pairing flow with clipboard fallback.
- Category selection with credentials opt-in.
- Preview panel before applying.
- Invisible-unicode scanning on received payloads.
- Safelist filtering for workspace settings.

### Phase 2: Return QR (1.5.x)

- Source device can scan a return QR code instead of pasting the answer text.
- Requires camera permission on the source device (already needed for the target's scanner).
- Improves UX for desktop-to-desktop transfers where both devices have cameras.

### Phase 3: Memory Sync (1.6.x)

- Full memory store transfer with supersession handling.
- Progress indicator for large memory transfers (hundreds of records with embeddings).
- Option to transfer only `user`-scope memories (smaller payload).

### Phase 4: Multi-Device Chain (post-2.0)

- A device that receives settings can immediately become a source for a third device.
- Chain propagation with nonce tracking to prevent loops.
- Deferred until Phase 1 usage patterns are understood.

---

## Removability

If this feature is removed:
- Delete `js/settings/sync/` directory.
- Remove the "Send to Device" / "Receive from Device" buttons from the Settings UI.
- Remove `qrcode` and `jsQR` dependencies.
- No migration needed — no persistent state is created by the sync feature. All state is ephemeral per session.

---

## Open Questions

| Question | Options | Recommendation |
|---|---|---|
| QR library choice | `qrcode` + `jsQR` (npm) vs vendored vs custom | `qrcode` + `jsQR` — small, well-maintained, no native deps. |
| Compression algorithm | gzip vs lz-string vs none | gzip via `CompressionStream` API — built into modern browsers, no dependency. |
| Max payload size | 10MB / 50MB / unlimited | 50MB hard cap with user warning at 10MB. Memories alone can exceed 50MB with embeddings. |
| Return QR vs clipboard paste | Both vs clipboard only | Both — clipboard is the fallback, return QR is the preferred path when cameras are available. |
| Credential transfer default | Opt-in vs opt-out | Opt-in — credentials are high-value; the user must explicitly enable them. |
| Version compatibility | Strict (same version) vs forward-compatible | Forward-compatible within major version. `syncVersion` is semver-like: `1.x` is compatible with `1.y`. |
| Browser support | All modern browsers vs Chrome/Firefox only | All modern browsers — WebRTC, Web Crypto, and CompressionStream are widely supported. Safari 15+ is the floor. |

---

## What This Design Commits To

- **Peer-to-peer only.** No server, no cloud, no relay. Settings flow directly between two browser instances.
- **QR-initiated pairing.** The QR code carries the WebRTC offer (compressed SDP), not settings. Settings flow over the encrypted DataChannel.
- **Ephemeral sessions.** No persistent pairing state. Each sync is a fresh session with fresh key pairs.
- **Category-partitioned payload.** Credentials, configuration, plugins, memories, and workspace settings are separate categories with independent transfer toggles.
- **Credentials opt-in.** The user must explicitly enable credential transfer. Default is OFF.
- **Preview before apply.** The target device always shows a preview of what will change before applying.
- **Invisible-unicode scanning.** All received payloads are scanned for Trojan Source / glassworm attacks before application.
- **Safelist enforcement.** Workspace settings overrides are filtered through the existing safelist on the target side.
- **User-controlled conflict resolution.** No automatic merging. The user chooses overwrite, keep, or merge per category.
- **Library, not service.** All code runs in the browser. No external dependencies beyond QR encoding/decoding libraries.
- **Versioned payload schema.** `syncVersion` at the root enables future evolution without breaking existing clients.

These are the load-bearing decisions. Push back on any of them before building.
