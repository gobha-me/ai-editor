# DESIGN — Persona: Composition Above Profile

**Status:** Draft
**Depends on:** `DESIGN-profiles.md`, `DESIGN-memory.md` (scope grammar), `DESIGN-tools.md` (optional overlay), and the architectural principle in `DESIGN-intelligence.md`.
**Consumed by:** Product surfaces that need user-facing or product-facing identity above the surface adapter — including but not limited to single-Persona chatbots, multi-Persona assistants, multi-user shared-Persona RPGs, and character-driven applications.

---

## Problem

`DESIGN-profiles.md` answers the question *"what kind of product is calling the intelligence subsystems?"* — a Profile is the surface adapter that holds compression rules, retrieval strategies, tool defaults, and budget allocations for a coder, a chat product, a KB browser, an RPG, and so on.

What a Profile does *not* answer: *who is the LLM speaking as in this conversation?*

That question is real, distinct, and shows up the moment a product has more than one identity:

- A chat product where one user has separate "research assistant" and "creative writing helper" identities.
- A shared-Persona RPG where many users interact with the same in-world character.
- A platform where the platform vendor sets one tone, the end user sets another, and a Persona contributes a third — and all three get merged into the system prompt the model sees.
- A character-driven application where each character has its own voice, its own remembered history with the user, and possibly its own tool overlay.

Conflating Persona into Profile makes the contract dishonest: the Profile name says "I'm doing roleplay" but the actual content also says "I'm Captain Picard" — two different decisions at two different lifecycles, smuggled into one slot. Conflating Persona into Memory hides identity in record metadata where admission policy has to reconstruct it on every turn. Conflating Persona into the agent loop puts behavioral identity inside the execution-cycle contract, where it doesn't belong.

The architecture needs a place for *identity composition* that sits above Profile, uses the existing subsystems, and doesn't fragment them further.

---

## What Persona Is (and Isn't)

**A Persona IS:**

- A composition of three configuration concerns: a Profile (surface adapter), a Model (LLM selection), and a System Prompt contribution (personality / identity / behavioral framing).
- A higher-level construct that *uses* the architecture; not part of the architecture's surface taxonomy.
- The authoring source for one of several contributions to the system prompt slot in the assembled prompt.
- Memorable: Persona is a valid axis for Memory's scope tuple (see `DESIGN-memory.md`).
- Toolable, optionally: a Persona may contribute additional tools beyond the Profile's static set (e.g., a Persona representing a starship captain might have `consult_ship_log` available alongside the RPG Profile's defaults).
- Subject to "identity belongs to the creator" — creation, update, and deletion are scoped to whoever has authority over the Persona, whether that's the user, an admin, the platform vendor, or a content author.

**A Persona IS NOT:**

- A third architectural surface. The umbrella's commitment to *four admission subsystems + two architectural surfaces (Profile above, agent loop below)* stands as written. Persona is a consumer pattern *built on* Profile; it does not displace it.
- A subsystem. Persona does not own an atomic unit. ChunkRef belongs to Retrieval, MemoryRecord to Memory, Turn to Compression, ToolDef to Tools.
- A behavior overrider for subsystems. Persona does not alter compression rules, retrieval strategies, or admission policy — those are Profile concerns. Persona overlays *content* (prompt contribution, optional tool admissions, memory scope) on top of the Profile's behavior.
- A character authoring framework. The architecture exposes the slots and constraints; what goes in the system prompt slot, what tools a Persona contributes, and how Personas are presented to users are product-design concerns outside scope.
- A merge policy. The architecture commits to the slot existing and to merge being deterministic per implementation; it does not prescribe the merge order between Admin, User, and Persona contributions to the system prompt.

**Non-Goals:**

