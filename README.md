# ELARA

**Personal AI Computer Assistant — Developed by Tan**

ELARA is a local-first, cloud-ready personal AI system built around **DeepSeek Harness (DSH)** as the single harness layer. The project adds ELARA-specific plugins and integrations instead of rewriting the harness core.

## Architecture

```text
WhatsApp (Baileys) ─┐
Telegram            ├──> ELARA Gateway ──> DeepSeek Harness ──> 9Router / Models
Laptop UI           ┘                           │
                                               ├─ Memory / Tasks / Skills
                                               ├─ Verification / Policy
                                               └─ ELARA plugins
                                                       │
                                                       ▼
                                                Windows Companion
                                                       │
                                                       ▼
                                                   Your PC
```

## Design rules

1. **Reuse first, adapt second, rewrite last.**
2. DSH remains an upstream runtime; ELARA changes live in plugins/adapters.
3. The laptop executor is treated as a separate trusted device boundary.
4. Remote commands never become an unrestricted Windows shell by default.
5. Local mode must be able to become cloud mode without changing the device protocol.
6. OwnHermes V2 is optional and is not the foundation of ELARA.

## Current status

The repository contains P2B one-time approvals and P2C session-scoped cancellation with a redacted audit trail. The existing `profiles/local/cordis.patch.yml` must load `elara-access` and `elara-control`, and the private access configuration must include `authorities.hostDeviceId` before the local runtime can use them. Bootstrap adds the control plugin to an existing access-enabled patch. No upstream DSH source is vendored; the pinned runtime is cloned into ignored `.runtime/` during local bootstrap.

## Prerequisites

DeepSeek Harness currently documents Node.js **22.19+ or 24+**, pnpm 11.7.0 via Corepack, and Git 2.26+. Native Windows development is supported; WSL2 is optional. The current DSH development guide documents Node 22.19+ or 24+ and pnpm 11.7.0. See the official development guide before bootstrapping. 

## Local bootstrap

From PowerShell:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\bootstrap-local.ps1
```

The bootstrap script clones the official DeepSeek Harness repository into `.runtime/deepseek-harness`, installs its dependencies, and creates an ELARA patch overlay without modifying the upstream source tree.

## Run

```powershell
.\scripts\run-local.ps1
```

The first milestone is deliberately small: prove that ELARA can load as a DSH plugin, expose an ELARA identity, and report Windows system status.

## Planned channels

- WhatsApp via Baileys
- Telegram Bot API
- Laptop dashboard
- Future cloud gateway

## Planned device model

```text
ELARA Cloud/Server
        │
        │ secure authenticated channel
        ▼
ELARA Companion (Windows)
        │
        └── local computer capabilities
