/**
 * Auth Types — Authentication, enrollment, and entitlements
 */

export interface User {
  id: string;
  email: string;
  name: string;
  plan: PlanType;
  created_at: string;
}

export type PlanType = 'free' | 'pro' | 'premium';

export interface LoginPayload {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  refresh_token: string;
  user: User;
}

export interface EnrollmentData {
  enrollment_token: string;
  secret: string;
  device_id: string;
  expires_at: string;
}

export interface Entitlements {
  plan: PlanType;
  features: FeatureFlags;
  limits: PlanLimits;
  expires_at: string;
}

export interface FeatureFlags {
  gen_enabled: boolean;
  chatgpt_enabled: boolean;
  grok_enabled: boolean;
  gemini_enabled: boolean;
  workflow_enabled: boolean;
  telegram_enabled: boolean;
  batch_enabled: boolean;
  video_enabled: boolean;
}

export interface PlanLimits {
  daily_executions: number;
  max_workflow_nodes: number;
  max_concurrent_monitors: number;
  max_batch_size: number;
}

export interface ExecutionRequest {
  action: ExecutionAction;
  count: number;
  owner: 'user' | 'telegram' | 'workflow';
  label: string;
}

export type ExecutionAction = 'generate' | 'chatgpt_run' | 'grok_run' | 'gemini_run' | 'workflow_run';

export interface ExecutionGateResponse {
  allowed: boolean;
  token?: string;
  remaining?: number;
  reason?: 'QUOTA_EXCEEDED' | 'FEATURE_LOCKED';
  limit?: number;
  used?: number;
}
