# MemoryCentral Dashboard

_Last synced: 2026-05-20 06:59 UTC_

---

## ai-test

_synced: 2026-05-20T06:59:27Z | files: 8_

# Memory Index

- [ollama-images skill](project_ollama_images_skill.md) — Local Ollama image gen skill, MLX fix, model limits, prompt tips
- [OPNsense Status LED Indicator](project_opnsense_status_leds.md) — ESP32 + WS2812B wall panel showing gateway/WAN/CPU status via ESPHome + OPNsense API
- [Network Redesign — Bridge + Switch Reorg](project_network_redesign.md) — 8-port 2.5GBe cabinet switch + OPT1 bridged to LAN for dedicated study room uplink, full OPNsense config steps
- [Kodi TMDb Scraper Proxy Fix](project_kodi_scraper_proxy_fix.md) — Both TMDb scrapers patched to route via Gluetun HTTP proxy (192.168.69.23:8888); reapply if addon updates overwrite api_utils.py
- [AI Prompt Writing Guide](reference_ai_prompt_guide.md) — Team guide for efficient AI prompting: base template, formatting rules, common mistakes; file at ai-test/ai-prompt-guide.md
- [CachyOS Migration Plan](project_cachyos_migration.md) — AMD gaming PC migration from Bazzite; Desktop Edition + Gamescope session for boot-to-Steam; WiFi DKMS fix; full guide at ai-test/linux-distro-research-cachyos.md
- [LXC + systemd + CIFS Lessons](feedback_lxc_systemd_lessons.md) — Hard-won debugging lessons: no FUSE in LXC, Conflicts= loop, stale CIFS detection, ping unreliable for WoL, poll don't sleep

---

## Bond-N-Brick

_synced: 2026-05-20T06:59:27Z | files: 3_

# Bond N Brick — Memory Index

- [Brand Identity & Guidelines](project_bnb_brand.md) — Oceanic finalized; colors, fonts, logo variants, 300DPI vs 72DPI asset conventions
- [Cube Logo Concept](project_bnb_cube_logo.md) — Explored & abandoned; needs vector designer to execute properly

---

## HA-Scripts

_synced: 2026-05-20T06:59:27Z | files: 5_

# MEMORY.md

- [Yogi - User Profile](user_profile.md) — homeowner, knows HA well, skip basics, go straight to YAML
- [Automation Playground - Completed Files](project_automations.md) — all 11 automations built/reviewed Apr 2026, purpose + key design decisions
- [Key Entity & Device Map](project_entities.md) — named entity_ids for lights, climate, media players, switches, sensors
- [HA Automation Conventions & Preferences](feedback_conventions.md) — patterns Yogi prefers: named entities, debounce, HA start trigger, wait_for_trigger timeout

---

## inspector

_synced: 2026-05-20T06:59:27Z | files: 5_

# Inspector Project Memory

## Architecture: EDWARD Sidecar Services

Three Node.js sidecars run alongside Laravel, each wrapping an official AI SDK:

| Service | Port | SDK | Session ID prefix |
|---|---|---|---|
| `claude-agent` | 3001 | `@anthropic-ai/claude-agent-sdk` | UUID |
| `openai-agent` | 3002 | `@openai/agents` | `conv_` |
| `gemini-agent` | 3003 | `@google/adk` + `@google/genai` | cached by session ID |

All share: SSE via `createSSEWriter`/`startHeartbeat`, `agentLoader` fetching from Laravel API, security tiers, user context injection, UX guidelines, `[EXECUTE_WORKFLOW:id:message]` detection.

