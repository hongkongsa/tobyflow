# TobyFlow v2 — Implementation Plan (Complete)

## Tổng Quan

Rebuild TobyFlow extension từ đầu với kiến trúc cải tiến, đảm bảo **100% tính năng** từ source gốc (v1.1.7) được triển khai lại.

**Stack cải tiến:**
- TypeScript 5.x thay Vanilla JS (type safety, refactoring confidence)
- Vite + CRXJS thay 100+ script tags (HMR, tree-shaking, code splitting)
- Svelte 5 thay raw DOM manipulation (reactivity, components, less boilerplate)
- Zustand thay window.* globals (type-safe state, devtools, persist)
- Dexie.js thay raw IndexedDB (typed queries, versioned migrations)
- Vitest + Playwright thay manual testing
- webext-bridge thay raw chrome.runtime.sendMessage
- i18next thay custom I18n class
- Tailwind CSS thay single CSS file (13,844 lines)

---

## Module Mapping (Source Gốc → v2)

| # | Module Gốc | Files Gốc | Tương Ứng v2 |
|---|------------|-----------|--------------|
| 1 | Background Service Worker | background.js (5,264 lines) | src/background/ |
| 2 | Content Script — Flow | content.js (10,316 lines) + slate-bridge.js | src/content-scripts/flow/ |
| 3 | Content Script — ChatGPT | chat-content-chatgpt.js (2,914 lines) | src/content-scripts/chatgpt/ |
| 4 | Content Script — Grok | chat-content-grok.js (3,012 lines) | src/content-scripts/grok/ |
| 5 | Content Script — Gemini | chat-content-gemini.js (1,019 lines) | src/content-scripts/gemini/ |
| 6 | SidePanel UI | sidebar.html (2,282 lines) + sidebar.css (13,844 lines) | src/sidepanel/ |
| 7 | Provider System | AIProviderAdapter + Flow/ChatGPT/Grok/Gemini Adapters | src/providers/ |
| 8 | Provider Sessions | ChatGPTSession + GrokSession + GeminiSession | src/providers/sessions/ |
| 9 | Provider Config | ProviderMeta + ModelRegistry + GrokConfig | src/providers/config/ |
| 10 | Workflow Engine | WorkflowExecutor.js (8,398 lines) | src/workflow/executor.ts |
| 11 | Workflow Editor | workflow-editor.html + workflow-editor-init.js | src/editor-popup/ |
| 12 | Workflow Templates | workflow-template-editor.html + init.js | src/editor-popup/templates/ |
| 13 | BatchQueue & Jobs | BatchQueue.js + Job.js + QueueItem.js | src/batch/ |
| 14 | Tile Monitor | TileMonitor.js (1,054 lines) + TileCache.js | src/tile-monitor/ |
| 15 | Download Executor | DownloadExecutor.js | src/download/ |
| 16 | File Upload | FileUploader.js + ImmediateUploader.js | src/upload/ |
| 17 | Auth & Security | AuthManager.js + RequestSigner + Enrollment | src/shared/security/ + src/auth/ |
| 18 | Feature Gate | FeatureGate.js (2,048 lines) + TrialGate.js | src/feature-gate/ |
| 19 | Execution Gate | ExecutionGate.js + ExecutionLock + ExecutionTracker | src/execution/ |
| 20 | Storage System | StorageManager + LocalStorage + ApiStorage + BackendSync | src/shared/storage/ |
| 21 | SSE & Realtime | SseClient.js (1,199 lines) + SseBroadcastManager.js | src/sse/ |
| 22 | Config Version Poller | ConfigVersionPoller.js (342 lines) | src/sse/config-poller.ts |
| 23 | Telegram Integration | TelegramExecutor.js (1,285 lines) | src/telegram/ |
| 24 | Notification System | NotificationManager + NotificationBell + NotificationModal | src/notifications/ |
| 25 | Announcement System | AnnouncementManager.js | src/notifications/announcements.ts |
| 26 | Albums & Image Store | ImageStore.js (784 lines) + BlobUrlManager + ThumbnailCache | src/albums/ |
| 27 | Image Name Registry | ImageNameRegistry.js | src/albums/name-registry.ts |
| 28 | Screen Capture | ScreenCapture.js (258 lines) | src/capture/ |
| 29 | Snippets/Prompts | SnippetsPanel.js (466 lines) + UserPromptsManager.js | src/snippets/ |
| 30 | Angles Editor | angles-editor.html + angles-editor-init.js | src/angles/ |
| 31 | Effects Editor | effects-editor.html + effects-editor-init.js | src/effects/ |
| 32 | Settings | settings.html + settings-page.js + StorageSettings.js | src/settings/ |
| 33 | System Config | SystemConfig.js + ValidationRules.js + ExecutionConfig.js | src/shared/config/ |
| 34 | History | history-tab.css + history logic in sidebar | src/history/ |
| 35 | I18n | I18n.js + vi/en/ja/th.js + loading-i18n + clone-detected-i18n | src/i18n/ |
| 36 | Usage Analytics | UsageSync.js | src/analytics/ |
| 37 | OAuth Bridge | oauth-bridge.js | src/auth/oauth-bridge.ts |
| 38 | Slate Bridge | slate-bridge.js (MAIN world) | src/content-scripts/flow/slate-bridge.ts |
| 39 | Provider Tab Lock | ProviderTabLock.js | src/providers/tab-lock.ts |
| 40 | Retry Helper | RetryHelper.js | src/shared/utils/retry.ts |

