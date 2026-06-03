# Adding a New Provider

## Overview

TobyFlow's provider system is designed for extensibility. Each AI provider
(Google Flow, ChatGPT, Grok, etc.) is implemented as an adapter that extends `BaseProvider`.

## Steps to Add a Provider

### 1. Define Provider Key

Add the key to `src/shared/types/provider.types.ts`:

```typescript
export type ProviderKey = 'flow' | 'chatgpt' | 'grok' | 'gemini' | 'your_provider';
```

### 2. Create Adapter

Create `src/providers/your-provider.adapter.ts`:

```typescript
import { BaseProvider } from './base.adapter';
import type { ProviderCapabilities, SubmitParams, SubmitResult } from '@shared/types';

export class YourProviderAdapter extends BaseProvider {
  readonly key = 'your_provider' as const;
  readonly displayName = 'Your Provider';
  readonly featureKey = 'your_provider_enabled';
  readonly executionAction = 'your_provider_run';

  async getCapabilities(): Promise<ProviderCapabilities> {
    // Fetch from ProviderConfigManager (server-driven)
  }

  async ensureReady(): Promise<ReadyResult> {
    // Check tab is open, user is logged in, editor is available
  }

  async submit(params: SubmitParams): Promise<SubmitResult> {
    // Send message to content script → interact with provider's DOM
  }

  async uploadRef(file: File): Promise<UploadResult> {
    // Upload reference image to the provider
  }
}
```

### 3. Create Content Script

Create `src/content-scripts/your-provider/index.ts`:

- Use `SelectorResolver` for ALL DOM queries
- Implement message handlers: submit, scan, detect, download
- Add re-injection guard
- Add bootstrap wait/retry pattern

### 4. Register Selectors on Backend

The backend must provide selectors for your provider in `/provider-configs`:

```json
{
  "your_provider": {
    "selectors": {
      "editor": { "selectors": ["[contenteditable]", ".editor"] },
      "submit_button": { "selectors": ["button[type=submit]"] }
    }
  }
}
```

### 5. Register in Manifest

Add content script match patterns in `src/manifest.ts`.

### 6. Register in ProviderRegistry

```typescript
import { YourProviderAdapter } from './your-provider.adapter';
ProviderRegistry.register(new YourProviderAdapter());
```

### 7. Add UI Support

- Add to provider selector component
- Show/hide capabilities based on provider
- Handle provider-specific settings

## Best Practices

1. **Never hardcode selectors** — always use SelectorResolver
2. **Use macro-delays** — providers need time to render (React, Vue, etc.)
3. **Handle login states** — providers may require authentication
4. **Implement cancel** — users should be able to abort long operations
5. **Test offline** — handle network failures gracefully
6. **Respect rate limits** — add delays between rapid submissions