```

## License

ELARA-specific code in this repository: MIT.
DeepSeek Harness remains upstream software under its own MIT license and notices.

## P2B approvals

ELARA routes reviewed host writes, edits, shell/code calls, and project actions through DSH's approval service during an active agent turn. The dashboard shows pending requests with the exact tool arguments and target device. WhatsApp offers reactions, quoted replies, and `.approve <id>` or `.reject <id>` as fallbacks. Each answer expires after two minutes and applies to one live tool call. Closing the turn, aborting the call, restarting, or losing the answer channel fails closed.

Dashboard project buttons require a dashboard-owned agent session ID. They submit a request to that agent; the HTTP endpoint does not execute a tool directly. The dashboard token cannot answer a WhatsApp approval, and an unrelated WhatsApp identity cannot answer another user's request. DSH's sandbox check for the same tool call reuses ELARA's answer and does not ask twice.

The verified WhatsApp owner can send `.auto on` to allow reviewed local writes, edits, shell/code calls, and project actions without repeated approval prompts in that session. `.auto status` reports the setting; `.auto off` restores one-time approval. The mode ends on `.stop`, `.new`, or DSH restart. Turning it on cancels an approval already waiting, so resend that request. It does not override policy denials, enable companion mutation, grant dashboard or other WhatsApp users access, or persist across restarts. Mode changes and dispatch decisions are recorded in the redacted audit. If durable audit is unavailable, enabling the mode and new sensitive dispatch fail closed.

P2A restrictions remain: `glob` and `grep` are disabled, private reads still require a later reviewed path, link/junction traversal is denied, companion mutation remains disabled, and cloud mode cannot execute native host tools. `profiles/local/access.json` must define `authorities.hostDeviceId`.

An approved shell or code command has broad host access during that one invocation; review its full arguments before allowing it. The path classifier cannot constrain what an arbitrary script reads after approval.

WhatsApp keeps voice-note transcription, quoted-message context, adaptive typing, explicit session reset, and its memory commands behind exact sender authorization. Memory rows are scoped by the configured principal ID. Older rows without trustworthy ownership remain preserved under a reserved, inaccessible owner; they are never assigned to a guessed user. The model-facing `elara_store_memory` tool remains denied by P2A until a separate policy review authorizes it.

### DOCX, PDF, and XLSX over WhatsApp

Incoming DOCX, PDF, and XLSX attachments (up to 25 MB) are downloaded through the existing trusted WhatsApp session and their text is included in the DSH turn as untrusted document content. Extraction is limited to 30,000 characters, the first 50 PDF pages, or the first 20 XLSX sheets with up to 200 rows and 50 columns per sheet. XLSX previews identify sheet names, cell addresses, formulas, and cached results when present. They do not calculate formulas. The original attachment stays available to DSH as a file attachment.

Run `npm run setup:ocr` once to install pinned RapidOCR and ONNX Runtime into the existing local document environment. ELARA then reads text from incoming PNG/JPEG/WEBP photos and uses OCR for PDF pages without selectable text, up to 12 scanned pages from the first 50 pages. Images are limited to 20 million pixels and OCR output to 30,000 characters. The OCR worker receives bytes through stdin, runs locally, and does not save an OCR copy. It cannot promise perfect recognition of handwriting, small text, or exact numbers; unreadable or unprocessed pages are marked as incomplete. `.stop` cancels the worker and fences the reply. Run `npm run test:ocr` with synthetic fixtures to verify the installed models.

For local read or exact text replacement, run `npm run setup:documents` once. This installs pinned `python-docx`, `PyMuPDF`, and `openpyxl` into `.runtime/document-tools-venv` and does not change the system Python environment. The model can invoke `scripts/document-ops.py read --input <path>` or `replace --input <path> --output <new-path> --old <text> --new <text>` through DSH's existing reviewed tool and approval path. For XLSX, `set-cell --input <path> --output <new-path> --sheet <name> --cell <A1> --value <value> --type <text|number|boolean>` edits one cell in a new workbook. The helper preserves untouched formulas and requests recalculation when Excel next opens the file; it does not calculate fresh results itself. Editing a formula cell or a workbook with drawings, charts, pivots, slicers, embeddings, or external links is refused to avoid losing those features. Complex DOCX content, scanned PDFs, and PDF layout changes may require manual editing or review. Run `npm run test:documents` to test all three formats with synthetic files.

To create a formatted XLSX with named columns, use `scripts/document-ops.py create-xlsx --output <new.xlsx> --title <title> --columns "Tanggal,Nama,Status,Catatan"`. For populated sheets, pass `--spec <spec.json>` with a title, sheet name, typed columns (`text`, `integer`, `number`, `currency`, `percent`, `date`, or `boolean`), and rows keyed by column. ELARA chooses columns from the request and leaves unknown data blank. The resulting workbook has a title band, styled column headers, fitted widths, alternating row fills, filter, frozen headers, print settings, and typed date/number formats. Text beginning with `=` remains text. Creating or sending a workbook still follows the DSH tool policy and the owner-only WhatsApp outbound path.

When the verified owner asks to send a DOCX, PDF, or XLSX, ELARA gives the DSH turn a unique output path for that request. The WhatsApp adapter checks the file type, size, parseability, and exact operation path before sending its bytes to the same sender. A missing or invalid output is reported as a failure; the model cannot choose an arbitrary local file for outbound delivery. A send without a confirmed WhatsApp message ID is reported as unconfirmed. Cancellation fences file reading and reply delivery. These checks do not override P2A denials or one-time approval requirements for document editing.

### File links from WhatsApp

The verified owner can send `unduh https://example.com/file.pdf` or `.download https://example.com/file.pdf`. A link alone does not start a download. ELARA accepts one direct public HTTPS file URL per request, limits the response to 25 MB, and supports PDF, DOCX, XLSX, TXT, CSV, JSON, ZIP, PNG, JPG, and WEBP. Redirects and DNS answers are checked again before each connection; local, private, and IP-literal destinations are rejected. It saves a uniquely named copy under `.runtime/downloads/elara/` and sends the file back to that same WhatsApp sender. Files are never opened or executed automatically. `.stop` aborts the owned transfer and fences the reply; an already initiated WhatsApp send can remain unconfirmed. Audit records carry operation and execution IDs but no URL, query string, file bytes, or file path. If durable audit fails before dispatch, no download starts. This path uses the existing session-control service, without an additional agent loop or scheduler.