---

## Phase 1: Foundation (Tuần 1-3)

### 1.1 Project Setup
- [ ] Init Vite project với CRXJS plugin
- [ ] Cấu hình TypeScript (strict mode, path aliases)
- [ ] Setup Tailwind CSS (dark/light theme)
- [ ] Setup ESLint + Prettier + svelte-check
- [ ] Setup Vitest (unit test runner)
- [ ] Cấu hình manifest.ts (MV3, permissions, host_permissions)
- [ ] Setup pnpm workspace
- [ ] Setup husky + lint-staged (pre-commit hooks)

### 1.2 Core Messaging Layer
- [ ] Implement webext-bridge wrapper cho typed messaging
- [ ] Define message types catalog (TypeScript interfaces cho MỌI actions)
- [ ] Background ↔ SidePanel communication
- [ ] Background ↔ Content Script communication
- [ ] chrome.storage wrapper (typed get/set với generics)
- [ ] EventBus typed implementation (pub/sub singleton)
- [ ] BroadcastChannel wrapper (cross-tab)

### 1.3 Authentication & Security
- [ ] `RequestSigner` — HMAC-SHA256 signing (message format: timestamp:METHOD:path:bodyHash)
- [ ] `DeviceFingerprint` — UUID v4 persistent (toby_device_fp)
- [ ] `EnrollmentManager` — Device enrollment + refresh (<1 day expiry)
- [ ] `AuthManager` — JWT token management + auto-refresh
- [ ] Anti-clone self-heal probe (60s interval → /entitlements)
- [ ] Device ban detection + 3 ban codes (REVOKED, EXPIRED, INVALID)
- [ ] Clone-detected overlay (i18n, manual retry button)
- [ ] Google OAuth flow — oauth-bridge.ts (labs.toby.vn/auth/google/success)
- [ ] API Base URL management (default + configurable)

### 1.4 Basic UI Shell (SidePanel)
- [ ] SidePanel entry (sidebar.html + App.svelte)
- [ ] Tab navigation system (8 tabs: Generate, Batch, Workflow, History, Albums, Telegram, Notifications, Settings)
- [ ] Theme system (dark/light) với CSS custom properties
- [ ] Toast notification component (dedup logic)
- [ ] Loading/Error states (skeleton loaders)
- [ ] Custom dialog component (modal, confirm, prompt)
- [ ] Tooltip component
- [ ] i18next setup (vi, en, ja, th) + data-i18n equivalent
- [ ] Login/Register UI (email + Google OAuth)
- [ ] Header component (user info, plan badge, notification bell)

### 1.5 System Config
- [ ] `SystemConfig` — centralized timeout/config values từ backend
- [ ] `ValidationRules` — server-driven validation (prompt length, file size, etc.)
- [ ] `ExecutionConfig` — per-execution configuration (merge user settings + overrides)
- [ ] `ApiBaseConfig` — API base URL management

### Deliverable Phase 1:
Extension load được, authenticate (email + Google OAuth), hiển thị UI shell với 8 tabs, dark/light theme, 4 locales.

---

## Phase 2: Single Provider — Google Flow (Tuần 4-6)

### 2.1 Provider Abstraction Layer
- [ ] `BaseProvider` abstract class (typed: ensureReady, submit, uploadRef, cancel)
- [ ] `ProviderRegistry` — factory + routing + enabled check
- [ ] `ProviderConfigManager` (PCM) — server config cache + invalidation
- [ ] `ModelRegistry` — model list per provider + per-model capability overrides
- [ ] Capabilities system (server-driven via PCM: supports, ratios, max_ref_images)
- [ ] `ProviderMeta` — provider metadata (URLs, tab queries, display names)

### 2.2 Content Script — Flow (10,316 lines equivalent)
- [ ] `SelectorResolver` — dynamic selector system (30s cache TTL)
- [ ] Bootstrap wait/retry/overlay pattern (10s max, 200ms poll)
- [ ] Re-injection guard (__tobyflow_flow_loaded__)
- [ ] Slate editor interaction:
  - [ ] insertText (React-aware: Object.getOwnPropertyDescriptor setter)
  - [ ] clearEditor
  - [ ] getSubmitButton + click
  - [ ] slate-bridge.ts (MAIN world — direct Slate API access)
- [ ] Radix UI trigger pattern (button[id$="-trigger-{suffix}"])
- [ ] Tile status detection (success/failed/processing — priority order)
- [ ] Tile DOM cache (250ms TTL) + Status cache (1.5s TTL)
- [ ] File name extraction (getMediaUrlRedirect URL parsing)
- [ ] Download via context menu (serial, right-click tile)
- [ ] Upload ref images (addFileToPrompt)
- [ ] `ExecutionBlocker` overlay (border glow, pointer-events block, escape 3× exit)
- [ ] Voice input support (MediaRecorder → transcription)
- [ ] Video mode support (Veo models)

### 2.3 Generate Tab
- [ ] `GeneratePage.svelte` — main prompt input
- [ ] Prompt textarea (auto-resize, character count, validation)
- [ ] Provider selector (dropdown/tabs)
- [ ] Ratio selector grid (5 options: story/portrait/square/landscape/widescreen)
- [ ] Model selector dropdown (per-provider models)
- [ ] Quantity selector (1-8)
- [ ] Mode selector (image/video)
- [ ] Reference image gallery:
  - [ ] File picker (multi-select)
  - [ ] Drag & drop
  - [ ] Paste from clipboard
  - [ ] Pick from albums
  - [ ] Remove/reorder
  - [ ] Thumbnail preview
