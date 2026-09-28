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

The verified owner can send `.settings` in WhatsApp for a compact settings menu. `.settings emotion auto|0|1|2|3|4|5` and `.settings typing instant|fast|natural|slow` take effect immediately and persist across restarts. `.settings initiative on|off` controls spontaneous chats; `.settings auto on|off` uses the existing session-scoped auto-mode guard. The menu also reports voice, Google Calendar, and Hermes availability. The preferences file migrates the earlier emotion-only format when a setting is saved. Connection credentials, model/provider setup, device authority, and policy remain local configuration; the WhatsApp menu never displays their secret values.

The owner can manage **chat-only WhatsApp members** with `.settings users list`, `.settings users add 6281234567890`, and `.settings users remove 6281234567890`. Legacy `.allowlist`, `.add`, and `.del` are aliases for those commands. A managed member can chat and stop their own session but cannot dispatch tools, use owner features, change settings, or manage other users. Membership is stored additively in the existing control database and takes effect without restarting DSH. Removal fences queued/model replies and requests DSH cancellation; the acknowledgment reports when settlement is still pending. Re-adding a number creates a new principal and session scope. Existing principals configured locally retain their reviewed permissions and cannot be changed by these commands. The older `.runtime/whatsapp-allowlist.json` file is preserved but no longer treated as an access authority.

P2A restrictions remain: `glob` and `grep` are disabled, private reads still require a later reviewed path, link/junction traversal is denied, companion mutation remains disabled, and cloud mode cannot execute native host tools. `profiles/local/access.json` must define `authorities.hostDeviceId`.

An approved shell or code command has broad host access during that one invocation; review its full arguments before allowing it. The path classifier cannot constrain what an arbitrary script reads after approval.

WhatsApp keeps voice-note transcription, quoted-message context, adaptive typing, explicit session reset, and its memory commands behind exact sender authorization. Memory rows are scoped by the configured principal ID. Older rows without trustworthy ownership remain preserved under a reserved, inaccessible owner; they are never assigned to a guessed user. The model-facing `elara_store_memory` tool remains denied by P2A until a separate policy review authorizes it.

### Balasan voice note

Nomor owner terverifikasi dapat meminta jawaban suara dengan `.voice <pesan>` atau permintaan jelas seperti “jawab pakai voice note”. ELARA membuat jawaban melalui DSH, lalu adaptor WhatsApp mengirim audio Ogg Opus sebagai voice note ke pengirim yang sama. Pesan biasa dan voice note yang masuk tetap dibalas sebagai teks kecuali diminta suara. `.stop` membatalkan sintesis yang masih berjalan dan menahan balasan lama; pengiriman WhatsApp yang sudah dimulai dapat berakhir *unconfirmed*. Permintaan dari nomor lain tidak dapat menggunakan fitur ini.

Di Windows, pengaturan bawaan menggunakan suara perempuan lokal dari `System.Speech` dan `ffmpeg` tanpa mengirim teks ke layanan TTS. Suara lokal yang tersedia di perangkat ini berbahasa Inggris, sehingga pelafalan Indonesia dapat kurang alami. Untuk suara perempuan Indonesia, siapkan Azure Speech milik sendiri, lalu set `ELARA_TTS_PROVIDER=azure`, `ELARA_AZURE_SPEECH_REGION`, dan `ELARA_AZURE_SPEECH_KEY` sebagai environment variable sebelum memulai DSH. Suara bawaan cloud adalah `id-ID-GadisNeural`; `ELARA_TTS_VOICE` dapat memilih suara `id-ID` lain. Teks jawaban dikirim ke Azure dan penggunaan layanan mungkin dikenai biaya. Jangan simpan kunci di repo atau kirim melalui chat. Mulai ulang DSH setelah mengubah provider. `npm run test:voice` memeriksa sintesis lokal dan jalur cloud dengan respons sintetis; tampilan voice note pada akun WhatsApp nyata belum diverifikasi.

### Mode proyek Hermes — prototipe offline

Adaptor WhatsApp mengenali `.hermes run <tugas>`, `.hermes status`, `.hermes review`, dan `.hermes stop` hanya dari alias owner tepercaya. `.stop` juga meminta penghentian tugas Hermes milik owner itu. Tugas Hermes memiliki sesi kontrol sendiri sehingga stop dan auditnya tidak mengambil alih sesi chat DSH. Persetujuan Hermes yang belum terhubung ke ELARA menyebabkan permintaan stop, bukan persetujuan otomatis. Status `cancelled` dari API Hermes belum membuktikan semua proses turunannya berakhir; tanpa verifikasi proses milik tugas itu, ELARA menandai penghentian *unconfirmed* dan menahan tugas berikutnya. Fixture tes memiliki verifikasi proses miliknya sendiri, sehingga dapat menguji hasil *stopped* yang benar-benar teramati. Audit hanya menyimpan ID, kejadian, alasan, hasil, dan waktu; isi tugas dan laporan tidak masuk ke tabel audit.

