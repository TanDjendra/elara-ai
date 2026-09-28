# ELARA Architecture

## Boundary

DeepSeek Harness remains an upstream dependency. ELARA-specific behavior is implemented as plugins, channel adapters, and a device protocol.

## Local mode

```text
WhatsApp/Telegram/Laptop UI
          ↓
      ELARA local
          ↓
   DeepSeek Harness
          ↓
     Windows tools
```

## Cloud mode target

```text
WhatsApp/Telegram/Web
          ↓
      ELARA Server
          ↓ secure device protocol
   ELARA Companion
          ↓
       Windows
```

The device protocol is intentionally independent from deployment mode so the local implementation can later be hosted remotely without changing Windows capabilities.

## Plugin safety

DSH plugins are trusted host code, not a sandbox boundary. ELARA plugins must:

- keep dependencies minimal;
- avoid arbitrary command execution when a typed capability can be used;
- expose read-only system tools by default;
- route mutations through an explicit policy/approval layer;
- never embed secrets in source;
- pin production dependencies before cloud deployment.

## P2B approval boundary

`elara-access` asks DSH's approval service only from `tools/pre-execute` for a reviewed, sensitive host capability during an open turn. The request is displayed through the pending approval inbox. The inbox is in memory, expires requests after two minutes, and consumes an answer exactly once. Its identifier is not itself an execution grant. A grant is bound to the DSH execution token, tool name, call ID, frozen arguments, session cwd, principal, session binding, selected host device, policy, and runtime mode. The final `tools.guard()` rechecks that scope after other pre-execute listeners and consumes the token before dispatch. If DSH's native sandbox asks for the same frozen execution, it reuses that one-time answer; a different call requires a new approval.

The dashboard token maps only to the configured dashboard principal. WhatsApp answers require the exact configured sender alias and are handled before the per-user conversation queue so a waiting turn cannot deadlock its own approval. WhatsApp sends a readable preview using WhatsApp bold, italic, and monospace syntax while keeping the exact command or arguments, followed by an optional native quick-reply card. Some Baileys clients do not render the card. The sender can react ✅ or ❌ to the exact preview, or quote-reply to it with `.approve` or `.reject`, without typing an ID. `.approve <id>` and `.reject <id>` remain available for compatibility. Button IDs and preview message IDs resolve only a pending question for that sender and channel, and a replay cannot grant another execution. DSH's sandbox approval for the same frozen tool execution reuses ELARA's one-time answer, while a later tool call needs a new question. Dashboard project actions enter a dashboard-owned agent turn; the endpoint never calls a tool implementation directly. The companion sender and receiver admit only reviewed remote status. Approval does not enable broad search, protected reads, link traversal, legacy remote mutation, or cloud host execution.

Verified owner ingress may set an in-memory `.auto on` grant for its immutable WhatsApp session on the local host. The policy evaluator must first return `approval_required` for a reviewed sensitive tool; the access service then records `AUTO_MODE_ALLOWED` and gives that exact DSH execution a scoped token. The final tool guard checks the token against the current mode instance, so `.auto off`, `.stop`, or an off/on cycle cannot revive an old call. Native DSH sandbox approval uses the same scoped token. Enablement writes a redacted `auto_mode_changed` audit row before taking effect and cancels pending questions in the live owned scope. The current request must be resent. Disabling takes effect even if audit storage has failed. The grant is never persisted and therefore ends on restart. P2A denials, channel and principal boundaries, and companion restrictions remain authoritative.

The owner-only `.settings` WhatsApp command runs before the conversation queue, so it remains responsive during a long agent turn. It exposes a typed allowlist of live preferences: emotion and typing are saved atomically in a versioned preferences file, initiative delegates to the existing autonomy store, and auto mode delegates to the existing audited access service. The previous flat emotion-preference file is read and migrated on the next save. Settings are keyed by hashed sender alias. The menu reports integration availability without secret values and cannot alter credentials, provider setup, device authority, or policy rules.

Owner-managed WhatsApp members are separate from static access configuration. A verified owner alias with a bound WhatsApp session may add or revoke only dynamic chat-only members through the access service. The control database has an additive `whatsapp_members` table; membership and a redacted `membership_changed` audit event commit in one SQLite transaction. Startup restores only active members with valid exact phone JIDs and generated IDs, skipping any alias now claimed by static configuration. Dynamic members have distinct principal IDs, no device authority, and a policy-level `CHAT_ONLY_ROLE` denial for all tool capabilities. Their session IDs contain that principal ID so revocation and later re-addition cannot inherit the old session binding. Revocation requests a scoped DSH stop before removing ingress authority, fencing queued work and old replies. Static owner and locally configured principals cannot be promoted or removed through WhatsApp. The legacy allowlist JSON remains on disk but is not consulted for authorization.
If audit is degraded, adding access fails closed. Revocation still removes live ingress authority and attempts a durable member update without claiming an audit row. If that update also fails, the owner sees an unconfirmed durability warning rather than a success claim.