- [ ] Submit button (with loading state)
- [ ] Result display (thumbnails grid with status indicators)
- [ ] Quick actions: copy prompt, re-generate, download all

### 2.4 Tile Monitor
- [ ] `TileMonitor` class — concurrent tile tracking (max 8)
- [ ] MutationObserver primary + polling fallback
- [ ] Tile claim system (race prevention — jobId + itemId + claimedAt)
- [ ] Dynamic settle delay (BASE + perTile × missingCount)
- [ ] Early claim (scan immediately after submit)
- [ ] _waitClaimedTilesComplete (Phase 2 completion polling)
- [ ] Abort support (AbortController per monitor)
- [ ] 3-tier retry:
  - [ ] Tier 1: Click retry button (2× max)
  - [ ] Tier 2: Page reload + resubmit (pipeline mode only)
  - [ ] Tier 3: Resubmit prompt fresh (legacy fallback)
- [ ] _clickedRetryTileIds dedup (prevent double-gen)

### 2.5 Download Executor
- [ ] `DownloadExecutor` — serial download queue
- [ ] Context menu download (right-click → download option)
- [ ] Resolution options (2K/4K)
- [ ] File naming pattern (customizable)
- [ ] Download progress tracking
- [ ] Auto-download setting (per job/workflow)
- [ ] chrome.downloads API integration

### 2.6 File Upload Pipeline
- [ ] `ImmediateUploader` — upload ngay khi chọn (serial queue)
  - [ ] Tab activation (ensure Flow tab active)
  - [ ] Upload via MessageBridge → content script
  - [ ] Tab restore (previous active tab)
  - [ ] Results cache: Map<key, {file_name, thumbnail_url, tile_id}>
  - [ ] WeakRef for re-upload
  - [ ] Cancellation support
- [ ] `PendingUploadStore` — lightweight metadata (IndexedDB)
  - [ ] Deferred upload khi submit
  - [ ] Thumbnail blob storage
- [ ] `FileUploader` — upload pending files trước submit
  - [ ] Check ImmediateUploader results first (skip if already uploaded)
  - [ ] Convert File → base64 (chunked ArrayBuffer, 8192 chunk size)
  - [ ] Send qua MessageBridge → content script addFileToPrompt
- [ ] `MediaRegistry` — centralized thumbnail cache
- [ ] Image resize/compress trước upload (WebP, max dimensions)

### 2.7 Screen Capture
- [ ] `ScreenCapture` class
  - [ ] startCapture() → inject crop overlay vào ANY active tab
  - [ ] Crop overlay UI (drag to select area, name input)
  - [ ] captureTab() → dataUrl (via background.js)
  - [ ] cropImage() → File object (canvas crop)
  - [ ] Add to pendingUploadFiles + PendingUploadStore
  - [ ] Auto-upload nếu Flow tab mở
- [ ] Screen capture button trong sidebar
- [ ] ImageNameRegistry integration (@mention support)

### Deliverable Phase 2:
Generate ảnh/video trên Google Flow — submit prompt, upload refs, screen capture, monitor tiles, retry, download.

---

## Phase 3: Multi-Provider (Tuần 7-9)

### 3.1 ChatGPT Provider
- [ ] `ChatGPTAdapter` — typed implementation
- [ ] `ChatGPTSession` singleton — tab management + state cache
  - [ ] _tabId, _ready (60s cache), _imageModeActive, _currentRatio
  - [ ] Fallback prefix mode (5min window after 2 failures)
  - [ ] Runtime listeners (tabClosed → resetCache, navigated → reset mode/ratio)
- [ ] Content script `chat-content-chatgpt.ts`:
  - [ ] Dynamic selectors (server-only, 30s cache)
  - [ ] Macro-delay strategy (inputTimeout × 0.7 = 840ms default)
  - [ ] Abort system (timestamp-guarded: abortAt >= callStartAt)
  - [ ] Image mode activation (click toggle)
  - [ ] Ratio selection (aria-label map từ server)
  - [ ] removeRefs() → uploadRefs() → activateImageMode() → setRatio() → injectTextAndSubmit()
  - [ ] waitForResult (poll CDN images: oaiusercontent, backend-api URLs)
  - [ ] Fallback prefix: "Generate an image of: {prompt}"
- [ ] Ref image handling (base64 paste, no persistent file ID)
- [ ] CDN image extractor

### 3.2 Grok Provider
- [ ] `GrokAdapter` — typed implementation
- [ ] `GrokSession` singleton — tab + TipTap editor management
- [ ] `GrokConfig` — Grok-specific configuration
- [ ] Content script `chat-content-grok.ts`:
  - [ ] TipTap/ProseMirror editor interaction
  - [ ] execCommand('selectAll') + execCommand('delete') for clear
  - [ ] execCommand('insertText', false, text) for insert
  - [ ] Settings: mode (image/video), ratio (5 options), duration (6s/10s), resolution (480p/720p), quality (speed/quality)
  - [ ] Ref image upload (hidden file input, dispatch change event)
  - [ ] Submit via KeyboardEvent('keydown', { key: 'Enter' })
  - [ ] Wait redirect (URL change: /imagine → /imagine/post/{uuid})
  - [ ] Extract media URLs từ result page
  - [ ] Cloudflare Turnstile bypass (4 strategies):
    - [ ] Strategy 0: turnstile.execute() / turnstile.reset() API
    - [ ] Strategy 1: Focus + click vào turnstile iframe checkbox position
    - [ ] Strategy 2: Click vào turnstile container center
    - [ ] Strategy 3: Focus window + click page body center + Space/Enter
  - [ ] Cloudflare detection (overlay dialog text matching)
  - [ ] SPA navigation detection

