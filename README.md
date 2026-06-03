# TobyFlow v2 — AI Workflow Automation Extension

Chrome Extension (MV3) cho tự động hóa workflow trên nhiều AI providers (Google Flow, ChatGPT, Grok, Gemini).

## Features

- **Multi-Provider Support**: Google Flow, ChatGPT, Grok, Gemini
- **Visual Workflow Editor**: Node-based DAG editor (Drawflow)
- **Batch Queue**: Bulk prompt processing với pause/resume/stop
- **Telegram Integration**: Remote control qua Telegram Bot
- **SSE Realtime**: Live sync cross-tab, push notifications
- **Offline-First**: IndexedDB + chrome.storage
- **i18n**: Vietnamese, English, Japanese, Thai

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5.x |
| Bundler | Vite + CRXJS |
| UI | Svelte 5 |
| State | Zustand |
| Storage | Dexie.js + chrome.storage |
| CSS | Tailwind CSS |
| Testing | Vitest + Playwright |
| i18n | i18next |

## Getting Started

```bash
# Install dependencies
pnpm install

# Development (with HMR)
pnpm dev

# Build for production
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint
```

## Load Extension (Development)

1. `pnpm dev` → build output trong `dist/`
2. Chrome → `chrome://extensions/` → Enable Developer mode
3. Click "Load unpacked" → chọn thư mục `dist/`
4. Extension auto-reload khi code thay đổi (HMR)

## Project Structure

```
src/
├── background/          # Service Worker
├── sidepanel/           # SidePanel UI (Svelte)
├── content-scripts/     # Per-provider DOM automation
│   ├── flow/
│   ├── chatgpt/
│   ├── grok/
│   └── shared/
├── providers/           # Provider abstraction layer
├── workflow/            # Workflow engine
├── upload/             # File upload pipeline
├── telegram/           # Telegram integration
├── editor-popup/       # Workflow editor window
└── shared/             # Types, utils, storage, errors
```

## Documentation

- [Implementation Plan](./docs/IMPLEMENTATION_PLAN.md) — Detailed phases & tasks
- [Architecture](./docs/ARCHITECTURE.md) — System design & patterns
- [API Contract](./docs/API_CONTRACT.md) — Backend API specification
- [Provider Guide](./docs/PROVIDER_GUIDE.md) — Adding new providers

## License

Proprietary — All rights reserved.
