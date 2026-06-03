# TobyFlow v2 — Implementation Plan

## Tổng Quan

Rebuild TobyFlow extension từ đầu với kiến trúc cải tiến:
- TypeScript thay Vanilla JS (type safety, refactoring confidence)
- Vite + CRXJS thay 100+ script tags (HMR, tree-shaking, code splitting)
- Svelte 5 thay raw DOM (reactivity, components, less boilerplate)
- Zustand thay window.* globals (type-safe state, devtools)
- Dexie.js thay raw IndexedDB (typed queries, migrations)
- Vitest + Playwright thay manual testing

---

## Phase 1: Foundation (Tuần 1-3)

### 1.1 Project Setup
- [ ] Init Vite project với CRXJS plugin
- [ ] Cấu hình TypeScript (strict mode)
- [ ] Setup Tailwind CSS
- [ ] Setup ESLint + Prettier
- [ ] Setup Vitest
- [ ] Cấu hình manifest.json (MV3)
- [ ] Setup pnpm workspace

### 1.2 Core Messaging Layer
- [ ] Implement `webext-bridge` wrapper cho typed messaging
- [ ] Define message types catalog (TypeScript interfaces)
- [ ] Background ↔ SidePanel communication
- [ ] Background ↔ Content Script communication
- [ ] chrome.storage wrapper (typed get/set)

### 1.3 Authentication & Security
- [ ] `RequestSigner` — HMAC-SHA256 signing
- [ ] `DeviceFingerprint` — UUID v4 persistent
- [ ] `EnrollmentManager` — Device enrollment + refresh
- [ ] `AuthManager` — JWT token management
- [ ] Anti-clone self-heal probe
- [ ] Device ban detection + overlay

### 1.4 Basic UI Shell
- [ ] SidePanel entry (sidebar.html + App.svelte)
- [ ] Tab navigation system (8 tabs)
- [ ] Theme system (dark/light) với CSS custom properties
- [ ] Toast notification component
- [ ] Loading/Error states
- [ ] i18next setup (vi, en, ja, th)

### Deliverable Phase 1:
Extension load được, authenticate, hiển thị UI shell cơ bản.

---

## Phase 2: Single Provider — Google Flow (Tuần 4-6)

### 2.1 Provider Abstraction
- [ ] `BaseProvider` abstract class (typed)
- [ ] `ProviderRegistry` — factory + routing
- [ ] `ProviderConfigManager` (PCM) — server config cache
- [ ] `ModelRegistry` — model list per provider
- [ ] Capabilities system (server-driven)

### 2.2 Content Script — Flow
- [ ] `SelectorResolver` — dynamic selector system
- [ ] Bootstrap wait/retry/overlay pattern
- [ ] Re-injection guard
- [ ] Slate editor interaction (insertText, clear, submit)
- [ ] `TileDetector` — detect tile status (success/failed/processing)
- [ ] `ExecutionBlocker` overlay
- [ ] Radix UI trigger pattern

### 2.3 Generate Tab (Flow)
- [ ] `GeneratePage.svelte` — prompt input + settings
- [ ] Ratio selector grid
- [ ] Model selector dropdown
- [ ] Quantity selector
- [ ] Reference image gallery
- [ ] Submit flow: prompt → content script → wait result
- [ ] Result display (thumbnails grid)

### 2.4 Tile Monitor + Download
- [ ] `TileMonitor` — concurrent tile tracking (max 8)
- [ ] MutationObserver thay polling (cải tiến)
- [ ] Tile claim system (race prevention)
- [ ] `DownloadExecutor` — serial download via context menu
- [ ] Download progress UI

### 2.5 File Upload (Flow)
- [ ] `ImmediateUploader` — upload ngay khi chọn
- [ ] `PendingUploadStore` — deferred upload (IndexedDB)
- [ ] `FileUploader` — upload pending files trước submit
- [ ] `MediaRegistry` — centralized thumbnail cache
- [ ] Screen capture feature

### Deliverable Phase 2:
Generate ảnh trên Google Flow — submit prompt, monitor tiles, download results.

---

## Phase 3: Multi-Provider (Tuần 7-9)