### 3.3 Gemini Provider (Text-only)
- [ ] `GeminiAdapter` — text generation only (no image mode)
- [ ] `GeminiSession` — tab management
- [ ] Content script `chat-content-gemini.ts`:
  - [ ] Editor interaction (contenteditable)
  - [ ] Submit + wait response text
  - [ ] Used for: prompt enhancement, describe image, text transform

### 3.4 ProviderTabLock
- [ ] Mutex serialize tab activation (Map<provider, Promise>)
- [ ] Auto switch tab + settle delay (300ms)
- [ ] _currentActiveTab tracking
- [ ] Multi-provider workflow support (sequential acquire/release)

### 3.5 Generate Tab — Multi-Provider
- [ ] Provider selector UI (tabs/dropdown with icons)
- [ ] Dynamic capabilities display per provider (hide/show ratio, quantity, video, etc.)
- [ ] Settings panel adapts to provider (Grok: duration/resolution/quality)
- [ ] Cross-provider settings sync (ratio preference persists)

### Deliverable Phase 3:
Generate trên 4 providers (Flow, ChatGPT, Grok, Gemini text), auto switch tabs, Cloudflare bypass.

---

## Phase 4: Workflow Engine & Batch (Tuần 10-12)

### 4.1 Visual Workflow Editor (Popup Window)
- [ ] Drawflow.js integration (Svelte wrapper)
- [ ] Node types (7):
  - [ ] Generate node (Flow provider)
  - [ ] ChatGPT node
  - [ ] Grok node
  - [ ] Gemini node (text transform)
  - [ ] Prompt node (text template + variables)
  - [ ] Image node (reference image source)
  - [ ] Download node (auto-download results)
  - [ ] Delay node (wait between nodes)
- [ ] Custom node UI (Svelte components rendered in Drawflow)
- [ ] Connection validation (typed ports — image out → image in, text out → text in)
- [ ] Node configuration panel (prompt, provider settings, ratio, model, quantity)
- [ ] Variable system: {{node_1_output}}, {{ref_image}}, @mentions
- [ ] Popup window positioning (kế bên sidebar)
- [ ] Save/Load workflow (Dexie.js + API sync)
- [ ] Workflow CRUD (create, edit, duplicate, delete)
- [ ] Import/Export (JSON format) [Premium]
- [ ] Share workflow link [Premium]
- [ ] Auto-generate thumbnail (html2canvas)

### 4.2 Workflow Template Editor
- [ ] Template browser (marketplace)
- [ ] Template import to user workflows
- [ ] Template popup window

### 4.3 Execution Engine (8,398 lines equivalent)
- [ ] Topological sort (DAG validation + execution order)
- [ ] `WorkflowExecutor` — sequential node execution with state machine
- [ ] @mention reference system: resolve {{upstream_node.output}} → actual values
- [ ] File name extraction from thumbnail URLs (extractFileNameFromUrl)
- [ ] `RetryHelper` — interruptible delays (check shouldStop per iteration)
- [ ] Heartbeat-based liveness (60s pulse, 5min TTL for stale detection)
- [ ] `ExecutionLock` — exclusive execution claim (Web Locks API)
- [ ] Cross-context running flag (af_running_workflow in chrome.storage.local)
- [ ] Auto-clear stale flag (no heartbeat >5min → assume crash)
- [ ] Node phase events (emitNodePhase: submitting → generating → downloading)
- [ ] broadcastEvent() — relay execution events to popup editor window
- [ ] Pause/Resume/Stop controls
- [ ] Multi-provider execution (ProviderTabLock serialize tab switches)
- [ ] Error handling per node (skip vs retry vs abort)

### 4.4 Workflow UI (SidePanel)
- [ ] Workflow list page (card grid with thumbnails)
- [ ] Workflow execution progress overlay
- [ ] Node status indicators (pending/running/done/failed)
- [ ] Execution progress bar
- [ ] Pause/Resume/Stop buttons
- [ ] Execution history per workflow
- [ ] Statistics (run count, success rate, avg duration)

### 4.5 Batch Queue System
- [ ] `BatchQueue` class — bulk prompt management
- [ ] `Job` data model (id, prompts, settings, state, stats)
- [ ] `QueueItem` data model (id, prompt, state, tileIds, error)
- [ ] Queue state machine: queued → running → paused/completed/stopped
- [ ] Item state machine: pending → submitting → submitted → monitoring → completed/failed
- [ ] Multi-tab batch UI:
  - [ ] Prompt list (paste multi-line → auto-split)
  - [ ] Import from file (txt, csv)
  - [ ] Batch settings (provider, ratio, model, quantity, delay between prompts)
  - [ ] Progress per item (status indicators)
  - [ ] Overall stats (completed/failed/pending counts)
  - [ ] Pause/Resume/Stop per job
  - [ ] Auto-download setting

### Deliverable Phase 4:
Visual workflow editor, topological execution, batch queue processing, multi-provider workflows.

---

## Phase 5: Angles & Effects (Tuần 13-14)

