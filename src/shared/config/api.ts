/**
 * API Configuration
 * In development, point to local mock server
 * In production, point to labs.toby.vn
 */

export const API_BASE_URL = 'http://localhost:3001/api/v1';

export const API_ENDPOINTS = {
  // Auth
  login: '/auth/login',
  register: '/auth/register',
  me: '/auth/me',
  logout: '/auth/logout',
  refresh: '/auth/refresh',

  // Enrollment
  enroll: '/enroll',

  // Config
  entitlements: '/entitlements',
  configVersions: '/config/versions',
  settingsDefaults: '/settings/defaults',
  validationRules: '/config/validation-rules',

  // Providers
  domSelectors: '/providers/dom-selectors',
  apiConfigs: '/providers/api-configs',
  providerModels: '/provider-models',

  // Execution
  executionRequest: '/execution/request',
  executionComplete: (id: string) => `/executions/${id}/complete`,

  // Storage
  workflows: '/workflows',
  tasks: '/tasks',
  resultsSync: '/results/sync',

  // SSE
  sseTicket: '/sse/ticket',
  sseStream: '/sse/stream',
  ssePoll: '/sse/poll',

  // Telegram
  telegramConfig: '/telegram/config',
  telegramResult: '/telegram/result',

  // Health
  health: '/health',
} as const;

export function buildUrl(endpoint: string): string {
  return `${API_BASE_URL}${endpoint}`;
}