### 3.1 ChatGPT Provider
- [ ] `ChatGPTAdapter` — typed implementation
- [ ] `ChatGPTSession` — tab management + image mode
- [ ] Content script `chat-content-chatgpt.ts`
  - [ ] Dynamic selectors (server-only)
  - [ ] Image mode activation
  - [ ] Ratio selection (aria-label map)
  - [ ] Submit + wait CDN image
  - [ ] Abort system (timestamp-guarded)
  - [ ] Fallback prefix mode
- [ ] Macro-delay strategy (inputTimeout × 0.7)
- [ ] CDN image extractor

### 3.2 Grok Provider
- [ ] `GrokAdapter` — typed implementation
- [ ] `GrokSession` — tab + editor management
- [ ] Content script `chat-content-grok.ts`
  - [ ] TipTap/ProseMirror editor interaction
  - [ ] Settings: mode/ratio/duration/resolution/quality
  - [ ] Ref image upload (hidden file input)
  - [ ] Submit via KeyboardEvent Enter
  - [ ] Wait redirect → extract media URLs
  - [ ] Cloudflare Turnstile bypass (4 strategies)
- [ ] SPA navigation detection

### 3.3 Gemini Provider (Text-only)
- [ ] `GeminiAdapter` — basic text generation
- [ ] `GeminiSession` — tab management
- [ ] Content script cho Gemini

### 3.4 ProviderTabLock
- [ ] Mutex serialize tab activation
- [ ] Auto switch + settle delay
- [ ] Multi-provider workflow support

### 3.5 Generate Tab — Multi-Provider
- [ ] Provider selector UI
- [ ] Dynamic capabilities display per provider
- [ ] Settings panel adapts to provider
- [ ] Cross-provider bridge (chatgpt → flow)

### Deliverable Phase 3:
Generate trên 4 providers, tự động switch tabs, cross-provider workflows.

---

## Phase 4: Workflow Engine (Tuần 10-12)

### 4.1 Visual Editor
- [ ] Drawflow integration (Svelte wrapper)
- [ ] Node types: generate, chatgpt, grok, prompt, image, download
- [ ] Custom node UI (Svelte components)
- [ ] Connection validation (typed ports)
- [ ] Editor popup window
- [ ] Save/Load workflow (Dexie.js)

### 4.2 Execution Engine
- [ ] Topological sort (DAG)
- [ ] `WorkflowExecutor` — sequential node execution
- [ ] `@mention` reference system ({node.output})
- [ ] `RetryHelper` — interruptible delays
- [ ] Heartbeat-based liveness (60s pulse, 5min TTL)
- [ ] `ExecutionLock` — exclusive execution claim (Web Locks API)
- [ ] Cross-context running flag (af_running_workflow)

### 4.3 Workflow UI
- [ ] Workflow list page
- [ ] Execution progress overlay
- [ ] Node status indicators (pending/running/done/failed)
- [ ] Pause/Resume/Stop controls
- [ ] Execution history + stats

### 4.4 Batch Queue
- [ ] `BatchQueue` — bulk prompt management
- [ ] `Job` + `QueueItem` data models
- [ ] Queue UI (progress, status per item)
- [ ] Pause/Resume/Stop per job
- [ ] Auto-download setting per job

### Deliverable Phase 4:
Visual workflow editor, topological execution, batch processing.

---

## Phase 5: Realtime & Integrations (Tuần 13-15)

### 5.1 SSE System
- [ ] `SseClient` — 3 transport tiers
  - [ ] Tier 1: Mercure (premium)
  - [ ] Tier 2: Native SSE (EventSource)
  - [ ] Tier 3: Polling fallback (free plan)
- [ ] `SseBroadcastManager` — leader election (BroadcastChannel)
- [ ] Auto-reconnect with backoff + flapping detection
- [ ] Event handlers: config_updated, entitlements_updated, telegram_command

### 5.2 ConfigVersionPoller
- [ ] Periodic config version check (safety net)
- [ ] Delta fetch khi version mismatch
- [ ] Auto-refresh PCM + FeatureGate