### 5.1 Angles Editor
- [ ] Popup window (angles-editor.html equivalent)
- [ ] Generate same prompt from multiple angles/variations
- [ ] Angle types: camera angle, lighting, style, mood, composition
- [ ] Preset angles (built-in templates)
- [ ] Custom angle definition
- [ ] Execute: generate N variants from 1 prompt + N angles
- [ ] Results grid comparison view
- [ ] FeatureGate: angles_enabled, angles_run_max quota

### 5.2 Effects Editor
- [ ] Popup window (effects-editor.html equivalent)
- [ ] Apply visual effects/styles to prompt
- [ ] Effect presets (built-in)
- [ ] Custom effect definition
- [ ] Preview effect on prompt text
- [ ] Execute: apply effect → generate
- [ ] FeatureGate: effects_enabled, effects_run_max quota

### Deliverable Phase 5:
Angles & Effects editors — generate variants from multiple perspectives/styles.

---

## Phase 6: Snippets & Templates (Tuần 15)

### 6.1 Snippets (Prompt Templates)
- [ ] `SnippetsPanel` — collapsible panel trong sidebar
- [ ] CRUD operations: list, create, edit, delete snippets
- [ ] Variable system: {{variable_name}} → dialog prompt user for value
- [ ] Insert snippet into active prompt textarea
- [ ] Storage: chrome.storage.local (af_user_prompts) + API sync
- [ ] `UserPromptsManager` — CRUD manager
- [ ] Search/filter snippets
- [ ] FeatureGate: prompt_templates_enabled, snippets_max quota
- [ ] Categories/folders for organization

### Deliverable Phase 6:
Prompt template library with variables, insert, organize.

---

## Phase 7: Realtime & Integrations (Tuần 16-17)

### 7.1 SSE System
- [ ] `SseClient` — 3 transport tiers:
  - [ ] Tier 1: Mercure Hub (premium, JWT subscriber token, 2h TTL auto-refresh)
  - [ ] Tier 2: Native SSE (EventSource, ticket-based auth)
  - [ ] Tier 3: Polling fallback (30s interval, speedup 3s during payment)
- [ ] Reconnect: exponential backoff (2s → 30s, max 15 retries)
- [ ] Heartbeat check (45s timeout)
- [ ] Flapping detection (10s stable threshold)
- [ ] Event handlers:
  - [ ] telegram_command / telegram_cancel / telegram_stop
  - [ ] provider_config_updated
  - [ ] entitlements_changed
  - [ ] config_versions_bumped
  - [ ] announcement
  - [ ] plan_activated

### 7.2 SSE Multi-Tab Coordination
- [ ] `SseBroadcastManager` — leader election (BroadcastChannel)
- [ ] Chỉ tab LEADER tạo connection thực
- [ ] Forward events từ leader → followers
- [ ] Dedupe ring buffer (50 event IDs)
- [ ] Auto-promote khi leader tab đóng

### 7.3 ConfigVersionPoller
- [ ] Lightweight version check (GET /config/versions ~200B)
- [ ] SSE connected → poll 30 phút (safety net)
- [ ] SSE disconnected → poll 5 phút (fallback)
- [ ] Module handlers: system_settings, providers, provider_models, node_types, validation_rules, default_settings, i18n, user_entitlements
- [ ] Delta fetch khi version mismatch

### 7.4 Telegram Integration
- [ ] `TelegramExecutor` — SSE command handler
- [ ] Commands: /image, /video, /workflow, /stop, /describe
- [ ] Multi-provider routing (default from settings, per-command override)
- [ ] Per-provider settings: flow (ratio, model), chatgpt (ratio), grok (mode, ratio, duration, resolution, quality)
- [ ] ExecutionGate integration (quota check before execute)
- [ ] ExecutionLock exclusive claim
- [ ] Concurrent execution rejection ("đang bận xử lý lệnh khác")
- [ ] Result sender (POST /telegram/result with thumbnails)
- [ ] Upsale messages khi quota hết
- [ ] Telegram settings UI (bot token, chat ID, default provider)

### 7.5 Notification System
- [ ] `NotificationManager` — multi-channel notifications
  - [ ] Browser notification (chrome.notifications.create)
  - [ ] Sound notification (Web Audio API)
  - [ ] Badge update (extension badge)
  - [ ] Webhook (POST custom URL)
- [ ] `NotificationBell` component — unread count badge
- [ ] `NotificationModal` — notification list + mark read
- [ ] Events monitored: job completed/failed, workflow done, download done, telegram result
- [ ] Per-channel enable/disable settings
- [ ] Custom webhook URL setting
- [ ] Sound type selection

### 7.6 Announcement System
- [ ] `AnnouncementManager` — server announcements via SSE
- [ ] Display announcement bar/modal
- [ ] Mark as read + dismiss

### Deliverable Phase 7:
SSE 3-tier realtime, multi-tab sync, Telegram remote control, notifications (4 channels), announcements.

---

## Phase 8: Albums & History (Tuần 18)

### 8.1 Albums Module
- [ ] `ImageStore` class (Dexie.js equivalent):
  - [ ] compressThumbnail (WebP 200px, max 50KB)
  - [ ] compressMedium (WebP 1200px, quality 0.85)
  - [ ] saveImage(albumId, blob, metadata)
  - [ ] getImage / deleteImage / listByAlbum
