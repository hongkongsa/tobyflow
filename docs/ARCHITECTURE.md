# TobyFlow v2 — Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CHROME BROWSER                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────────┐   webext-bridge    ┌────────────────────────┐     │
│  │   Background       │◄────(typed)──────►│     SidePanel           │     │
│  │   Service Worker   │                    │   (Svelte 5 + Zustand) │     │
│  │                    │  chrome.storage    │                          │     │
│  │  • Auth/Enrollment │◄────(sync)───────►│  • Generate Tab         │     │
│  │  • SSE Client      │                    │  • Batch Tab            │     │
│  │  • Tab Manager     │                    │  • Workflow Tab         │     │
│  │  • Request Signer  │                    │  • History Tab          │     │
│  │  • Config Poller   │                    │  • Settings Tab         │     │
│  └────────┬───────────┘                    └───────────┬──────────────┘     │
│           │                                             │                    │
│           │ chrome.tabs.sendMessage                     │ eventBus           │
│           │ (inject + communicate)                      │                    │
│           ▼                                             ▼                    │
│  ┌──────────────────────────────────────────────────────────────────┐     │
│  │                    Content Scripts                                  │     │
│  ├──────────────┬──────────────────┬────────────────┬───────────────┤     │
│  │  flow/       │  chatgpt/        │  grok/         │  gemini/      │     │
│  │  (labs.google)│ (chatgpt.com)   │  (grok.com)    │ (gemini...)   │     │
│  │              │                   │                │               │     │
│  │ • Selector   │ • Selector       │ • Selector     │ • Selector    │     │
│  │   Resolver   │   Resolver       │   Resolver     │   Resolver    │     │
│  │ • Editor     │ • Image Mode     │ • TipTap       │ • Editor      │     │
│  │   (Slate)    │ • CDN Extractor  │ • Cloudflare   │               │     │
│  │ • Tile       │ • Abort System   │ • Redirect     │               │     │
│  │   Monitor    │                   │   Monitor      │               │     │
│  │ • Downloader │                   │                │               │     │
│  └──────────────┴──────────────────┴────────────────┴───────────────┘     │
│                                                                           │
│  ┌──────────────────────┐                                                 │
│  │  Editor Popup Window  │  (Workflow visual editor — Drawflow)            │
│  └──────────────────────┘                                                 │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
           │
           │ HTTPS (HMAC-signed)
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         BACKEND SERVER                                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Middleware Stack:                                                        │
│  RateLimit → VerifyExtensionId → VerifySignature → Auth → EntitlementCheck│
│                                                                           │
│  ┌─────────┐ ┌────────────┐ ┌───────────┐ ┌──────────┐ ┌──────────┐  │
│  │  Auth    │ │ Enrollment │ │ Execution │ │ Storage  │ │   SSE     │  │
│  │ /login  │ │ /enroll    │ │ /request  │ │ /albums  │ │ /connect  │  │
│  │ /register│ │ /refresh   │ │ /complete │ │ /photos  │ │ /heartbeat│  │
│  └─────────┘ └────────────┘ └───────────┘ └──────────┘ └──────────┘  │
│                                                                           │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐                     │
│  │ Entitlements │ │ Provider     │ │  Telegram    │                     │
│  │ /check       │ │ Config       │ │  /webhook    │                     │
│  │ /plans       │ │ /selectors   │ │  /result     │                     │
│  └─────────────┘ └──────────────┘ └──────────────┘                     │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Core Design Patterns

### 1. Provider Adapter Pattern

```typescript
// Abstract base → concrete implementations
BaseProvider (abstract)
  ├── FlowProvider      (Google Flow — labs.google)
  ├── ChatGPTProvider   (chatgpt.com)
  ├── GrokProvider      (grok.com)
  └── GeminiProvider    (gemini.google.com)

// Registry routes requests
ProviderRegistry.route('chatgpt', params) → ChatGPTProvider.submit(params)
```

### 2. Dynamic Selector System (Server-Driven)