## WhatsApp and memory ownership

The WhatsApp adapter resolves the exact configured sender before creating a session, reading memory, handling commands, or downloading media. It retains the existing transcription, quoted-context, emotion, typing, bubble, and session-reset modules. Approval answers bypass the conversation queue but still require the matching principal and channel.

An optional `trustedWhatsAppOwner` entry on a configured principal binds a display name to an exact subset of that principal's WhatsApp aliases. Only ingress from one of those aliases receives the owner identity as private conversational context. This is presentation context: it does not change the principal's policy role, session ownership, approvals, or tool authority. Unlisted aliases cannot claim the identity through message text.

For a screenshot request, the adapter supplies a unique output path for that admitted operation. DSH remains responsible for taking the screenshot through its normal tool and approval path. After the turn settles, the adapter reads only that operation's regular PNG file beneath `.runtime/whatsapp-outbound`, checks its size and PNG signature, then sends it as a WhatsApp image to the same trusted sender. Cancellation fences this send. A missing, invalid, or undeliverable image yields an explicit failure reply instead of a claim that delivery succeeded. The adapter does not turn a model-supplied arbitrary path into an outbound attachment.

For DOCX, PDF, and XLSX, the adapter extracts bounded text from an incoming WhatsApp attachment and marks that text as document data in the DSH turn. XLSX extraction lists sheet names and cell coordinates and distinguishes formulas from cached results without recalculating them. DSH still owns any subsequent read or edit tool call and its approval. The optional local Python helper performs exact text replacement or a typed XLSX cell edit into a new file; it does not modify the original or send data. It refuses complex XLSX features whose preservation is uncertain. A verified owner request to send a document receives a unique output path under `.runtime/whatsapp-outbound`. After the DSH turn, the adapter checks the operation's path, file identity, size, signature, and parseability, then sends the bytes to that same WhatsApp sender. A missing output or uncertain transport result cannot be reported as a confirmed delivery. Scanned PDFs have no extractable text without OCR, PDF replacement can change layout, and XLSX formulas need recalculation by a spreadsheet engine after editing.

For incoming PNG/JPEG/WEBP photos and PDF pages with little selectable text, the adapter invokes the local OCR worker inside the admitted direct operation. The worker uses the existing `.runtime/document-tools-venv`, pinned RapidOCR/ONNX packages, and bundled local model files. It receives bounded bytes over stdin, renders at most 12 scanned PDF pages, enforces image pixel and output limits, and returns text without persisting source or OCR output. OCR text is marked as untrusted image data before the DSH turn. Abort kills only that owned worker and waits for its process close; stale OCR cannot submit a model turn or deliver a reply. Text PDF pages still use the existing PDF extractor. Missing or failed OCR yields an explicit incomplete-reading marker, rather than a claim that a scan was understood.

An explicit owner WhatsApp request to download a public file URL is handled by the channel adapter as a session-scoped direct operation. The link comes from trusted ingress, not model output. `link-download.ts` enforces HTTPS on port 443, pins each connection to a validated public IPv4 DNS result, rechecks redirects, limits the response to 25 MB, and writes only to a unique path under `.runtime/downloads/elara/`. The result is returned as a WhatsApp document to the same sender. No automatic execution follows. The control service tracks the transfer's AbortSignal and settlement for `.stop`; an in-flight transport send is reported as unconfirmed if stop races it. Audit observations use generated correlation IDs and omit URLs and file contents. Audit failure before dispatch prevents the transfer.

An explicit owner request to create XLSX also receives the operation-scoped outbound path. DSH may invoke the reviewed local document helper with a column list or bounded JSON specification. The helper creates a new workbook with typed columns and restrained default formatting, verifies the saved headers, and refuses to overwrite an existing file. The adapter still validates the final XLSX and owns WhatsApp delivery; the helper does not send a message or grant itself tool authority.

The WhatsApp adapter also owns a small local timer and SQLite store for owner conversation starters and reminders. A due proactive event enters the owner's existing conversation queue, admits the current session generation, and asks the existing DSH agent for one short message. A persisted last-kind field rotates between follow-up, curiosity, playful choice, thought, and check-in prompts without repeating the same kind consecutively. It creates no second agent runtime or durable model-task queue. A scoped pre-execute listener and final tool guard deny all tool calls by that proactive turn and its runtime-owned descendants. The reply is sent only if the session generation, owner alias, connection, feature setting, and last incoming-message timestamp still match. The owner can disable or re-enable spontaneous chats; no other principal receives them.

Reminder inference is deterministic and limited to clear owner statements with a concrete time. Ambiguous conversational text stays in the normal model path. Explicit `.remind` continues to work for configured senders. Reminder rows hold a hashed sender key, principal, due time, source message ID, and the reminder text required for delivery; they are not policy audit rows. A sender can list and cancel only their own pending rows. On restart an unfinished send is retried, so delivery is at least once rather than exactly once across a crash. The timer runs only while the WhatsApp connection is open and is disposed with the adapter.