- [ ] `BlobUrlManager` — blob URL lifecycle (create + revoke, prevent memory leaks)
- [ ] `ThumbnailCache` — in-memory LRU cache
- [ ] `ImageNameRegistry` — map fileIds → human-readable names (for @mention + download naming)
- [ ] Albums CRUD UI:
  - [ ] Album list (grid/list view)
  - [ ] Create/rename/delete album
  - [ ] Album detail view (photo grid)
  - [ ] Select photos for use as refs
  - [ ] Drag-drop reorder
  - [ ] Bulk operations (delete, move)
- [ ] Image picker component (modal — pick from albums)
- [ ] API sync (albums + photos metadata)

### 8.2 History Module
- [ ] Execution history list (gen, task, workflow)
- [ ] Results browser (image/video thumbnail grid)
- [ ] Re-run from history (re-submit same prompt + settings)
- [ ] Filter by: date range, type (gen/batch/workflow/telegram), provider, status
- [ ] Search by prompt text
- [ ] Statistics dashboard (total runs, success rate, usage per provider)
- [ ] Storage: Dexie.js local cache + server sync
- [ ] Pagination/virtual scroll for large history

### Deliverable Phase 8:
Albums (organize images, pick as refs), History (browse, filter, re-run, stats).

---

## Phase 9: Monetization & Security (Tuần 19-20)

### 9.1 Feature Gate (2,048 lines equivalent)
- [ ] `FeatureGate` class — server-driven feature flags
- [ ] 3 sources refresh: SSE push + ConfigVersionPoller + periodic fetch
- [ ] Entitlements cache (30min TTL)
- [ ] Feature keys (full list from source):
  - [ ] gen_enabled, gen_run_max
  - [ ] chatgpt_enabled, chatgpt_run_max
  - [ ] grok_enabled, grok_run_max
  - [ ] tasks_enabled, tasks_max, tasks_run_max
  - [ ] workflows_enabled, workflows_max, workflows_run_max, workflows_nodes_max
  - [ ] workflow_share_enabled, workflow_import, workflow_export
  - [ ] angles_enabled, angles_run_max
  - [ ] effects_enabled, effects_run_max
  - [ ] auto_download, retry_on_fail, ref_images
  - [ ] prompt_templates_enabled, workflow_templates_enabled
  - [ ] history_enabled, snippets_max
- [ ] UI: locked feature overlays + upgrade prompt dialogs
- [ ] Local usage tracking (anonymous users — client-side fallback)
- [ ] canUse(featureKey): boolean
- [ ] checkQuota(quotaKey): { allowed, remaining, limit, used }

### 9.2 Execution Gate
- [ ] `ExecutionGate` class — server-side quota tokens
- [ ] request(action, promptCount, metadata) → { allowed, token, remaining, limit, used, global_* }
- [ ] complete(token, summary) → release token
- [ ] cancel(token) → abort execution
- [ ] Actions: generate, task_run, workflow_run, angles_run, effects_run, chatgpt_run, grok_run, gemini_run
- [ ] Server timeout fallback (5s → client-side FeatureGate check)
- [ ] Active token tracking for cleanup on unload
- [ ] `ExecutionLock` — mutex for execution contexts
- [ ] `ExecutionTracker` — track execution stats (duration, result count)
- [ ] onSuspend cleanup (release token via keepalive fetch)
- [ ] Cron cleanup (10 phút interval)

### 9.3 Plan & Upgrade Flow
- [ ] Plan display UI (current plan, limits, usage stats)
- [ ] Plan comparison table (free vs pro vs premium)
- [ ] Payment methods:
  - [ ] VietQR/SePay (QR code payment — Vietnamese market)
  - [ ] Stripe (international)
  - [ ] PayPal
  - [ ] Polar
- [ ] Upgrade flow: open payment page → wait SSE confirm (plan_activated event)
- [ ] Polling speedup (30s → 3s) during payment modal
- [ ] Success notification + auto-refresh entitlements
- [ ] Trial gate (first-time users — limited free runs)

### 9.4 Security Hardening
- [ ] Extension ID whitelist check (server-side)
- [ ] Anti-clone: self-heal probe (60s → /entitlements, detect 403 EXTENSION_NOT_AUTHORIZED)
- [ ] Device ban: 3 codes (REVOKED_CLIENT, EXPIRED_CLIENT, INVALID_CLIENT)
- [ ] Ban overlay (full-screen, i18n)
- [ ] Ban recovery flow (re-enroll when admin restores)
- [ ] Rate limiting (client-side debounce + server-side 429 handling)
- [ ] Request signing (every outgoing API call)
- [ ] Clear sensitive data on logout (privacy: local tasks + workflows)

### Deliverable Phase 9:
Freemium model, quota management, 4 payment methods, anti-piracy, device ban.

---

## Phase 10: Settings & Configuration (Tuần 21)

### 10.1 Settings Page (Popup Window)
- [ ] Settings tabs (5 tabs from source):
  - [ ] **Cài đặt** (General): language, theme (dark/light), notification preferences
  - [ ] **Nâng cao** (Advanced) [Premium]: model selection, timeout config, retry settings, humanized typing delay, input timeout
  - [ ] **Telegram** [Premium]: bot token, chat ID, default provider, notification on/off
  - [ ] **Bộ nhớ** (Storage): data management, clear data, export/import settings
  - [ ] **Thông tin** (About): version, update check, profile, logout
- [ ] `StorageSettings` — user settings sync with server
- [ ] Default settings from server (GET /settings/defaults)
- [ ] Auto-apply khi login (merge server defaults + local)
- [ ] Popup window positioning (kế bên sidebar)