### 5.3 Telegram Integration
- [ ] `TelegramExecutor` — command router
- [ ] Commands: /image, /video, /workflow, /stop
- [ ] Multi-provider routing (default from settings)
- [ ] Result sender (POST thumbnails to backend)
- [ ] ExecutionGate integration (quota check)
- [ ] Concurrent execution lock

### 5.4 Notifications
- [ ] `NotificationManager` — in-app notifications
- [ ] `NotificationBell` — unread count badge
- [ ] Server-pushed notifications via SSE
- [ ] Notification modal (list + mark read)

### 5.5 Multi-Tab Coordination
- [ ] BroadcastChannel sync
- [ ] Leader election for SSE
- [ ] Tab-aware execution (prevent double-run)
- [ ] chrome.storage.onChanged sync

### Deliverable Phase 5:
Realtime updates, Telegram remote control, multi-tab sync.

---

## Phase 6: Monetization & Security (Tuần 16-17)

### 6.1 Feature Gate
- [ ] `FeatureGate` — server-driven feature flags
- [ ] 3 sources: SSE push + ConfigVersionPoller + periodic fetch
- [ ] Entitlements cache (30min TTL)
- [ ] UI: locked feature overlays, upgrade prompts

### 6.2 Execution Gate
- [ ] `ExecutionGate` — server-side quota tokens
- [ ] Request → validate → execute → complete lifecycle
- [ ] Quota exceeded handling + upsale UI
- [ ] Per-action quotas (generate, chatgpt_run, grok_run, workflow_run)

### 6.3 Plan & Upgrade
- [ ] Plan display UI
- [ ] Payment methods: VietQR/SePay, Stripe, PayPal, Polar
- [ ] Upgrade flow (open payment page → SSE confirm)
- [ ] Plan comparison table
- [ ] Trial gate (first-time users)

### 6.4 Security Hardening
- [ ] Extension ID whitelist check
- [ ] Anti-clone: self-heal probe (503 interval)
- [ ] Device ban: 3 codes (REVOKED, EXPIRED, INVALID)
- [ ] Ban recovery flow
- [ ] Rate limiting (client-side debounce)

### Deliverable Phase 6:
Freemium model, quota management, anti-piracy.

---

## Phase 7: Polish & Testing (Tuần 18-19)

### 7.1 Error Handling
- [ ] Centralized error boundary (Svelte)
- [ ] `QuotaErrorHandler` — upsale dialogs
- [ ] `ConfigErrorHandler` — config loading states
- [ ] `ProviderErrorHandler` — per-provider error patterns
- [ ] 3-tier retry system (click retry → reload → resubmit)
- [ ] Network offline detection + overlay

### 7.2 Testing
- [ ] Unit tests: core logic (Vitest)
  - [ ] Topological sort
  - [ ] Request signing
  - [ ] Feature gate logic
  - [ ] Provider capabilities
- [ ] Integration tests: chrome API mocks
  - [ ] Storage sync
  - [ ] Message passing
  - [ ] Provider adapters
- [ ] E2E tests: Playwright extension testing
  - [ ] Extension load + auth
  - [ ] Generate image (mock provider)
  - [ ] Workflow execution
  - [ ] Settings persistence

### 7.3 Performance
- [ ] Lazy loading (code split per tab)
- [ ] Virtual scrolling (long lists)
- [ ] Image thumbnail compression
- [ ] Bundle analysis + optimization
- [ ] Memory leak audit (content scripts)

### 7.4 Accessibility & UX
- [ ] Keyboard navigation
- [ ] Screen reader labels (aria-*)
- [ ] Animation preferences (prefers-reduced-motion)
- [ ] Responsive SidePanel
- [ ] Onboarding flow (first-time user)

### Deliverable Phase 7:
Production-ready, tested, polished extension.

---

## Phase 8: Deployment (Tuần 20)

### 8.1 CI/CD
- [ ] GitHub Actions: lint + typecheck + test + build
- [ ] Automated Chrome Web Store publish (on tag)
- [ ] Version bumping (semantic-release)
- [ ] Changelog generation

### 8.2 Release Process
- [ ] Beta channel (tester group)
- [ ] Staged rollout (10% → 50% → 100%)
- [ ] Rollback procedure
- [ ] Crash reporting (Sentry)