Prototipe ini hanya aktif dalam fixture tes dengan adaptor Hermes sintetis. `tests/fixtures/hermes-project/` adalah proyek contoh; tes membuat salinan sementara, menambah fungsi dan tes sederhana, lalu menjalankan tes Node pada salinan itu. `HermesHttpTransport` memvalidasi API loopback yang terautentikasi untuk start, status, dan stop, tetapi belum dihubungkan ke profil WhatsApp nyata. Pada instalasi ini Hermes Agent v0.21.2 tersedia, sementara Docker untuk isolasi proyek belum tersedia. Karena API Hermes menjalankan alatnya sendiri, teks instruksi “tetap di folder proyek” tidak membatasi akses host. Aktivasi nyata memerlukan profil Hermes terisolasi per proyek, sambungan persetujuan satu kali melalui ELARA, dan verifikasi penghentian proses sebelum dapat melaporkan stop terkonfirmasi. `npm run test:hermes-project` dan `npm run test:runtime` memeriksa kontrak prototipe tanpa kredensial, proyek asli, atau pesan WhatsApp nyata. Ini integrasi Hermes Agent; nama OwnHermes V2 yang disebut pada aturan desain belum diasumsikan sebagai produk yang sama.

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

### Google Calendar untuk pengingat owner

ELARA dapat membuat acara di kalender utama Google dari rencana owner WhatsApp yang waktunya jelas dan dari `.remind`. Acara mendapat ID deterministik dari identitas tepercaya dan ID pesan, sehingga retry tidak membuat acara ganda. Hanya acara yang dibuat ELARA yang diperiksa; perubahan waktu/judul di Google memperbarui pengingat WhatsApp, dan penghapusan acara membatalkannya. `.remind cancel <id>` juga menghapus acara terkait. Pemeriksaan berlangsung sekitar setiap 5 menit saat DSH dan WhatsApp tersambung. Durasi acara baru adalah 30 menit; pengingat Google bawaan dimatikan agar WhatsApp tetap menjadi saluran pengingat. Perubahan sangat dekat dengan waktu pengingat bisa terlambat terlihat karena interval pemeriksaan.

Untuk menghubungkan akun di Windows:

1. Di Google Cloud Console, aktifkan Google Calendar API dan buat OAuth client bertipe **Desktop app** untuk akun sendiri. Konfigurasikan OAuth consent screen dan masukkan akun sebagai test user bila aplikasinya masih dalam mode testing.
2. Simpan JSON client yang diunduh sebagai `.runtime/google-calendar-client.json` di direktori proyek. File dan seluruh `.runtime` diabaikan Git. Jangan menempelkan JSON atau token ke chat.
3. Jalankan `npm run calendar:connect` dari direktori proyek. Buka URL yang ditampilkan, pilih akun Google, lalu beri izin lewat halaman Google. Callback hanya mendengarkan `127.0.0.1` selama 5 menit. Refresh token disimpan sebagai `.runtime/google-calendar-token.dpapi`, dienkripsi untuk akun Windows yang menjalankan perintah.
4. Mulai ulang DSH dan cek `.calendar status` dari nomor owner. Koneksi belum diuji langsung sampai acara pertama disinkronkan. Jika izin Google dicabut atau token tidak berlaku, jalankan langkah 3 lagi.

Tanpa koneksi Google, pengingat lokal tetap bekerja dan balasan menjelaskan bahwa kalender belum terhubung. Saat jaringan atau audit bermasalah, tautan kalender tetap menunggu retry; ELARA tidak mengklaim acara telah tercatat. Stop membatalkan operasi lokal yang sedang menunggu dan menahan balasan lama; jika Google mungkin sudah menerima mutasi sebelum pembatalan, hasil stop tetap *unconfirmed* dan perlu pemeriksaan acara di kalender. Tidak ada operasi Google yang dijalankan untuk nomor non-owner. Data pengingat dan ID acara berada di database lokal `.runtime/whatsapp-autonomy.db`; audit kebijakan hanya menyimpan ID korelasi, jenis kejadian, dan hasil, tanpa judul acara atau token.

Migrasi hanya menambah tabel `whatsapp_calendar_links` pada database pengingat. Untuk rollback kode, hapus integrasi kalender dari plugin dan pertahankan database serta file token; jangan menjatuhkan tabel atau mengembalikan database lama. Koneksi akun Google harus dicabut dari pengaturan akun Google jika tidak ingin ELARA punya akses lagi.

## P2C stop and audit

Send `.stop` from a configured WhatsApp identity to stop its current session. In the dashboard Sessions view, use **Stop** and watch the request status. `stopping` is a request in progress; `stopped` is confirmed settlement; `idle` means no live agent or direct operation was active; `unconfirmed` means termination could not be verified. The dashboard **Audit** button shows redacted, paginated history for the authorized session. The HTTP equivalents are `POST /api/sessions/:id/stop`, `GET /api/stops/:id`, and `GET /api/sessions/:id/audit` with the existing bearer token.

P2C uses DSH agents and does not schedule or replay work. Its generation fence drops older queued messages, stops pending approvals, and blocks stale grants. Direct WhatsApp and dashboard status operations carry the same session generation and cancellation signal; their results are fenced before reply delivery. Local subprocesses receive cancellation; project command trees are targeted by their owned PID on Windows and verified before a stopped result is claimed. Aborting a companion status wait does not prove that remote work stopped. Audit rows are added to the existing control database without removing bindings or policy records. Rollback should reverse P2C code and plugin registration only and retain the database.

`npm run test:control` runs focused offline control and audit tests. `npm run verify:p2b` remains the full compatibility gate. These offline checks do not establish live readiness for a real WhatsApp account, user profile, companion, or unsandboxed project command.