### 10.2 Keyboard Shortcuts
- [ ] Alt+S: Toggle sidebar
- [ ] Alt+G: Generate with current prompt
- [ ] chrome.commands API registration

### Deliverable Phase 10:
Full settings (5 tabs), keyboard shortcuts, server-synced preferences.

---

## Phase 11: Polish & Testing (Tuần 22-23)

### 11.1 Error Handling (Centralized)
- [ ] Error boundary (Svelte)
- [ ] `QuotaErrorHandler` — detect quota errors + show upsale dialogs
- [ ] `ConfigErrorHandler` — config loading states + retry
- [ ] `ProviderErrorHandler` — per-provider error patterns
- [ ] Content script error patterns:
  - [ ] ChatGPT: RATE_LIMIT, CONTENT_BLOCKED, NETWORK
  - [ ] Grok: CLOUDFLARE, RATE_LIMIT, CONTENT_BLOCKED
  - [ ] Flow: Tile failed → 3-tier retry
- [ ] Network offline detection + overlay
- [ ] Global recovery: heartbeat stale, visibility change cleanup, Escape 3× force stop

### 11.2 Usage Analytics
- [ ] `UsageSync` — usage analytics sync to backend
- [ ] Privacy-first: minimal data, no PII
- [ ] Track: generation count, provider usage, feature usage
- [ ] Fire-and-forget (non-blocking)

### 11.3 Testing
- [ ] Unit tests (Vitest):
  - [ ] Topological sort algorithm
  - [ ] Request signing (HMAC-SHA256)
  - [ ] Feature gate logic (canUse, checkQuota)
  - [ ] Provider capabilities
  - [ ] Selector resolver
  - [ ] Storage migrations
  - [ ] i18n key resolution
- [ ] Integration tests (chrome API mocks):
  - [ ] Storage sync
  - [ ] Message passing (webext-bridge)
  - [ ] Provider adapters
  - [ ] SSE event handling
- [ ] E2E tests (Playwright):
  - [ ] Extension load + auth flow
  - [ ] Generate image (mock provider)
  - [ ] Workflow execution
  - [ ] Settings persistence
  - [ ] Multi-tab sync

### 11.4 Performance
- [ ] Lazy loading (code split per tab)
- [ ] Virtual scrolling (long lists: history, albums, batch items)
- [ ] Image thumbnail compression (WebP, lazy load)
- [ ] Bundle analysis + optimization (<500KB per chunk)
- [ ] Memory leak audit (content scripts: blob URLs, event listeners)
- [ ] Tile cache optimization (250ms DOM cache, 1.5s status cache)

### 11.5 Accessibility & UX
- [ ] Keyboard navigation (tab order, focus management)
- [ ] Screen reader labels (aria-*)
- [ ] Animation preferences (prefers-reduced-motion)
- [ ] Responsive SidePanel (different widths)
- [ ] Onboarding flow (first-time user guide)
- [ ] Loading states (skeleton, progress indicators)
- [ ] Empty states (no history, no albums, etc.)

### Deliverable Phase 11:
Production-ready, tested, polished, accessible extension.

---

## Phase 12: Deployment & CI/CD (Tuần 24)

### 12.1 CI/CD
- [ ] GitHub Actions: lint + typecheck + test + build on PR
- [ ] Automated Chrome Web Store publish (on tag)
- [ ] Version bumping (semantic-release or standard-version)
- [ ] Changelog generation (conventional commits)
- [ ] Bundle size check (fail if over budget)

### 12.2 Release Process
- [ ] Beta channel (tester group)
- [ ] Staged rollout (10% → 50% → 100%)
- [ ] Rollback procedure documented
- [ ] Crash reporting integration (Sentry)

### 12.3 Monitoring
- [ ] Error tracking (Sentry — source maps upload)
- [ ] Performance monitoring (core web vitals equivalent for extension)
- [ ] Server health checks (SSE connectivity, API response times)
- [ ] Alerts (error spike, SSE disconnect rate)

### 12.4 Auto-Update Mechanism
- [ ] onInstalled listener (update migrations)
- [ ] Re-inject content scripts vào existing tabs after update
- [ ] Show changelog (major updates only)
- [ ] Storage migrations (version-aware schema upgrade)

### Deliverable Phase 12:
CI/CD pipeline, automated releases, crash reporting, monitoring.

---

## Appendix A: Complete Feature Checklist

Từ source gốc (v1.1.7), đảm bảo mọi tính năng được implement:

### Core Features
- [ ] Multi-provider image generation (Flow, ChatGPT, Grok)
- [ ] Multi-provider text generation (Gemini)
- [ ] Video generation (Flow Veo, Grok)
- [ ] Batch prompt processing (multi-line, file import)
- [ ] Visual workflow editor (Drawflow, node types, connections)
- [ ] Workflow execution (topological sort, @mention references)
- [ ] Screen capture (any page, crop, name, upload)
- [ ] Angles editor (same prompt, multiple perspectives)
- [ ] Effects editor (apply styles to prompt)
- [ ] Prompt templates/snippets (variables, insert)
- [ ] Albums (organize, CRUD, pick as ref)
- [ ] History (browse, filter, re-run)
- [ ] Telegram remote control (/image, /video, /workflow, /stop)
- [ ] Auto-download (2K/4K, custom naming)