### 8.3 Monitoring
- [ ] Error tracking (Sentry)
- [ ] Usage analytics (privacy-first)
- [ ] Performance monitoring
- [ ] Server health checks

---

## Technical Decisions

### Tại sao Svelte thay React?
1. **Bundle size**: Svelte compile-time, no runtime → nhỏ hơn 60%
2. **Performance**: Không virtual DOM → render nhanh hơn cho SidePanel
3. **DX**: Ít boilerplate, reactive by default
4. **Content scripts**: Mount vào existing DOM dễ dàng

### Tại sao Vite + CRXJS thay Webpack?
1. **HMR**: Extension auto-reload khi code thay đổi
2. **Speed**: esbuild transform → 10-100x nhanh hơn Webpack
3. **CRXJS**: Tự động xử lý manifest, content scripts, background
4. **Tree-shaking**: Chỉ bundle code thực sự dùng

### Tại sao Zustand thay Redux/MobX?
1. **Lightweight**: ~1KB, không cần provider wrapper
2. **TypeScript**: Type inference tốt, minimal boilerplate
3. **Middleware**: persist, devtools, immer built-in
4. **Cross-context**: Easy sync qua chrome.storage adapter

### Tại sao Dexie.js thay raw IndexedDB?
1. **Type-safe**: Typed tables, queries, migrations
2. **DX**: Promise-based API, chaining
3. **Versioning**: Schema migrations tự động
4. **Performance**: Bulk operations, compound indexes

### Tại sao MutationObserver thay Polling cho Tile Monitor?
1. **Efficiency**: Chỉ fire khi DOM thay đổi (vs poll mỗi 300ms)
2. **Accuracy**: Bắt tile ngay khi xuất hiện (vs delay 0-300ms)
3. **Battery**: Ít CPU usage cho laptop/mobile
4. **Fallback**: Giữ polling backup nếu MO miss (defensive)

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Provider DOM changes | High | Server-driven selectors + fast backend update |
| Chrome MV3 limitations | Medium | Test early, workaround with Offscreen API |
| SSE connection instability | Medium | 3-tier fallback + reconnect + polling |
| Bundle size too large | Low | Code splitting per tab + lazy imports |
| Svelte learning curve | Low | Team familiar with React → Svelte transition smooth |
| CRXJS HMR issues | Low | Fallback to manual reload, well-maintained plugin |

---

## Resource Estimate

| Phase | Effort | 1 Developer | 2 Developers |
|-------|--------|-------------|--------------|
| Phase 1: Foundation | Medium | 3 tuần | 2 tuần |
| Phase 2: Flow Provider | High | 3 tuần | 2 tuần |
| Phase 3: Multi-Provider | High | 3 tuần | 2 tuần |
| Phase 4: Workflow | High | 3 tuần | 2 tuần |
| Phase 5: Realtime | Medium | 3 tuần | 2 tuần |
| Phase 6: Monetization | Medium | 2 tuần | 1.5 tuần |
| Phase 7: Polish | Medium | 2 tuần | 1.5 tuần |
| Phase 8: Deployment | Low | 1 tuần | 1 tuần |
| **Total** | | **20 tuần** | **14 tuần** |

---

## Dependencies (Backend)

Backend API cần sẵn sàng trước khi extension hoạt động đầy đủ:

| Endpoint Group | Needed By Phase |
|---------------|-----------------|
| Auth (login, register) | Phase 1 |
| Enrollment (device) | Phase 1 |
| Provider configs (selectors, capabilities) | Phase 2 |
| Execution (request, complete) | Phase 2 |
| Entitlements | Phase 6 |
| Storage (albums, photos) | Phase 2 |
| SSE (connect, heartbeat) | Phase 5 |
| Telegram (webhook, result) | Phase 5 |

---

## Definition of Done (Per Phase)

- [ ] All tasks checked off
- [ ] TypeScript compiles (no errors)
- [ ] ESLint passes
- [ ] Unit tests pass (new code covered)
- [ ] Manual QA: core flows work
- [ ] No console errors
- [ ] Bundle size within budget (<500KB per chunk)
- [ ] Documentation updated