### Dockerfile Pattern (critical for all three sidecars)
- Build mirrors `services/` structure: `WORKDIR /build/<service-name>`
- Symlink required: `ln -s /build/<service>/node_modules /build/shared/node_modules`
  (shared/ imports gray-matter etc. from the service's own node_modules)
- `rootDir: ".."` in tsconfig → compiled entry at `dist/<service>/src/index.js`
- Runtime CMD: `node dist/<service>/src/index.js`

### Gemini ADK Notes
- `GoogleSearchTool` cannot be mixed with MCPToolset/FunctionTool (Gemini API limitation)
- Agent names must be sanitized: spaces/hyphens → underscores (`sanitizeAgentName()`)
- Streaming: `StreamingMode.NONE` with event iteration via `processEvent()`
- Tool mapping in `definitions.ts`: `WebSearch` → `GoogleSearchTool`

## References
- **Contributing Guide** (branching, PRs, commit conventions): https://github.com/tandem-theory/inspector/blob/dev/CONTRIBUTING.md → `memory/reference_contributing.md`

## Git Workflow
- PRs always target `dev` branch
- Branch naming: `type_description_username` (e.g. `feature_gemini-service_yogi`, `bugfix_copy-highlight_yogi`)
- `dev` → staging, `main` → production
- **Before reading any code**: `git checkout dev`
- **Before creating any branch**: run `gh auth status` — if active account is not `yogi-gharat`, switch with `gh auth switch --user yogi-gharat`
- **Before writing any code**: create a new branch (`bugfix_*_username` for bugs, `feature_*_username` for features)
- **After creating a PR**: comment on the BugHerd ticket with the PR number/branch, then update status to `READY FOR REVIEW/QA`

## Recent Tasks
- **260518**: BugHerd #347/#348 — both largely fixed by Michael's PR #358 (merged May 10) before our session. Created PR #400 (`bugfix_render-plain-newlines_yogi`) for the one residual gap: `_renderUserPlain()` in `edward-streaming-ui.js` didn't convert `\n` → `<br>`, collapsing Shift+Enter line breaks in plain-text messages. One-liner fix + new test in `ChatInputRenderingTest.php`. Also applied PR #358's MEDIUMTEXT migration to `tenant_testtenant` to clear 3 pre-existing test failures. BugHerd #347 + #348 → READY FOR REVIEW/QA.
- **260518**: PR #350 UI fixes — swapped bell → `rocket-launch` icon on Edward toolbar button; fixed "Mark all read" button crashing into Flux flyout close (×) by moving it below the panel title. Also updated panel header icon from `bell` to `rocket-launch`. Pushed to `feature_edward-release-notes_yogi`.
- **260518**: BugHerd #325 **DONE** — PR #403 open (`bugfix_mcp-tool-id-cleanup_yogi` → `dev`), READY FOR REVIEW/QA. Stripped top-level `'id'` keys from all 36 McpToolDefinitions files (329 entries); fixed deprecated tool deletion to use natural keys; added `McpToolDefinitionsIntegrityTest` (2 tests, 288 assertions). `GoogleAdsTools.php` (Q1 / wire-in vs delete) deferred pending team input.
- **260511**: PR #350 review — applied Michael's test fix: swapped `User::factory()->create()` for seeded `test@example.com` user + added `tearDown()` cleanup in `ReleaseNotesApiTest`. 17/17 tests passing. PR still open, waiting for Michael to merge.
- **260507**: Edward Release Notes feature — platform-wide release notes authored by super-admins, rocket-launch badge + right flyout on Edward page. Timer-based auto-mark-read (`max(8s, wordCount/3.33)`, SVG ring progress). Full GFM via `graham-campbell/markdown`. 17 files, 17 tests (10 Livewire + 7 API), all passing. PR #350 open (`feature_edward-release-notes_yogi` → `dev`), READY FOR REVIEW/QA.
- **260507**: claude-agent Docker crash fix — **MERGED** (PR #349). `DEBUG_CLAUDE_AGENT_SDK: '1'` env crash + non-root container fix. Merged by Michael 2026-05-10.
- **260504**: BugHerd #337 Edward doc links — **MERGED** (PR #331). Michael applied all 4 review concerns himself during merge: `data.source !== 'canvas'` exclusion, filename `[]` escaping, `console.warn` on dropped links, `startsWith` URL check. Confirmed in dev at `edward-streaming-messages.js:4527`.
- **250224**: BugHerd batch — #302 variable insert at cursor (PR #146), #303/#304 Gemini MCP error swallowing (PR #147), #243 Files node animation jitter (PR #148)
- **250225**: BugHerd batch (PRs #153-#159) — #51 inspect campaign link, #46 null Slack webhook, #47 slow settings query, #299 error badge tooltip, #297/#298 Pusher payload size, #300 file upload JSON error, #306 files lost on clone + Google reconnect
- **250226**: BugHerd #305 results bleed across workflow versions, #187 LLM required fields validation, #164 file download staging fix (PR #166)
- **250303**: BugHerd triage — #234 docs→EDWARD link (PR #174), #128 already done (closed), #261 Lockbox/chat dead code cleanup (PR #175)
- **250304**: BugHerd #157 Domo chat access discoverability fix (PR #176)
- **250312**: BugHerd #58 + #60 — architecture investigation + plan files written (pending team review)
- **250316**: BugHerd batch — #247/#257/#272 Office file extraction (PR #195), #246/#255 Drive search auth + corpora fix (PR #196); #245/#258 investigated, plans written (pending team decisions)
- **250317**: BugHerd #258 `edward_create_document` (PR #198), #245 `edward_save_file` (PR #199) — both open, awaiting review
- **250323**: BugHerd #166 PII Filtering — pipeline investigated, draft plan written (`docs/plans/bugherd-166-pii-filtering.md`), comment posted; awaiting team decisions
- **250326**: PR review batch — addressed Michael's comments on PR #196 (Google Drive auth + fullText fix) and PR #195 (Office file extraction). Both pushed. PRs #151 (Trello rich cards) and #164 (security extension blocking) deferred to next session.
- **250327**: PR #151 + #164 — thorough investigation completed; detailed plans + clarifying questions posted as GitHub comments on each PR. Awaiting Michael's answers before implementation.
- **250330**: BugHerd #166 PII Filtering — plan rewritten (v2). Decisions made: regex-only confirmed, address detection deferred (regex precision <80% on real-world content, not viable for Phase 1). Three open questions (Q1: redact vs pass-through, Q2: default-on vs opt-in, Q3: Phase 1 MCP scanning scope) posted to team for consensus. Plan updated at `docs/plans/bugherd-166-pii-filtering.md`.
- **260406**: BugHerd #166 PII Filtering — all team decisions received. Plan fully rewritten (v3) at `docs/plans/bugherd-166-pii-filtering - v3.md`. Decisions: Q1=Block (hard stop, no bypass), Q2=On by default, Q3=Phase 1 + MCP results. Added false positive handling (admin override + whitelist patterns) and LLM API policy audit as pre-ship prerequisite (non-engineering owner needed).

---

## IPMSGX

_synced: 2026-05-20T06:59:27Z | files: 9_

# IPMsgX Project Memory

## Project Overview
Swift/SwiftUI port of IP Messenger (LAN messaging protocol) for macOS.
Built with Swift Package Manager — no Xcode project file.

- **Repo:** https://github.com/yogiee/IPMsgX (public, account: yogiee)
- **Git remote:** HTTPS (gh credential helper) — SSH maps to yogi-gharat, not yogiee
- **Build:** `bash scripts/build-app.sh release` → `build/IPMsgX.app` + `build/IPMsgX.dmg`
- **Current version:** 1.4.1 (build 9) — GitHub Release v1.4.1 is Latest (bug fixes: compose selection, receive window, stale users)
- **Release DMG:** drag-and-drop installer with Applications folder shortcut (hdiutil, no create-dmg)
- **Target:** macOS 15.0+, Apple Silicon + Intel

## Key Files
- `IPMsgX/Crypto/CryptoService.swift` — RSA key management, encrypt/decrypt, self-test
- `IPMsgX/Crypto/SymmetricCrypto.swift` — AES-256-CBC, Blowfish-128-CBC via CommonCrypto
- `IPMsgX/Crypto/RSAPublicKey.swift` — Manual ASN.1 DER encode/decode (replaces deprecated SecAsn1Coder)
- `IPMsgX/Services/MessageService.swift` — Protocol message handling (GETPUBKEY, ANSPUBKEY, SENDMSG)
- `IPMsgX/Services/SettingsService.swift` — UserDefaults-backed settings (incl. encryptionEnabled, cmdEnterToSend)
- `IPMsgX/Models/UserInfo.swift` — RSAPublicKeyInfo with keySizeInBits
- `IPMsgX/Protocol/IPMsgPacketBuilder.swift` — Packet building (incl. FP: fingerprint in BR_ENTRY)
- `IPMsgX/Protocol/IPMsgPacketParser.swift` — Packet parsing
- `IPMsgX/Views/Settings/NetworkSettingsView.swift` — Encryption toggle + Reset Keys button
- `IPMsgX/Views/ComposeToolbarButton.swift` — Shared SF-symbol toolbar button (hover highlight)
- `IPMsgX/Views/MessageRenderer.swift` — `sanitize()` strips NUL/BEL bytes; `render()` produces AttributedString, skipping markdown pipeline for plain text/emoji
- `IPMsgX/Views/AttachmentTextEditor.swift` — NSViewRepresentable text editor; routes file drops to attachment callback; handles Enter-to-send
- `IPMsgX/App/AppState.swift` — Observable app state; `requestCompose(user:)` sets `composePreselectedUser` + bumps `composeRequestToken` UUID; both `private(set)`
- `IPMsgX/App/AppCommands.swift` — Notification names + SendRequest Identifiable wrapper
- `IPMsgX/IPMsgXApp.swift` — App entry; `Window("compose")` + standalone `Window("receive")` scenes; `ReceiveWindowContainer` (sequential queue display, dismisses when empty); `MainWindowProxy`; `MenuBarLabel` (badge + arrival animation)
- `IPMsgX/Services/UpdaterService.swift` — `@Observable @MainActor` Sparkle wrapper; singleton `UpdaterService.shared`; 3 update modes; `checkForUpdates()` triggers Sparkle UI
- `IPMsgX/Views/Settings/UpdatesSettingsView.swift` — Updates settings tab (mode picker + "Check for Updates" button)
- `appcast.xml` — Sparkle RSS feed (hosted at `https://raw.githubusercontent.com/yogiee/IPMsgX/main/appcast.xml`); fill in per-release
- `scripts/build-app.sh` — Full app bundle + installer DMG build script; bundles Sparkle.framework; signs DMG with EdDSA; prints signature for appcast
- `windows-encryption-fix.md` — Step-by-step guide to clear stale keys from Windows registry

## Logging
All crypto logging uses `NSLog("[CRYPTO] ...")` — the only method visible in Console.app.
`print()` and `os.Logger` at .info level are NOT visible in Console.app.
Filter Console.app by `[CRYPTO]` to see all crypto diagnostics.

## Crypto Architecture
See `memory/crypto-notes.md` for full details.

## Encryption / Key Exchange Notes
- Windows IPMSG caches RSA public keys in `HKEY_CURRENT_USER\Software\HSTools\IPMsgEng` — keys: `crypt` (RSA-1024), `crypt2` (RSA-2048), `hostinfo2`
- Windows does NOT use the `FP:` fingerprint field in BR_ENTRY to detect key changes
- In-memory key cache persists until IPMSG is fully quit — registry deletion alone is not enough
- **Recovery flow (v1.1):** on decrypt failure → send BR_EXIT+BR_ENTRY (forces GETPUBKEY) + plaintext notification to sender
- Signing always uses RSA-2048 key (not recipient key size) to match Windows IPMSG behavior
- `encryptOpt` flag in selfSpec is gated on `settings.encryptionEnabled` — toggling off makes Windows send plaintext

## DMG Creation
Uses `hdiutil` only (no create-dmg tool). Pattern:
1. Stage app + `ln -s /Applications` symlink in temp dir
2. `hdiutil create -format UDRW` → mount → AppleScript icon positions → `hdiutil detach`
3. `hdiutil convert -format UDZO` to compressed read-only DMG

## SwiftUI Patterns
See `memory/feedback-sheet-item.md` — always use `.sheet(item:)` when a sheet needs data.


---

## Japan-2030

_synced: 2026-05-20T06:59:27Z | files: 4_

# Memory Index

- [Japan Trip Project](project_japan_trip.md) — 4-6 month immersive Japan trip, first time, slow travel, off-season preferred, budget-mixed, actively learning Japanese
- [Group Trip Sub-Research](../Documents/Japan\ 2030/group-trip/overview.md) — 6-10 friends join for 1 month (October 2030), tourist circuit, ¥5.5-6L/person (~₹3.6-3.9L excl. shopping)
- [User Travel Profile](user_travel_profile.md) — travel style, interests, and practical constraints for Japan trip planning
- [Budget Context](project_budget.md) — base ¥1M JPY (~₹6.3L), stretch ¥1.5M JPY (~₹9L); monthly envelope ¥167K–250K; flights ~¥1.1–1.8L JPY included in budget

---

## LAiMA

_synced: 2026-05-20T06:59:27Z | files: 7_

# Memory Index

| File | Description |
|------|-------------|
| [project_laima_overview.md](project_laima_overview.md) | What LAiMA is, purpose, tech stack, install method, config locations |
| [project_laima_architecture.md](project_laima_architecture.md) | File-by-file module breakdown, key design decisions, patterns |
| [project_laima_changelog.md](project_laima_changelog.md) | Chronological log of features added and bugs fixed by session |
| [project_laima_known_issues.md](project_laima_known_issues.md) | Non-obvious bugs, gotchas, and constraints to watch out for |
| [project_laima_platform.md](project_laima_platform.md) | Supported platforms — macOS primary, Linux secondary, Windows out of scope |
| [project_scripts.md](project_scripts.md) | Status and design decisions for ~/scripts/ shell utilities (ollama-models, ollama-update, vidspeed, openurls) |

---

## nwestco-v4

_synced: 2026-05-20T06:59:27Z | files: 2_

# NWestCo WordPress Theme - Key Learnings

## Workflow Rules (MUST FOLLOW)
1. **Backlog tickets require permission** — Never start working on BugHerd tickets in `backlog` status without asking the user first. Only `todo` tickets can be worked on directly.
2. **No WPE deployment without confirmation** — After making changes locally, wait for user to do visual QA and review before deploying to WP Engine. Always ask before pushing updates to WPE.

## Project Structure
- **WordPress**: `/Users/yogi/WORK/TT-2026/nwestco-v4/wordpress/`
- **Prototype**: `/Users/yogi/WORK/TT-2026/nwestco-v4/WORKSPACE/nwestco-option-c-v4/`
- **Theme**: `wp-content/themes/nwestco-theme/`
- **WP-CLI**: `wp` (at `/opt/homebrew/bin/wp`), always use `--path=` flag

## Server Setup
- PHP built-in server on port 8080 **requires `router.php`** for pretty permalinks
- Start command: `php -S localhost:8080 -t wordpress wordpress/router.php`
- BrowserSync on port 3000 proxying to 8080
- MySQL in Docker on localhost:3306
- Permalink structure: `/%postname%/`

## Critical: Router Script Required
PHP's built-in server does NOT handle URL rewriting. Without `router.php`, all non-root URLs resolve to homepage. The router serves static files directly and routes everything else through WordPress `index.php`.

## Template Hierarchy
- `page-{slug}.php` works for child pages (e.g., `page-fuel-systems.php` for `/markets/fuel-systems/`)
- `front-page.php` handles homepage
- Body class `page-template-default` is just meta, doesn't indicate which file loaded

## Cardinal Rule
**Prototype HTML is the source of truth.** Match structure exactly — CSS works as-is if HTML structure matches. Text must be character-for-character identical.

## ACF Architecture
- **Homepage ACF**: PHP-registered via `inc/acf-fields/homepage.php` (not JSON)
- **Markets ACF**: PHP-registered via `inc/acf-fields/markets.php` — shared group for 3 pages (IDs 20, 21, 22)
- **Shared template**: `template-parts/market-page.php` — all 3 market page-*.php files use get_template_part()
- **Population scripts**: `inc/acf-populate/homepage.php`, `inc/acf-populate/markets.php` — run via `wp eval-file`
- **Field prefix**: `home_` for homepage, `market_` for market pages
- **Repeater loops**: Use `get_field()` returning arrays + foreach, NOT `have_rows()`/`rewind_rows()` when needing two passes
- **`rewind_rows()` does NOT exist** in ACF — use `get_field()` to get full array and loop with foreach
- **SVG fields**: Stored as Textarea, output unescaped (they use currentColor)
- **HTML fields**: Use `wp_kses_post()` for content with `<span class="text-accent">`, `<br>`, `<strong>`
- **Link fields**: Return array with `url`, `title`, `target` keys
- **Brand logos**: ACF stores filename in `logo_file` text field, template prepends `assets/brands/` URI

## Image Handling
- Homepage: Brand logos from ACF repeater `home_brands_row1`/`home_brands_row2` text fields → `assets/brands/`
- Market pages: Use `<img src>` with `get_template_directory_uri()` pointing to `/assets/brands/` and `/assets/images/markets/`
- Brand logos copied to theme at `assets/brands/` (39 files)
- Market images at `assets/images/markets/` (20 files)

## CSS Enqueue Order
reset → variables → base → buttons → forms → option-c

## Completed Pages — ALL DONE
- Homepage (front-page.php) - all 11 sections
- Markets: fuel-systems, car-wash, environmental (7 sections each)
- Services: design-engineering, installation, service-maintenance, remodels-upgrades, equipment-parts, testing-compliance, training
- Company: about, careers (ClearCompany widget), contact (JotForm embed)
- Resources: financing, locations (20 branch cards), projects, news (6 news cards)
- Emergency: spill-response (5 sections)
- Legal: privacy, terms, accessibility

---

## Stardate

_synced: 2026-05-20T06:59:27Z | files: 3_

# Memory Index

- [Ask before infra decisions](feedback_ask_before_infra_decisions.md) — Always ask DB creds, project name, target dir before assuming defaults
- [Stardate project progress](project_stardate_progress.md) — All 8 phases complete; next session is UI polish/tweaks

---

## Terminal-Scripts

_synced: 2026-05-20T06:59:27Z | files: 5_

# Memory Index

## Project
- [project_terminal_scripts.md](project_terminal_scripts.md) — Repo overview, GitHub location, conventions, tooling notes

## User
- [user_profile.md](user_profile.md) — User background and preferences

## Feedback
- [feedback_git_workflow.md](feedback_git_workflow.md) — Git commit and push preferences
- [feedback_script_style.md](feedback_script_style.md) — Script style and formatting preferences

---

## Typa

_synced: 2026-05-20T06:59:27Z | files: 5_

# Memory Index — TextPad-NXG

- [Project context](project_context.md) — what Typa is, latest release (v0.5.4), active roadmap, build/release flow, scrapped features
- [User workflow preferences](user_workflow.md) — LSP+Context7 first, native idioms, strict scope, watch-outs from past sessions
- [Personal-projects ecosystem](personal_projects_ecosystem.md) — yogiee git identity, sister apps (IPMSGX, WallP), shared Sparkle key
- [Gutter & line-height reference](open_bug_lineheight.md) — resolved fixes for baselineOffset centering, gutter drift, and find-nav scroll-offset stale state; coordinate system notes for future work

---

## Users-yogi-Documents-Japan-2030

_synced: 2026-05-20T06:58:59Z | files: 4_

# Memory Index

- [Japan Trip Project](project_japan_trip.md) — 4-6 month immersive Japan trip, first time, slow travel, off-season preferred, budget-mixed, actively learning Japanese
- [Group Trip Sub-Research](../Documents/Japan\ 2030/group-trip/overview.md) — 6-10 friends join for 1 month (October 2030), tourist circuit, ¥5.5-6L/person (~₹3.6-3.9L excl. shopping)
- [User Travel Profile](user_travel_profile.md) — travel style, interests, and practical constraints for Japan trip planning
- [Budget Context](project_budget.md) — base ¥1M JPY (~₹6.3L), stretch ¥1.5M JPY (~₹9L); monthly envelope ¥167K–250K; flights ~¥1.1–1.8L JPY included in budget

---

## Users-yogi-WORK-LAiMA

_synced: 2026-05-20T06:58:59Z | files: 7_

# Memory Index

| File | Description |
|------|-------------|
| [project_laima_overview.md](project_laima_overview.md) | What LAiMA is, purpose, tech stack, install method, config locations |
| [project_laima_architecture.md](project_laima_architecture.md) | File-by-file module breakdown, key design decisions, patterns |
| [project_laima_changelog.md](project_laima_changelog.md) | Chronological log of features added and bugs fixed by session |
| [project_laima_known_issues.md](project_laima_known_issues.md) | Non-obvious bugs, gotchas, and constraints to watch out for |
| [project_laima_platform.md](project_laima_platform.md) | Supported platforms — macOS primary, Linux secondary, Windows out of scope |
| [project_scripts.md](project_scripts.md) | Status and design decisions for ~/scripts/ shell utilities (ollama-models, ollama-update, vidspeed, openurls) |

---

## Users-yogi-WORK-Personal-Projects-ai-test

_synced: 2026-05-20T06:58:59Z | files: 8_

# Memory Index

- [ollama-images skill](project_ollama_images_skill.md) — Local Ollama image gen skill, MLX fix, model limits, prompt tips
- [OPNsense Status LED Indicator](project_opnsense_status_leds.md) — ESP32 + WS2812B wall panel showing gateway/WAN/CPU status via ESPHome + OPNsense API
- [Network Redesign — Bridge + Switch Reorg](project_network_redesign.md) — 8-port 2.5GBe cabinet switch + OPT1 bridged to LAN for dedicated study room uplink, full OPNsense config steps
- [Kodi TMDb Scraper Proxy Fix](project_kodi_scraper_proxy_fix.md) — Both TMDb scrapers patched to route via Gluetun HTTP proxy (192.168.69.23:8888); reapply if addon updates overwrite api_utils.py
- [AI Prompt Writing Guide](reference_ai_prompt_guide.md) — Team guide for efficient AI prompting: base template, formatting rules, common mistakes; file at ai-test/ai-prompt-guide.md
- [CachyOS Migration Plan](project_cachyos_migration.md) — AMD gaming PC migration from Bazzite; Desktop Edition + Gamescope session for boot-to-Steam; WiFi DKMS fix; full guide at ai-test/linux-distro-research-cachyos.md
- [LXC + systemd + CIFS Lessons](feedback_lxc_systemd_lessons.md) — Hard-won debugging lessons: no FUSE in LXC, Conflicts= loop, stale CIFS detection, ping unreliable for WoL, poll don't sleep

---

## Users-yogi-WORK-Personal-Projects-Bond-N-Brick

_synced: 2026-05-20T06:58:59Z | files: 3_

# Bond N Brick — Memory Index

- [Brand Identity & Guidelines](project_bnb_brand.md) — Oceanic finalized; colors, fonts, logo variants, 300DPI vs 72DPI asset conventions
- [Cube Logo Concept](project_bnb_cube_logo.md) — Explored & abandoned; needs vector designer to execute properly

---

## Users-yogi-WORK-Personal-Projects-HA-Scripts

_synced: 2026-05-20T06:58:59Z | files: 5_

# MEMORY.md

- [Yogi - User Profile](user_profile.md) — homeowner, knows HA well, skip basics, go straight to YAML
- [Automation Playground - Completed Files](project_automations.md) — all 11 automations built/reviewed Apr 2026, purpose + key design decisions
- [Key Entity & Device Map](project_entities.md) — named entity_ids for lights, climate, media players, switches, sensors
- [HA Automation Conventions & Preferences](feedback_conventions.md) — patterns Yogi prefers: named entities, debounce, HA start trigger, wait_for_trigger timeout

---

## Users-yogi-WORK-Personal-Projects-IPMSGX

_synced: 2026-05-20T06:58:59Z | files: 9_

# IPMsgX Project Memory

## Project Overview
Swift/SwiftUI port of IP Messenger (LAN messaging protocol) for macOS.
Built with Swift Package Manager — no Xcode project file.

- **Repo:** https://github.com/yogiee/IPMsgX (public, account: yogiee)
- **Git remote:** HTTPS (gh credential helper) — SSH maps to yogi-gharat, not yogiee
- **Build:** `bash scripts/build-app.sh release` → `build/IPMsgX.app` + `build/IPMsgX.dmg`
- **Current version:** 1.4.1 (build 9) — GitHub Release v1.4.1 is Latest (bug fixes: compose selection, receive window, stale users)
- **Release DMG:** drag-and-drop installer with Applications folder shortcut (hdiutil, no create-dmg)
- **Target:** macOS 15.0+, Apple Silicon + Intel

## Key Files
- `IPMsgX/Crypto/CryptoService.swift` — RSA key management, encrypt/decrypt, self-test
- `IPMsgX/Crypto/SymmetricCrypto.swift` — AES-256-CBC, Blowfish-128-CBC via CommonCrypto
- `IPMsgX/Crypto/RSAPublicKey.swift` — Manual ASN.1 DER encode/decode (replaces deprecated SecAsn1Coder)
- `IPMsgX/Services/MessageService.swift` — Protocol message handling (GETPUBKEY, ANSPUBKEY, SENDMSG)
- `IPMsgX/Services/SettingsService.swift` — UserDefaults-backed settings (incl. encryptionEnabled, cmdEnterToSend)
- `IPMsgX/Models/UserInfo.swift` — RSAPublicKeyInfo with keySizeInBits
- `IPMsgX/Protocol/IPMsgPacketBuilder.swift` — Packet building (incl. FP: fingerprint in BR_ENTRY)
- `IPMsgX/Protocol/IPMsgPacketParser.swift` — Packet parsing
- `IPMsgX/Views/Settings/NetworkSettingsView.swift` — Encryption toggle + Reset Keys button
- `IPMsgX/Views/ComposeToolbarButton.swift` — Shared SF-symbol toolbar button (hover highlight)
- `IPMsgX/Views/MessageRenderer.swift` — `sanitize()` strips NUL/BEL bytes; `render()` produces AttributedString, skipping markdown pipeline for plain text/emoji
- `IPMsgX/Views/AttachmentTextEditor.swift` — NSViewRepresentable text editor; routes file drops to attachment callback; handles Enter-to-send
- `IPMsgX/App/AppState.swift` — Observable app state; `requestCompose(user:)` sets `composePreselectedUser` + bumps `composeRequestToken` UUID; both `private(set)`
- `IPMsgX/App/AppCommands.swift` — Notification names + SendRequest Identifiable wrapper
- `IPMsgX/IPMsgXApp.swift` — App entry; `Window("compose")` + standalone `Window("receive")` scenes; `ReceiveWindowContainer` (sequential queue display, dismisses when empty); `MainWindowProxy`; `MenuBarLabel` (badge + arrival animation)
- `IPMsgX/Services/UpdaterService.swift` — `@Observable @MainActor` Sparkle wrapper; singleton `UpdaterService.shared`; 3 update modes; `checkForUpdates()` triggers Sparkle UI
- `IPMsgX/Views/Settings/UpdatesSettingsView.swift` — Updates settings tab (mode picker + "Check for Updates" button)
- `appcast.xml` — Sparkle RSS feed (hosted at `https://raw.githubusercontent.com/yogiee/IPMsgX/main/appcast.xml`); fill in per-release
- `scripts/build-app.sh` — Full app bundle + installer DMG build script; bundles Sparkle.framework; signs DMG with EdDSA; prints signature for appcast
- `windows-encryption-fix.md` — Step-by-step guide to clear stale keys from Windows registry

## Logging
All crypto logging uses `NSLog("[CRYPTO] ...")` — the only method visible in Console.app.
`print()` and `os.Logger` at .info level are NOT visible in Console.app.
Filter Console.app by `[CRYPTO]` to see all crypto diagnostics.

## Crypto Architecture
See `memory/crypto-notes.md` for full details.

## Encryption / Key Exchange Notes
- Windows IPMSG caches RSA public keys in `HKEY_CURRENT_USER\Software\HSTools\IPMsgEng` — keys: `crypt` (RSA-1024), `crypt2` (RSA-2048), `hostinfo2`
- Windows does NOT use the `FP:` fingerprint field in BR_ENTRY to detect key changes
- In-memory key cache persists until IPMSG is fully quit — registry deletion alone is not enough
- **Recovery flow (v1.1):** on decrypt failure → send BR_EXIT+BR_ENTRY (forces GETPUBKEY) + plaintext notification to sender
- Signing always uses RSA-2048 key (not recipient key size) to match Windows IPMSG behavior
- `encryptOpt` flag in selfSpec is gated on `settings.encryptionEnabled` — toggling off makes Windows send plaintext

## DMG Creation
Uses `hdiutil` only (no create-dmg tool). Pattern:
1. Stage app + `ln -s /Applications` symlink in temp dir
2. `hdiutil create -format UDRW` → mount → AppleScript icon positions → `hdiutil detach`
3. `hdiutil convert -format UDZO` to compressed read-only DMG

## SwiftUI Patterns
See `memory/feedback-sheet-item.md` — always use `.sheet(item:)` when a sheet needs data.


---

## Users-yogi-WORK-Personal-Projects-Stardate

_synced: 2026-05-20T06:58:59Z | files: 3_

# Memory Index

- [Ask before infra decisions](feedback_ask_before_infra_decisions.md) — Always ask DB creds, project name, target dir before assuming defaults
- [Stardate project progress](project_stardate_progress.md) — All 8 phases complete; next session is UI polish/tweaks

---

## Users-yogi-WORK-Personal-Projects-Terminal-Scripts

_synced: 2026-05-20T06:58:59Z | files: 5_

# Memory Index

## Project
- [project_terminal_scripts.md](project_terminal_scripts.md) — Repo overview, GitHub location, conventions, tooling notes

## User
- [user_profile.md](user_profile.md) — User background and preferences

## Feedback
- [feedback_git_workflow.md](feedback_git_workflow.md) — Git commit and push preferences
- [feedback_script_style.md](feedback_script_style.md) — Script style and formatting preferences

---

## Users-yogi-WORK-Personal-Projects-Typa

_synced: 2026-05-20T06:58:59Z | files: 5_

# Memory Index — TextPad-NXG

- [Project context](project_context.md) — what Typa is, latest release (v0.5.4), active roadmap, build/release flow, scrapped features
- [User workflow preferences](user_workflow.md) — LSP+Context7 first, native idioms, strict scope, watch-outs from past sessions
- [Personal-projects ecosystem](personal_projects_ecosystem.md) — yogiee git identity, sister apps (IPMSGX, WallP), shared Sparkle key
- [Gutter & line-height reference](open_bug_lineheight.md) — resolved fixes for baselineOffset centering, gutter drift, and find-nav scroll-offset stale state; coordinate system notes for future work

---

## Users-yogi-WORK-Personal-Projects-WallP

_synced: 2026-05-20T06:58:59Z | files: 4_

# WallP Project Memory

## Project Overview
macOS + Windows app that rotates desktop wallpapers from Wallhaven collections.
- Repo: https://github.com/yogiee/WallP (public, pushed via `git@github.com-personal:yogiee/WallP.git`)
- macOS: Swift 6, SwiftUI, menu bar app — current version 1.3.1
- Windows: C# .NET, WPF, system tray app — current version 0.1.3
- Bundle ID: `com.wallp.app`
- Deployment target: macOS 26.0 / Windows 10 2004+

## Repo Structure (post-Windows restructure)
```
WallP/
├── mac/              ← macOS source (moved from root WallP/)
│   ├── WallP.xcodeproj
│   ├── WallP/        ← Swift source
│   └── scripts/build-app.sh
├── windows/          ← Windows port (C# WPF .NET)
│   ├── WallP/        ← C# source
│   └── scripts/
├── appcast.xml           ← Mac/Sparkle update feed
├── appcast-windows.xml   ← Windows/NetSparkle update feed
└── CLAUDE.md
```

## macOS — Key Architecture
All source under `mac/WallP/`:
- `WallPApp.swift` — App entry point, MenuBarExtra with .window style
- `AppSettings.swift` — @MainActor singleton, UserDefaults persistence
- `WallpaperRotator.swift` — @MainActor singleton, rotation timer, multi-monitor support
- `SyncScheduler.swift` — Actor, syncs Wallhaven collections on schedule
- `ImageCache.swift` — Actor, manages local HEIC cache at `~/Library/Application Support/WallP/cache/`
- `ImageOptimizer.swift` — Converts/downscales images to HEIC at screen resolution; center-crops portrait/narrow images to screen aspect ratio to prevent pillar-box bars
- `SystemStateMonitor.swift` — Observes sleep/lock/display-off notifications
- `WallhavenAPIService.swift` — Wallhaven REST API calls
- `MenuBarPopover.swift` — Main popover UI (SwiftUI)
- `SettingsView.swift` — Settings window with 5 tabs: General, Collections, Timing, Cache, About (About tab has app icon, version, GitHub link + Sparkle update settings below divider)
- `UpdaterService.swift` — @MainActor singleton wrapping SPUStandardUpdaterController (Sparkle)
- `WallPFocusFilter/WallPFocusFilter.swift` — SetFocusFilterIntent for per-Focus collection switching

## macOS — Build & Release Process
```bash
# Release build — outputs to mac/build/
./mac/scripts/build-app.sh

# Debug build (faster, no DMG/ZIP)
./mac/scripts/build-app.sh debug
```
- `mac/build/WallP.app` — open directly for local testing
- `mac/build/WallP-X.Y.dmg` — installer DMG used for GitHub release
- `mac/build/WallP-X.Y.zip` — zip archive
- `mac/build/.derived/` — Xcode intermediate files (gitignored, don't touch)
- Never call `xcodebuild` with `-derivedDataPath build` directly — use the script
- Git remote uses SSH alias: `git@github.com-personal:yogiee/WallP.git` (yogiee = personal account, id_ed25519_personal key)
- macOS version: MARKETING_VERSION=1.3.1, CURRENT_PROJECT_VERSION=5, in `mac/WallP.xcodeproj/project.pbxproj`

## macOS — UI (Liquid Glass, macOS 26)
- `GlassEffectContainer` wraps control button groups
- `.buttonStyle(.glass)` for standard buttons
- `.buttonStyle(.glassProminent)` for primary/active button (play/pause)

---

## Users-yogi-WORK-Personal-Projects-yogiee-github-io

_synced: 2026-05-20T06:58:59Z | files: 2_

# Memory Index

- [Bugz the Beagle](user_bugz.md) — senior tricolor Beagle, hero image subject on yogiee.github.io, Instagram @bugzythebeagle

---

## Users-yogi-WORK-tandem-net-inspector

_synced: 2026-05-20T06:59:00Z | files: 5_

# Inspector Project Memory

## Architecture: EDWARD Sidecar Services

Three Node.js sidecars run alongside Laravel, each wrapping an official AI SDK:

| Service | Port | SDK | Session ID prefix |
|---|---|---|---|
| `claude-agent` | 3001 | `@anthropic-ai/claude-agent-sdk` | UUID |
| `openai-agent` | 3002 | `@openai/agents` | `conv_` |
| `gemini-agent` | 3003 | `@google/adk` + `@google/genai` | cached by session ID |

All share: SSE via `createSSEWriter`/`startHeartbeat`, `agentLoader` fetching from Laravel API, security tiers, user context injection, UX guidelines, `[EXECUTE_WORKFLOW:id:message]` detection.

### Dockerfile Pattern (critical for all three sidecars)
- Build mirrors `services/` structure: `WORKDIR /build/<service-name>`
- Symlink required: `ln -s /build/<service>/node_modules /build/shared/node_modules`
  (shared/ imports gray-matter etc. from the service's own node_modules)
- `rootDir: ".."` in tsconfig → compiled entry at `dist/<service>/src/index.js`
- Runtime CMD: `node dist/<service>/src/index.js`

### Gemini ADK Notes
- `GoogleSearchTool` cannot be mixed with MCPToolset/FunctionTool (Gemini API limitation)
- Agent names must be sanitized: spaces/hyphens → underscores (`sanitizeAgentName()`)
- Streaming: `StreamingMode.NONE` with event iteration via `processEvent()`
- Tool mapping in `definitions.ts`: `WebSearch` → `GoogleSearchTool`

## References
- **Contributing Guide** (branching, PRs, commit conventions): https://github.com/tandem-theory/inspector/blob/dev/CONTRIBUTING.md → `memory/reference_contributing.md`

## Git Workflow
- PRs always target `dev` branch
- Branch naming: `type_description_username` (e.g. `feature_gemini-service_yogi`, `bugfix_copy-highlight_yogi`)
- `dev` → staging, `main` → production
- **Before reading any code**: `git checkout dev`
- **Before creating any branch**: run `gh auth status` — if active account is not `yogi-gharat`, switch with `gh auth switch --user yogi-gharat`
- **Before writing any code**: create a new branch (`bugfix_*_username` for bugs, `feature_*_username` for features)
- **After creating a PR**: comment on the BugHerd ticket with the PR number/branch, then update status to `READY FOR REVIEW/QA`

## Recent Tasks
- **260518**: BugHerd #347/#348 — both largely fixed by Michael's PR #358 (merged May 10) before our session. Created PR #400 (`bugfix_render-plain-newlines_yogi`) for the one residual gap: `_renderUserPlain()` in `edward-streaming-ui.js` didn't convert `\n` → `<br>`, collapsing Shift+Enter line breaks in plain-text messages. One-liner fix + new test in `ChatInputRenderingTest.php`. Also applied PR #358's MEDIUMTEXT migration to `tenant_testtenant` to clear 3 pre-existing test failures. BugHerd #347 + #348 → READY FOR REVIEW/QA.
- **260518**: PR #350 UI fixes — swapped bell → `rocket-launch` icon on Edward toolbar button; fixed "Mark all read" button crashing into Flux flyout close (×) by moving it below the panel title. Also updated panel header icon from `bell` to `rocket-launch`. Pushed to `feature_edward-release-notes_yogi`.
- **260518**: BugHerd #325 **DONE** — PR #403 open (`bugfix_mcp-tool-id-cleanup_yogi` → `dev`), READY FOR REVIEW/QA. Stripped top-level `'id'` keys from all 36 McpToolDefinitions files (329 entries); fixed deprecated tool deletion to use natural keys; added `McpToolDefinitionsIntegrityTest` (2 tests, 288 assertions). `GoogleAdsTools.php` (Q1 / wire-in vs delete) deferred pending team input.
- **260511**: PR #350 review — applied Michael's test fix: swapped `User::factory()->create()` for seeded `test@example.com` user + added `tearDown()` cleanup in `ReleaseNotesApiTest`. 17/17 tests passing. PR still open, waiting for Michael to merge.
- **260507**: Edward Release Notes feature — platform-wide release notes authored by super-admins, rocket-launch badge + right flyout on Edward page. Timer-based auto-mark-read (`max(8s, wordCount/3.33)`, SVG ring progress). Full GFM via `graham-campbell/markdown`. 17 files, 17 tests (10 Livewire + 7 API), all passing. PR #350 open (`feature_edward-release-notes_yogi` → `dev`), READY FOR REVIEW/QA.
- **260507**: claude-agent Docker crash fix — **MERGED** (PR #349). `DEBUG_CLAUDE_AGENT_SDK: '1'` env crash + non-root container fix. Merged by Michael 2026-05-10.
- **260504**: BugHerd #337 Edward doc links — **MERGED** (PR #331). Michael applied all 4 review concerns himself during merge: `data.source !== 'canvas'` exclusion, filename `[]` escaping, `console.warn` on dropped links, `startsWith` URL check. Confirmed in dev at `edward-streaming-messages.js:4527`.
- **250224**: BugHerd batch — #302 variable insert at cursor (PR #146), #303/#304 Gemini MCP error swallowing (PR #147), #243 Files node animation jitter (PR #148)
- **250225**: BugHerd batch (PRs #153-#159) — #51 inspect campaign link, #46 null Slack webhook, #47 slow settings query, #299 error badge tooltip, #297/#298 Pusher payload size, #300 file upload JSON error, #306 files lost on clone + Google reconnect
- **250226**: BugHerd #305 results bleed across workflow versions, #187 LLM required fields validation, #164 file download staging fix (PR #166)
- **250303**: BugHerd triage — #234 docs→EDWARD link (PR #174), #128 already done (closed), #261 Lockbox/chat dead code cleanup (PR #175)
- **250304**: BugHerd #157 Domo chat access discoverability fix (PR #176)
- **250312**: BugHerd #58 + #60 — architecture investigation + plan files written (pending team review)
- **250316**: BugHerd batch — #247/#257/#272 Office file extraction (PR #195), #246/#255 Drive search auth + corpora fix (PR #196); #245/#258 investigated, plans written (pending team decisions)
- **250317**: BugHerd #258 `edward_create_document` (PR #198), #245 `edward_save_file` (PR #199) — both open, awaiting review
- **250323**: BugHerd #166 PII Filtering — pipeline investigated, draft plan written (`docs/plans/bugherd-166-pii-filtering.md`), comment posted; awaiting team decisions
- **250326**: PR review batch — addressed Michael's comments on PR #196 (Google Drive auth + fullText fix) and PR #195 (Office file extraction). Both pushed. PRs #151 (Trello rich cards) and #164 (security extension blocking) deferred to next session.
- **250327**: PR #151 + #164 — thorough investigation completed; detailed plans + clarifying questions posted as GitHub comments on each PR. Awaiting Michael's answers before implementation.
- **250330**: BugHerd #166 PII Filtering — plan rewritten (v2). Decisions made: regex-only confirmed, address detection deferred (regex precision <80% on real-world content, not viable for Phase 1). Three open questions (Q1: redact vs pass-through, Q2: default-on vs opt-in, Q3: Phase 1 MCP scanning scope) posted to team for consensus. Plan updated at `docs/plans/bugherd-166-pii-filtering.md`.
- **260406**: BugHerd #166 PII Filtering — all team decisions received. Plan fully rewritten (v3) at `docs/plans/bugherd-166-pii-filtering - v3.md`. Decisions: Q1=Block (hard stop, no bypass), Q2=On by default, Q3=Phase 1 + MCP results. Added false positive handling (admin override + whitelist patterns) and LLM API policy audit as pre-ship prerequisite (non-engineering owner needed).

---

## Users-yogi-WORK-TT-2026-nwestco-v4

_synced: 2026-05-20T06:59:00Z | files: 2_

# NWestCo WordPress Theme - Key Learnings

## Workflow Rules (MUST FOLLOW)
1. **Backlog tickets require permission** — Never start working on BugHerd tickets in `backlog` status without asking the user first. Only `todo` tickets can be worked on directly.
2. **No WPE deployment without confirmation** — After making changes locally, wait for user to do visual QA and review before deploying to WP Engine. Always ask before pushing updates to WPE.

## Project Structure
- **WordPress**: `/Users/yogi/WORK/TT-2026/nwestco-v4/wordpress/`
- **Prototype**: `/Users/yogi/WORK/TT-2026/nwestco-v4/WORKSPACE/nwestco-option-c-v4/`
- **Theme**: `wp-content/themes/nwestco-theme/`
- **WP-CLI**: `wp` (at `/opt/homebrew/bin/wp`), always use `--path=` flag

## Server Setup
- PHP built-in server on port 8080 **requires `router.php`** for pretty permalinks
- Start command: `php -S localhost:8080 -t wordpress wordpress/router.php`
- BrowserSync on port 3000 proxying to 8080
- MySQL in Docker on localhost:3306
- Permalink structure: `/%postname%/`

## Critical: Router Script Required
PHP's built-in server does NOT handle URL rewriting. Without `router.php`, all non-root URLs resolve to homepage. The router serves static files directly and routes everything else through WordPress `index.php`.

## Template Hierarchy
- `page-{slug}.php` works for child pages (e.g., `page-fuel-systems.php` for `/markets/fuel-systems/`)
- `front-page.php` handles homepage
- Body class `page-template-default` is just meta, doesn't indicate which file loaded

## Cardinal Rule
**Prototype HTML is the source of truth.** Match structure exactly — CSS works as-is if HTML structure matches. Text must be character-for-character identical.

## ACF Architecture
- **Homepage ACF**: PHP-registered via `inc/acf-fields/homepage.php` (not JSON)
- **Markets ACF**: PHP-registered via `inc/acf-fields/markets.php` — shared group for 3 pages (IDs 20, 21, 22)
- **Shared template**: `template-parts/market-page.php` — all 3 market page-*.php files use get_template_part()
- **Population scripts**: `inc/acf-populate/homepage.php`, `inc/acf-populate/markets.php` — run via `wp eval-file`
- **Field prefix**: `home_` for homepage, `market_` for market pages
- **Repeater loops**: Use `get_field()` returning arrays + foreach, NOT `have_rows()`/`rewind_rows()` when needing two passes
- **`rewind_rows()` does NOT exist** in ACF — use `get_field()` to get full array and loop with foreach
- **SVG fields**: Stored as Textarea, output unescaped (they use currentColor)
- **HTML fields**: Use `wp_kses_post()` for content with `<span class="text-accent">`, `<br>`, `<strong>`
- **Link fields**: Return array with `url`, `title`, `target` keys
- **Brand logos**: ACF stores filename in `logo_file` text field, template prepends `assets/brands/` URI

## Image Handling
- Homepage: Brand logos from ACF repeater `home_brands_row1`/`home_brands_row2` text fields → `assets/brands/`
- Market pages: Use `<img src>` with `get_template_directory_uri()` pointing to `/assets/brands/` and `/assets/images/markets/`
- Brand logos copied to theme at `assets/brands/` (39 files)
- Market images at `assets/images/markets/` (20 files)

## CSS Enqueue Order
reset → variables → base → buttons → forms → option-c

## Completed Pages — ALL DONE
- Homepage (front-page.php) - all 11 sections
- Markets: fuel-systems, car-wash, environmental (7 sections each)
- Services: design-engineering, installation, service-maintenance, remodels-upgrades, equipment-parts, testing-compliance, training
- Company: about, careers (ClearCompany widget), contact (JotForm embed)
- Resources: financing, locations (20 branch cards), projects, news (6 news cards)
- Emergency: spill-response (5 sections)
- Legal: privacy, terms, accessibility

---

## WallP

_synced: 2026-05-20T06:59:27Z | files: 4_

# WallP Project Memory

## Project Overview
macOS + Windows app that rotates desktop wallpapers from Wallhaven collections.
- Repo: https://github.com/yogiee/WallP (public, pushed via `git@github.com-personal:yogiee/WallP.git`)
- macOS: Swift 6, SwiftUI, menu bar app — current version 1.3.1
- Windows: C# .NET, WPF, system tray app — current version 0.1.3
- Bundle ID: `com.wallp.app`
- Deployment target: macOS 26.0 / Windows 10 2004+

## Repo Structure (post-Windows restructure)
```
WallP/
├── mac/              ← macOS source (moved from root WallP/)
│   ├── WallP.xcodeproj
│   ├── WallP/        ← Swift source
│   └── scripts/build-app.sh
├── windows/          ← Windows port (C# WPF .NET)
│   ├── WallP/        ← C# source
│   └── scripts/
├── appcast.xml           ← Mac/Sparkle update feed
├── appcast-windows.xml   ← Windows/NetSparkle update feed
└── CLAUDE.md
```

## macOS — Key Architecture
All source under `mac/WallP/`:
- `WallPApp.swift` — App entry point, MenuBarExtra with .window style
- `AppSettings.swift` — @MainActor singleton, UserDefaults persistence
- `WallpaperRotator.swift` — @MainActor singleton, rotation timer, multi-monitor support
- `SyncScheduler.swift` — Actor, syncs Wallhaven collections on schedule
- `ImageCache.swift` — Actor, manages local HEIC cache at `~/Library/Application Support/WallP/cache/`
- `ImageOptimizer.swift` — Converts/downscales images to HEIC at screen resolution; center-crops portrait/narrow images to screen aspect ratio to prevent pillar-box bars
- `SystemStateMonitor.swift` — Observes sleep/lock/display-off notifications
- `WallhavenAPIService.swift` — Wallhaven REST API calls
- `MenuBarPopover.swift` — Main popover UI (SwiftUI)
- `SettingsView.swift` — Settings window with 5 tabs: General, Collections, Timing, Cache, About (About tab has app icon, version, GitHub link + Sparkle update settings below divider)
- `UpdaterService.swift` — @MainActor singleton wrapping SPUStandardUpdaterController (Sparkle)
- `WallPFocusFilter/WallPFocusFilter.swift` — SetFocusFilterIntent for per-Focus collection switching

## macOS — Build & Release Process
```bash
# Release build — outputs to mac/build/
./mac/scripts/build-app.sh

# Debug build (faster, no DMG/ZIP)
./mac/scripts/build-app.sh debug
```
- `mac/build/WallP.app` — open directly for local testing
- `mac/build/WallP-X.Y.dmg` — installer DMG used for GitHub release
- `mac/build/WallP-X.Y.zip` — zip archive
- `mac/build/.derived/` — Xcode intermediate files (gitignored, don't touch)
- Never call `xcodebuild` with `-derivedDataPath build` directly — use the script
- Git remote uses SSH alias: `git@github.com-personal:yogiee/WallP.git` (yogiee = personal account, id_ed25519_personal key)
- macOS version: MARKETING_VERSION=1.3.1, CURRENT_PROJECT_VERSION=5, in `mac/WallP.xcodeproj/project.pbxproj`

## macOS — UI (Liquid Glass, macOS 26)
- `GlassEffectContainer` wraps control button groups
- `.buttonStyle(.glass)` for standard buttons
- `.buttonStyle(.glassProminent)` for primary/active button (play/pause)

---

## yogiee-github-io

_synced: 2026-05-20T06:59:27Z | files: 2_

# Memory Index

- [Bugz the Beagle](user_bugz.md) — senior tricolor Beagle, hero image subject on yogiee.github.io, Instagram @bugzythebeagle

---

_26 projects tracked_
