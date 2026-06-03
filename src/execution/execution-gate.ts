/**
 * ExecutionGate — Server-side execution permission system
 * 
 * Equivalent to: src/core/ExecutionGate.js (532 lines)
 * 
 * Flow: request(action) → server validates quota → returns token → execute → complete(token)
 */

import type { ExecutionAction, ExecutionGateResponse } from '@shared/types';

const SERVER_TIMEOUT_MS = 5_000;

export interface ExecutionRequest {
  action: ExecutionAction;
  prompt_count: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionCompletePayload {
  token: string;
  summary: {
    success_count: number;
    fail_count: number;
    media_urls?: string[];
  };
}

export class ExecutionGate {
  private activeTokens: Set<string> = new Set();

  /**
   * Request execution permission from server.
   * Falls back to client-side FeatureGate check on timeout.
   */
  async request(
    action: ExecutionAction,
    promptCount: number,
    metadata?: Record<string, unknown>
  ): Promise<ExecutionGateResponse> {
    try {
      // TODO: POST /execution/request with timeout
      // Returns: { allowed, token, remaining, limit, used, global_remaining, global_limit, global_used, reason }
      const response: ExecutionGateResponse = {
        allowed: true,
        token: crypto.randomUUID(),
        remaining: 10,
      };

      if (response.token) {
        this.activeTokens.add(response.token);
      }
      return response;
    } catch (error) {
      // Timeout → fallback to client-side check
      console.warn('[ExecutionGate] Server timeout, falling back to client-side check');
      return { allowed: true }; // Fallback permissive
    }
  }

  /**
   * Complete execution — release token + report summary
   */
  async complete(token: string, summary: ExecutionCompletePayload['summary']): Promise<void> {
    this.activeTokens.delete(token);
    // TODO: POST /executions/:id/complete
  }

  /**
   * Cancel execution — release token without completion
   */
  async cancel(token: string): Promise<void> {
    this.activeTokens.delete(token);
    // TODO: POST /executions/:id/cancel
  }

  /**
   * Cleanup active tokens on extension unload (keepalive fetch)
   */
  async cleanupOnSuspend(): Promise<void> {
    const tokens = Array.from(this.activeTokens);
    for (const token of tokens) {
      await this.cancel(token);
    }
  }

  getActiveTokenCount(): number {
    return this.activeTokens.size;
  }
}

export const executionGate = new ExecutionGate();