```
Backend updates selectors → SSE push → chrome.storage → content script reads

// Content script NEVER hardcodes selectors
// All DOM queries go through SelectorResolver:
resolver.query('submit_button') → Element | null
resolver.queryAll('tile_container') → Element[]
```

### 3. Execution Pipeline

```
User action → FeatureGate check → ExecutionGate request (quota)
  → ProviderTabLock acquire → Provider.ensureReady()
  → Content Script submit → TileMonitor watch
  → Retry (3 tiers) → Download → ExecutionGate complete
```

### 4. State Synchronization

```
Zustand Store (SidePanel)
  ↕ persist middleware
chrome.storage.local
  ↕ onChanged listener
Background Service Worker
  ↕ webext-bridge
Content Scripts
```

### 5. SSE Leader Election

```
Tab 1 (leader) ←── SSE connection ──→ Backend
  │
  │ BroadcastChannel
  ▼
Tab 2 (follower) — receives relayed events
Tab 3 (follower) — receives relayed events

// Leader dies → election → new leader connects
```

---

## Security Architecture

### 3-Layer Authentication

```
Layer 1: Extension ID Whitelist
  └─ Server rejects requests from unknown extension IDs

Layer 2: Device Enrollment (HMAC-SHA256)
  └─ message = timestamp:METHOD:path:bodyHash
  └─ Enrollment token refresh < 1 day before expiry

Layer 3: JWT Auth Token
  └─ User login → JWT → all API requests
  └─ Auto-refresh before expiry
```

### Anti-Clone Protection

```
1. Self-heal probe: background.js sends periodic check
2. Server responds 503 if extension ID not in whitelist
3. Content scripts show "Extension not authorized" overlay
4. Device ban: REVOKED_CLIENT, EXPIRED_CLIENT, INVALID_CLIENT
```

---

## Data Storage Strategy

| Data Type | Storage | Reason |
|-----------|---------|--------|
| Auth token, enrollment | chrome.storage.local | Cross-context, persist |
| User settings | chrome.storage.local | Small, cross-context |
| Provider configs | chrome.storage.local | Shared with content scripts |
| Running workflow flag | chrome.storage.local | Cross-context mutex |
| Albums, photos metadata | Dexie.js (IndexedDB) | Large, queryable |
| Blob thumbnails | Dexie.js (IndexedDB) | Binary data, large |
| Workflow definitions | Dexie.js (IndexedDB) | Complex objects |
| Execution history | Dexie.js (IndexedDB) | Queryable, pagination |
| Pending uploads | Dexie.js (IndexedDB) | File blobs |
| UI state (current tab) | Zustand (memory) | Ephemeral |

---

## Error Handling Strategy

### Error Categories

```typescript
// Provider errors — per-provider handling
class ProviderError extends Error {
  provider: ProviderKey;
  code: 'RATE_LIMIT' | 'CONTENT_BLOCKED' | 'NETWORK' | 'SESSION_EXPIRED';
}

// Quota errors — upsale flow
class QuotaError extends Error {
  code: 'QUOTA_EXCEEDED' | 'GLOBAL_QUOTA_EXCEEDED';
  limit: number;
  used: number;
}

// Config errors — retry + overlay
class ConfigError extends Error {
  code: 'SELECTOR_MISS' | 'CONFIG_LOADING' | 'CONFIG_TIMEOUT';
}
```

### Retry Tiers (Tile Failures)

```
Tier 1: Click retry button on provider page
  ↓ (all tiles still failed)
Tier 2: Reload provider page + resubmit (pipeline mode)
  ↓ (still failed)
Tier 3: Resubmit prompt fresh (legacy mode)
```

---

## Performance Budget

| Metric | Target |
|--------|--------|
| SidePanel initial load | < 200ms |
| Bundle size (per chunk) | < 500KB |
| Content script inject | < 50ms |
| Tile detection latency | < 100ms (MutationObserver) |
| Memory (idle) | < 50MB |
| Storage (typical user) | < 100MB IndexedDB |