The verified WhatsApp owner can receive an occasional spontaneous message from ELARA without sending a new message first. ELARA varies between a specific follow-up, a light question, a playful choice, a short thought, and a check-in; it avoids repeating the same type consecutively. This is enabled for that owner by default, waits a random 4–18 hours after the last incoming message, and has no quiet-hour restriction. `.inisiatif off`, `.inisiatif on`, and `.inisiatif status` control it. The same DSH agent composes the message; tool calls are blocked for that proactive turn. A new incoming message, `.stop`, or disabling the feature fences an unfinished proactive reply. Other WhatsApp users never receive spontaneous chats.

A clear owner plan with a concrete time, such as `besok jam 8 rapat` or `ingetin aku 30 menit lagi minum air`, schedules a reminder and gets a confirmation with its time. Questions, vague plans, and third-party plans do not auto-schedule. Explicit `.remind 10m <pesan>` and `.remind HH:MM <pesan>` remain available for authorized senders; `.remind list` and `.remind cancel <id>` manage only that sender's reminders. Reminders survive DSH restart in the local `.runtime/whatsapp-autonomy.db`; the database contains the reminder text needed for delivery and is separate from redacted policy audit. A transport send is not proof the phone displayed the message, and a crash between send and settlement can cause a retry.

Run `npm test` for baseline, access, approval, and adapter coverage; run `npm run verify` for the consolidated gate including type, scaffold, Windows command, and dashboard checks. Runtime tests use synthetic profiles and data, and do not activate the existing local profile.

The existing DSH agent writes each reminder message in ELARA's conversational style, with varied tone on follow-ups, including gentle, playful, mildly annoyed, or resigned. Without a reply, reminders repeat after random 1–5 minute gaps for a random total of 3–7 messages. An ordinary reply from that exact sender acknowledges all of their already delivered reminders; other senders cannot acknowledge them. The original reminder time remains visible in the list. Existing reminder rows are migrated in place. If the model cannot produce a reminder, the adapter retries later without claiming it was delivered.

## P2C stop and audit

Send `.stop` from a configured WhatsApp identity to stop its current session. In the dashboard Sessions view, use **Stop** and watch the request status. `stopping` is a request in progress; `stopped` is confirmed settlement; `idle` means no live agent or direct operation was active; `unconfirmed` means termination could not be verified. The dashboard **Audit** button shows redacted, paginated history for the authorized session. The HTTP equivalents are `POST /api/sessions/:id/stop`, `GET /api/stops/:id`, and `GET /api/sessions/:id/audit` with the existing bearer token.

P2C uses DSH agents and does not schedule or replay work. Its generation fence drops older queued messages, stops pending approvals, and blocks stale grants. Direct WhatsApp and dashboard status operations carry the same session generation and cancellation signal; their results are fenced before reply delivery. Local subprocesses receive cancellation; project command trees are targeted by their owned PID on Windows and verified before a stopped result is claimed. Aborting a companion status wait does not prove that remote work stopped. Audit rows are added to the existing control database without removing bindings or policy records. Rollback should reverse P2C code and plugin registration only and retain the database.

`npm run test:control` runs focused offline control and audit tests. `npm run verify:p2b` remains the full compatibility gate. These offline checks do not establish live readiness for a real WhatsApp account, user profile, companion, or unsandboxed project command.