### UI/UX Features
- [ ] Dark/light theme
- [ ] 4 locales (vi, en, ja, th)
- [ ] 8-tab navigation
- [ ] Toast notifications (dedup)
- [ ] Custom dialogs (confirm, prompt, modal)
- [ ] Execution blocker overlay (glow border, escape 3× exit)
- [ ] Floating tracker (ChatGPT — show progress on provider page)
- [ ] Loading overlays (config loading, network error)
- [ ] Skeleton loaders
- [ ] Virtual scrolling (long lists)
- [ ] Keyboard shortcuts (Alt+S, Alt+G)

### Security Features
- [ ] HMAC-SHA256 request signing
- [ ] Device enrollment (UUID fingerprint)
- [ ] Anti-clone detection (self-heal probe)
- [ ] Device ban (3 codes + recovery)
- [ ] Extension ID whitelist
- [ ] JWT auth + auto-refresh

### Realtime Features
- [ ] SSE (3 transport tiers: Mercure/SSE/Polling)
- [ ] Multi-tab leader election (BroadcastChannel)
- [ ] ConfigVersionPoller (safety net)
- [ ] Live push: config, entitlements, telegram commands

### Monetization Features
- [ ] Feature gate (20+ feature keys)
- [ ] Execution gate (server-side quota tokens)
- [ ] Plan display + comparison
- [ ] 4 payment methods (VietQR, Stripe, PayPal, Polar)
- [ ] Upgrade flow (SSE confirm)
- [ ] Usage tracking (per-provider, per-feature)

---

## Appendix B: Technical Decisions

### Tại sao Svelte 5 thay React?
1. Bundle size nhỏ hơn 60% (compile-time, no runtime)
2. Performance (no virtual DOM → faster render cho SidePanel)
3. Ít boilerplate (reactive by default, runes syntax)
4. Content script friendly (mount vào existing DOM dễ dàng)

### Tại sao Vite + CRXJS thay Webpack?
1. HMR: Extension auto-reload khi code thay đổi
2. Speed: esbuild transform → 10-100x nhanh hơn Webpack
3. CRXJS: Tự động xử lý manifest, content scripts, background
4. Tree-shaking: Chỉ bundle code thực sự dùng

### Tại sao Zustand thay Redux/MobX?
1. Lightweight (~1KB, không cần provider wrapper)
2. TypeScript inference tốt
3. Middleware: persist, devtools, immer
4. Cross-context: chrome.storage adapter

### Tại sao Dexie.js thay raw IndexedDB?
1. Type-safe (typed tables, queries, migrations)
2. DX (Promise-based, chaining)
3. Versioning (schema migrations tự động)
4. Performance (bulk operations, compound indexes)

### Tại sao webext-bridge?
1. Typed messaging (compile-time check message actions)
2. Auto-routing (background ↔ content ↔ sidepanel)
3. Promise-based (sendMessage returns Promise)
4. Better than raw chrome.runtime.sendMessage

### Tại sao MutationObserver + Polling backup?
1. MO: immediate detection (vs 300ms poll delay)
2. MO: CPU efficient (event-driven vs interval)
3. Polling backup: MO can miss in edge cases (tab hidden, DOM detach)
4. Hybrid: best of both worlds

---

## Appendix C: Resource Estimate

| Phase | Effort | 1 Dev | 2 Devs |
|-------|--------|-------|--------|
| Phase 1: Foundation | Medium | 3 tuần | 2 tuần |
| Phase 2: Flow Provider | High | 3 tuần | 2 tuần |
| Phase 3: Multi-Provider | High | 3 tuần | 2 tuần |
| Phase 4: Workflow + Batch | Very High | 3 tuần | 2 tuần |
| Phase 5: Angles + Effects | Medium | 2 tuần | 1.5 tuần |
| Phase 6: Snippets | Low | 1 tuần | 0.5 tuần |
| Phase 7: Realtime + Telegram | High | 2 tuần | 1.5 tuần |
| Phase 8: Albums + History | Medium | 1 tuần | 1 tuần |
| Phase 9: Monetization | High | 2 tuần | 1.5 tuần |
| Phase 10: Settings | Low | 1 tuần | 0.5 tuần |
| Phase 11: Polish + Test | Medium | 2 tuần | 1.5 tuần |
| Phase 12: Deployment | Low | 1 tuần | 0.5 tuần |
| **Total** | | **24 tuần** | **16 tuần** |

---

## Appendix D: Dependencies (Backend)

| Endpoint Group | Needed By Phase |
|---------------|-----------------|
| Auth (login, register, Google OAuth) | Phase 1 |
| Enrollment (device) | Phase 1 |
| Config (versions, defaults) | Phase 1 |
| Provider configs (selectors, API configs, models) | Phase 2 |
| Execution (request, complete) | Phase 2 |
| Storage (tasks, workflows) | Phase 4 |
| Entitlements | Phase 9 |
| SSE (ticket, stream, poll, subscribe-token) | Phase 7 |
| Telegram (result, config) | Phase 7 |
| Results sync | Phase 2 |

---

## Appendix E: Definition of Done (Per Phase)

- [ ] All tasks checked off
- [ ] TypeScript compiles (tsc --noEmit, no errors)
- [ ] ESLint + Prettier passes
- [ ] Unit tests pass (new code covered ≥80%)
- [ ] Manual QA: core flows work in Chrome
- [ ] No console errors (clean run)
- [ ] Bundle size within budget (<500KB per chunk)
- [ ] Documentation updated (if API changed)
- [ ] i18n keys added for all user-facing text (4 locales)
- [ ] Dark + light theme tested
- [ ] Feature gate checked (locked features show upgrade prompt)
