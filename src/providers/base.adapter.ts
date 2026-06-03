/**
 * BaseProvider — Abstract base class for all AI provider adapters
 * 
 * Each provider (Flow, ChatGPT, Grok, Gemini) extends this class
 * and implements the abstract methods for their specific DOM interactions.
 */

import type {
  ProviderKey,
  ProviderCapabilities,
  SubmitParams,
  SubmitResult,
  ReadyResult,
  UploadResult,
} from '@shared/types';

export abstract class BaseProvider {
  abstract readonly key: ProviderKey;
  abstract readonly displayName: string;
  abstract readonly featureKey: string;
  abstract readonly executionAction: string;

  /**
   * Get provider capabilities (server-driven via ProviderConfigManager)
   */
  abstract getCapabilities(): Promise<ProviderCapabilities>;

  /**
   * Ensure provider is ready (tab open, logged in, editor available)
   */
  abstract ensureReady(): Promise<ReadyResult>;

  /**
   * Submit prompt to provider and wait for result
   */
  abstract submit(params: SubmitParams): Promise<SubmitResult>;

  /**
   * Upload a reference image to the provider
   */
  abstract uploadRef(file: File): Promise<UploadResult>;

  /**
   * Cancel a running submission (optional, default no-op)
   */
  async cancel(): Promise<void> {
    // Subclass override if supported
  }

  /**
   * Check if provider is enabled via FeatureGate
   */
  async isEnabled(): Promise<boolean> {
    // Will be implemented with FeatureGate integration
    return true;
  }
}