Memory queries and mutations use the access principal ID as the owner. Migration of older ownerless rows preserves them under the reserved `__elara_unattributed__` owner, which normal API calls cannot use. A previous shared `legacy` owner is quarantined the same way. A later migration may attribute a record only from independent evidence of ownership. The DSH model tool for storing memory remains policy-denied pending a separate review.

Reminder rows additionally retain the original due time, next delivery time, send count, message limit, and last tone. After each successful send, the next delivery is scheduled 1–5 minutes later until the same authorized sender replies or the randomly chosen 3–7 message limit is reached. An ordinary incoming message acknowledges already delivered reminders before the conversation queue starts; approval reactions and control commands do not count as reminder replies. The existing DSH agent composes each reminder under a scoped no-tool guard. The admission generation is captured before entering the sender queue, and a reply or stop fences delivery after model work. Model failure defers the send without counting a delivery. The schema migration adds columns in place and preserves prior rows.

## Hermes project pilot boundary

The Hermes project pilot is an optional client of the existing session-control service. A verified WhatsApp owner may create one synthetic project job; ELARA binds a separate owner-only `hermes:<id>` session, audits dispatch before calling the transport, and tracks the remote wait as direct work. `.stop` requests cancellation of both the DSH conversation and that project job. The client accepts only an authenticated loopback Hermes API and validates run IDs and status shapes. A remote `stopping` response is only an acknowledgment. A remote `cancelled` result does not verify descendant termination, so the HTTP client leaves the project stop unconfirmed and blocks a new Hermes job. Only the synthetic test transport can verify termination of its exact owned fixture process and obtain `stopped`. Task text, tool arguments, paths, and Hermes output are excluded from the policy audit.

Only the synthetic adapter is wired into the WhatsApp runtime for the pilot. Live Hermes dispatch is disabled because the installed host lacks a verified isolated project workspace and an ELARA approval bridge for Hermes tool calls. The fixture copies a small project into a temporary directory, makes a harmless edit, and runs its test. The Hermes Agent HTTP adapter is implemented and contract-tested separately; it is not a second ELARA scheduler or the authority for WhatsApp identity and stop status.

## P2C session control and audit

`elara-control` is a small coordinator around live DSH agents. Trusted WhatsApp sender aliases and the dashboard bearer token supply the principal and channel. The service checks the immutable session binding before every stop request, status poll, and audit read. A stop advances a per-session generation before cancellation, so work admitted before the request cannot submit a turn or deliver a reply afterward. While stop is pending, new work for that session is rejected. A fresh explicit input after settlement may start work at the new generation. Other sessions keep their own generation and queue.

The coordinator cancels pending approval questions, revokes live one-time grants, marks previously admitted tool calls stale, then calls `Agent.cancel({ kind: 'user' })` on the root and its live runtime-owned descendants. It also aborts direct status operations admitted for the session, including when no agent exists. Direct operations retain their original ingress generation; completion and replies are fenced after awaits. It does not preserve the old DSH inbox. `whenIdle()` is observed outside DSH lifecycle callbacks. The stop endpoint returns a request ID immediately; `stopping` means only that cancellation was requested. `stopped` requires DSH quiescence and settlement of tracked local and direct operations. A 15-second wait that cannot be confirmed becomes `unconfirmed`, and that session remains closed to new work. A late verified settlement can advance it to `stopped`. A remote-status wait aborted locally remains `unconfirmed`; it says nothing about remote execution. There is no remote mutation or kill protocol.

Local project commands receive the DSH abort signal. On Windows, ELARA invokes `taskkill /PID <owned-pid> /T /F` only for the process it spawned, snapshots the process tree through CIM, and checks the captured PIDs and creation times after termination. A failed snapshot, kill, or verification reports unconfirmed. This does not roll back completed side effects.

The existing SQLite control database gains an additive `audit_events` table at schema version 1. Records contain only correlation IDs, bound identities, known capability or tool names, policy version, event and reason codes, structured outcome, and timing. The projection rejects unsafe fields at the storage boundary; prompts, arguments, approval previews, paths, output, and raw exceptions are excluded. On restart, unfinished prior-process observations become `unknown`; a prior stop ID can be polled as `unconfirmed`, and that session remains closed to new work. No operation is replayed and no approval is restored. Audit storage failure denies new sensitive dispatch and surfaces degraded health, while a stop still proceeds and logs only a redacted diagnostic. DSH's session log remains the execution authority; audit rows are observations.

The dashboard exposes `POST /api/sessions/:id/stop`, `GET /api/stops/:id`, and `GET /api/sessions/:id/audit?cursor=&limit=`. Unknown and unauthorized identifiers receive the same not-found response. WhatsApp `.stop` bypasses the conversation queue and targets only the sender's current bound session. Rollback removes P2C plugin registrations and code changes while preserving the control database, including its audit table; do not drop or rewrite prior policy records or session bindings.