- Personality engineering, prompt-writing guidance, or character-voice authoring.
- A specific system prompt merge order (the architecture exposes the slot; the order is operator policy).
- A specific Persona ownership model (user-owned, admin-owned, platform-owned, content-author-owned — all are valid; the architecture is policy-neutral).
- Cross-Persona memory sharing protocols (Memory's scope grammar already handles this; specific compositions are operator policy).
- Multi-Persona-within-a-session policies (whether and how two Personas can coexist in one conversation is Profile-shaped).
- A Persona marketplace, discovery mechanism, or distribution protocol.
- Model selection mechanics (which LLM to use is a deployment concern; only its architectural consequences are in scope here).

---

## Goals

- Name *identity composition* as a concept the architecture acknowledges, with a clear seam between Persona and Profile.
- Specify what Persona occupies in the existing slots (system prompt slot, Memory scope axis, optional tool overlay) without inventing new subsystem machinery.
- Frame the multi-author system prompt as a first-class slot with deterministic merge, while leaving the merge policy open.
- Provide enough constraint that implementations of Persona are interoperable across products built on Intelligence; provide enough latitude that strict-isolation and open-composition systems can both be expressed.

---

## The Load-Bearing Distinction: Above Profile, Not Beside It

The temptation when a new concept emerges is to make it a peer to the things it relates to. Persona could plausibly be argued as a third architectural surface, peer to Profile and the agent loop. The doc set committed to the opposite reading for one specific reason: **Profile is a property of the surface; Persona is a property of the conversation.** A given Profile may host many Personas over its lifetime. A given Persona uses exactly one Profile at a time. The cardinality is asymmetric, and asymmetric cardinality is the diagnostic sign of a layering relationship, not a peer relationship.

Practically, this means:

- A product chooses a Profile once, at the surface level, when the product is built. (Coder profile, KB profile, RPG profile.)
- Within a product, Personas come and go per session, per user, per shared world — much more dynamically than Profiles.
- The Profile defines the *behavior envelope* (which compression rules fire, which retrieval strategies are valid, which tools are available statically). The Persona operates *inside* that envelope.
- The umbrella's surface commitment doesn't change because no new surface was added; what was added is a consumer pattern that sits above the existing one.

This also means the Persona doc is shorter than the others, because most of what Persona does is *use* existing machinery — not invent new machinery.

---

## The Composition

A Persona is the triple:

```
Persona {
  profile:      ProfileID         // the surface adapter this Persona runs on
  model:        ModelSpec         // LLM selection (configuration, see §"The Model Attribute")
  prompt:       PromptContribution // system prompt contribution (one of several authoring sources)
  identity:     PersonaIdentity   // who created this, who can update it, scope ownership
  tools:        []ToolID?         // optional overlay on the Profile's static tool set
  memory_scope: ScopeSpec?        // optional default scope for memory writes/reads
}
```

Every field except `profile` and `identity` is optional. A minimal Persona is `(profile, identity)` — the Profile provides defaults for everything else and the Persona's identity is the user-facing handle (display name, ownership). All three of `model`, `prompt`, and `tools` are configuration concerns; the architecture does not prescribe their contents, only that the slots exist and how they compose.

The `memory_scope` field is the Persona's hint to the Memory subsystem about default scope when this Persona writes or reads. It is a hint, not an enforcement — the actual scope of any given MemoryRecord is determined by Memory's scope grammar (see `DESIGN-memory.md`), and may be narrower (a one-off Persona×User write) or wider (an admin-elevated Persona-wide write) than the default. The Persona's contribution is the default policy; the Memory subsystem holds the authority.

---

## System Prompt as a Multi-Authored Slot

The single most consequential thing this doc commits to: **the system prompt is not authored by a single entity.** The Profile's prompt assembly (step 8 of the turn flow in `DESIGN-intelligence.md`) treats the system prompt as a slot with potentially multiple contributions. Common authoring sources include:

- **Admin contribution** — set by the platform vendor or deployment operator. Often the only contribution in single-tenant or strictly-controlled deployments. Carries policy constraints, safety guardrails, deployment-wide tone.
- **User contribution** — set by the end user. Carries personal preferences, project-specific guidance. May be empty in deployments where users do not have system prompt authoring rights.
- **Persona contribution** — set by whoever authored the Persona. Carries identity, voice, character-specific behavioral framing.

These contributions merge into the single system prompt slot the model receives. The architecture commits to:

- The slot exists and has a well-defined position in the assembled prompt (per `DESIGN-profiles.md`, the Profile is the assembler).
- Merge is deterministic per implementation — the same contribution set produces the same merged result.
- Merge is auditable — diagnostics on the assembly step record which contributions were present and how they composed, per the umbrella's diagnostics principle.

The architecture does *not* commit to:

- A specific merge order (whether Admin precedes User precedes Persona, or some other order).
- A specific conflict-resolution policy (whether later contributions override earlier ones, whether contributions are concatenated, whether contradictions are flagged).
- Which authoring sources are valid in a given deployment (a strict enterprise system may admit only Admin; a user-facing creative tool may admit all three).

These are profile-shaped policies. A coder profile in a strict enterprise might admit only the Admin contribution and silently discard others; an RPG profile might admit all three with a specific merge order and conflict-resolution rule the operator chose. The architecture exposes the slot; the operator chooses the policy.

**Why this matters:** treating the system prompt as a single-author slot was the historical default and the historical failure mode. The moment a product needs both platform policy and user customization, single-author slots force one of: (a) the platform's policy gets buried in user-editable text, (b) the user has no customization affordance, (c) ad-hoc string concatenation in surface code that doesn't survive review. Making the slot explicitly multi-author with a deterministic merge is the load-bearing fix.

---

## Memory Scope Interaction

Memory's scope grammar is `(writer, visibility, persistence)` per `DESIGN-memory.md`. Persona contributes one valid axis to this grammar, but is not the only axis.

Common compositions involving Persona, presented as **illustrations not commitments**:

- **Persona-wide** — `(persona, persona-global, persistent)`. The Persona remembers things across all users and all sessions. Example: in a shared-Persona multi-user RPG, the in-world character recalls events from prior sessions with any player.
- **Persona × User** — `(persona-or-user, persona-and-user-only, persistent-or-session)`. The Persona remembers things about this specific user, not visible to other users of the same Persona, and not visible to this user's other Personas. Example: a counselor character remembers a private confidence from one user without exposing it to others; the user's coding-assistant Persona never sees it either.
- **Persona × Project** — `(persona-or-user, this-project-only, project-lifetime)`. The Persona remembers project-scoped facts when used inside a shared project context.
- **Persona × User × Project** — narrower still; rarely needed but expressible.
- **Persona-transient** — `(persona, this-turn-only, no-persistence)`. Admitted into the working state for the current turn but never proposed for write. Useful for sensitive content that informs behavior without becoming durable.

The architecture commits to:

- Persona is a valid value for the `writer` axis.
- Persona is a valid component of the `visibility` axis, composable with User, Project, and Group.
- Memory's admission policy is scope-aware; the model sees only admitted content and never sees scope metadata.

The architecture does not commit to:

- Which compositions are valid in a given deployment (strict isolation defaults to Persona×User; open systems may default to Persona-wide).
- How groups interact with Personas (deferred to Memory's group-scope discussion).
- Whether cross-Persona reads are ever valid (operator policy).

---

## Tool Overlay (Optional)

Some Personas need tools that aren't part of the Profile's static set. A Persona representing a starship captain in an RPG might want `consult_ship_log`; a Persona representing a customer support agent might want `lookup_account` even though the underlying chat Profile doesn't load it by default.

The Tools subsystem (per `DESIGN-tools.md`) admits via three layers: Profile's static set, sticky tools from the task ledger, and discovery via meta-tools. A Persona's optional `tools` field contributes a fourth admission source: **persona overlay**, layered on top of the Profile's static set.

The architecture commits to:

- Persona tool overlay, when present, is admitted at the same priority tier as Profile's static set — that is, before sticky tools and before discovery results.
- Authorization filters apply uniformly to persona-contributed tools; the Persona cannot bypass the user's RBAC or the Tools subsystem's `side_effects` policy.
- Diagnostics on tool admission record persona overlay separately so operators can audit which tools were admitted because of which authoring source.

The architecture does not commit to:

- Whether persona overlay is permitted in a given deployment (Profile policy may forbid it).
- Whether persona-contributed tools can include `irreversible` side effects (operator policy; security-sensitive deployments will forbid this).
- Conflict resolution when the Persona contributes a ToolID also in the Profile's static set (the architecture's "no double admission" rule already covers the mechanics; which version wins is profile policy).

---

## The Model Attribute (Configuration, Not Architecture)

A Persona's `model` field selects which LLM the Persona uses. This is a configuration concern, not an architectural one — the architecture is implementation-agnostic about which LLM provider, which model family, or which inference endpoint is used.

The architectural consequences the Persona doc acknowledges:

- **Context window** — different models have different effective windows. The Compression subsystem's budget allocation needs to know the window size; this flows from the Persona's model selection through the Profile's budget allocation step.
- **Tool-calling convention** — different models expose tool-calling differently (native function-calling, tool-use blocks, JSON-schema modes). The Tools subsystem's admission must produce ToolDefs in a shape the chosen model accepts; this is normally a Profile-level adapter, configured per model.
- **Reasoning mode** — some models have explicit reasoning steps that influence how compression and retrieval results should be presented. Profile-level policy may select different rule sets based on the Persona's model.

The architecture does *not* care about:

- Which provider hosts the model.
- Which specific model is named (Sonnet, Opus, GPT, Gemini, Llama, etc.).
- How the model is billed.
- Inference latency, throughput, or pricing.

A Persona's `model` field is an opaque ModelSpec from the architecture's point of view; the deployment binds it to actual inference. The Persona doc names the field so it has a defined home and so the architectural consequences (window, tool-calling, reasoning) are not hidden assumptions elsewhere.

---

## Persona Lifecycle and Identity

The umbrella's "identity belongs to the creator" principle applies to Personas as it does to MemoryRecords, ChunkRefs, and ToolDefs:

- A Persona is created by exactly one authority (user, admin, platform vendor, content author — operator policy determines which is valid in a given deployment).
- That authority owns updates and deletion. No cross-authority mutation of Persona configuration.
- Persona identity (the PersonaID and the ownership metadata) is stable across the Persona's lifetime; the Profile, Model, prompt, tool overlay, and memory scope may evolve.
- A Persona deletion is a real event — when a Persona is deleted, its associated MemoryRecords (per Memory's scope grammar) are subject to the scope's persistence policy, which may include cascade deletion of persona-scoped memory.

The architecture commits to lifecycle events being auditable and to the writer-authority model being uniform with other atomic units. The architecture does not commit to:

- Specific Persona ownership models (user-owned vs admin-owned vs platform-owned).
- Specific deletion policies (whether persona-scoped memory cascades on persona deletion).
- Persona transfer between authorities (whether and how a user-owned Persona can be reassigned to admin ownership).

---

## Trust Labels

Per `DESIGN-intelligence.md` §"Trust Labels on Admitted Content," every piece of content admitted into the prompt carries a provenance label. Persona contributes labeled content at two points:

- **The system prompt contribution.** The Persona's contribution to the multi-author system prompt slot carries `authority: persona, authority_id: <PersonaID>` and a trust tier configured by the deployment. The architecture commits to the label being stamped at the contribution boundary and propagated through the Profile's assembly; it does not commit to where Persona-tier sits in the override-authority ordering (operators commonly place it below Admin and at or above User, but this is policy, not architecture).
- **Persona-overlay tools.** Tools contributed via the optional `tools` overlay carry `authority: persona, authority_id: <PersonaID>` on the ToolDef admission. Tool *results* are stamped at the agent-loop boundary per the Authorship Rule, not by the Persona — the Persona's authorship attaches to the tool's *availability*, not to what the tool returns.

These labels are the architectural reason Persona-overlay tools and Persona system prompt contributions can be governed by the same operator policy that governs other authoring sources (Admin, User, Profile-directive, Retrieval, Tool, Derived). The Persona doc names what gets labeled and references the umbrella for how labels behave; it does not redefine the trust contract.

---

## Worked Examples

**Example 1 — Single-tenant enterprise chatbot.** A company deploys a customer support chatbot. The platform vendor sets an Admin system prompt with policy and tone. The deployment has one Persona ("Support Bot"), one Profile (chat), one Model. End users have no system prompt authoring rights. The Persona is admin-owned; user-contributed system prompts are forbidden by Profile policy. Memory scope is Persona×User-session, with no cross-session persistence. The merge order is simple because only Admin and Persona contribute.

**Example 2 — Multi-Persona personal assistant.** A user has three Personas: "Research Helper," "Creative Writer," "Code Reviewer." Each runs on a different Profile (KB, chat, coder). All are user-owned. The user authors their own system prompt contribution per Persona, layered on top of an Admin contribution that sets safety constraints. Memory is Persona×User: Research Helper's memory is invisible to Creative Writer. Tool overlays vary per Persona.

**Example 3 — Shared-Persona multi-user RPG.** A character ("Picard") is content-author-owned. Many users interact with the same Persona instance. Memory scope is Persona-wide for in-world events (the character remembers all interactions) but Persona×User for private confidences (handled by user-managed Profile policy distinguishing public log from private channel). The system prompt has Admin contribution (platform safety), no User contribution (users do not author character prompts), and Persona contribution (the character's voice and lore). The Profile is RPG-shaped; Persona overlay adds `consult_ship_log` and `query_starfleet_records`.

**Example 4 — Hybrid user-and-platform configuration.** A creative writing platform has a Persona ("Editor") that the platform vendor authored. Users can override parts of the Persona's behavior — they can add their own system prompt contribution layered on top of the platform's, and they can add tools from a vetted catalog. Memory is User-scoped (the Editor remembers things across this user's sessions) but not Persona-wide (the Editor doesn't share memories across users). The merge order in this deployment is Admin → Persona → User, with User contributions appended last.

These examples are illustrative of the policy space, not normative. The architecture supports all of them with the same mechanism.

---

## Failure Modes

- **Persona-as-Profile leak.** Putting subsystem behavior (compression rules, retrieval strategies) into a Persona instead of a Profile. The diagnostic sign: two Personas under the same Profile end up needing different rule sets. If that happens, the variation is profile-shaped and the Personas are misclassified.
- **Profile-as-Persona leak.** Putting identity (system prompt voice, character) into a Profile instead of a Persona. The diagnostic sign: the Profile cannot host more than one identity without forking. If that happens, the identity should be lifted into a Persona overlay.
- **Single-author system prompt assumption.** Surface code that treats the system prompt as a single string authored by one source. Breaks the moment a deployment adds Admin policy on top of user customization. The fix is to recognize the slot is multi-author from the start.
- **Scope confusion at admission time.** Memory queries that confuse "writer" with "visibility" — e.g., admitting a Persona×User record into a different user's context because both records share the same Persona. Single-writer plus scope-aware admission, per `DESIGN-memory.md`, prevents this; the Persona doc does not invent additional enforcement.
- **Persona tool overlay bypassing authorization.** A Persona contributing tools that should require user consent but appear to admit silently. The Tools subsystem's authorization layer applies uniformly; Persona overlay does not bypass it. Implementations that route persona overlay through a separate path miss this.
- **Hidden Model assumptions.** Surface code that assumes a specific context window size or tool-calling convention, breaking when a Persona switches models. The fix is to read the Persona's ModelSpec at Profile-assembly time and configure the budget and tool adapter accordingly.

---

## Open Questions

- **Persona inheritance.** Should Personas support inheritance (a "Base Editor" Persona that "Strict Editor" and "Permissive Editor" both extend)? Profiles already have base+overrides; whether Personas need the same composition is deferred until a concrete need surfaces.
- **Cross-Persona handoff.** Within one session, can a conversation switch from one Persona to another (e.g., a router Persona dispatching to specialists)? Likely profile-shaped policy; possibly a Profile pattern called "Persona router" rather than an architectural primitive.
- **Persona versioning.** When a Persona's system prompt is updated, what happens to in-flight memory tagged with the prior version? Memory's scope grammar may need a version axis for Personas with frequent prompt iteration; deferred.
- **Persona discoverability.** When a deployment supports many Personas, how does the user discover them and switch between them? This is product UX, but the architecture may need a "list available Personas" admission affordance similar to the meta-tool discovery protocol. Deferred.

---

## What This Document Commits To

- **Persona is a composition above Profile, not a new architectural surface.** The umbrella's "four admission subsystems + two architectural surfaces" framing stands. Persona is a consumer pattern that uses Profile.
- **The system prompt is a multi-author slot.** Admin, User, and Persona are common authoring sources; merge is deterministic per implementation and auditable in diagnostics; merge policy is operator choice, not architectural commitment.
- **Persona is a valid axis in Memory's scope grammar.** The tuple `(writer, visibility, persistence)` accommodates Persona-wide, Persona×User, Persona×Project, and Persona-transient as common compositions; the architecture commits to the axis, not to specific compositions.
- **Persona may contribute a tool overlay**, admitted at the same priority as the Profile's static set, subject to the same authorization filters. Whether overlay is permitted in a deployment is profile policy.
- **The Model attribute is a configuration concern.** The architecture acknowledges its consequences (window, tool-calling, reasoning mode) but does not select models.
- **Identity belongs to the creator** applies uniformly. Persona ownership and lifecycle follow the same writer-authority model as other atomic units.
- **The architecture exposes slots and constraints; operators configure policy.** This is the Persona doc's overall posture, consistent with the project's "give hints and possibilities, not be prescriptive" principle.

If a future requirement seems to require breaking any of these, the requirement gets pushed back on first, and only if the requirement is genuinely incompatible is the architecture revisited. The slot-not-policy distinction is the load-bearing decision; the rest is configuration.
