/**
 * Provider Types — Core type definitions for the provider abstraction layer
 */

export type ProviderKey = 'flow' | 'chatgpt' | 'grok' | 'gemini';

export type GenerationMode = 'image' | 'video';

export interface RatioOption {
  ui_name: string;
  value: string;
}

export interface ProviderCapabilities {
  supportsRatio: boolean;
  supportsQuantity: boolean;
  supportsVideo: boolean;
  supportsRefImage: boolean;
  supportsAutoDownload: boolean;
  supportsHumanized: boolean;
  supportsImageMode: boolean;
  maxRefImages: number;
  supportedRatios: RatioOption[];
  supportedModes: GenerationMode[];
  supportedDurations?: string[];
  supportedResolutions?: string[];
  supportedImageQualities?: string[];
}

export interface RefImage {
  id: string;
  file?: File;
  thumbnail: string;
  name: string;
}

export interface SubmitParams {
  prompt: string;
  ratio?: string;
  quantity?: number;
  mode?: GenerationMode;
  model?: string;
  refImages?: RefImage[];
  settings?: Record<string, unknown>;
}

export interface SubmitResult {
  success: boolean;
  mediaUrls: string[];
  thumbnails: Record<string, string>;
  tileIds: string[];
  error?: ProviderError;
}

export interface ReadyResult {
  ready: boolean;
  error?: string;
  tabId?: number;
}

export interface UploadResult {
  success: boolean;
  key: string;
  file_name?: string;
  thumbnail_url?: string;
  tile_id?: string;
}

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  provider: ProviderKey;
  retryable: boolean;
}

export type ProviderErrorCode =
  | 'RATE_LIMIT'
  | 'CONTENT_BLOCKED'
  | 'NETWORK'
  | 'SESSION_EXPIRED'
  | 'TAB_CLOSED'
  | 'SELECTOR_MISS'
  | 'SUBMIT_FAILED'
  | 'TIMEOUT'
  | 'CLOUDFLARE'
  | 'UNKNOWN';

export interface ProviderModel {
  id: string;
  name: string;
  type: GenerationMode;
  config?: {
    max_ref_images?: { image?: number; video_ingredients?: number };
  };
}

export interface ProviderConfig {
  supports: Record<string, boolean>;
  ratios: RatioOption[];
  max_ref_images: Record<string, number>;
  models: ProviderModel[];
  default_model: Record<GenerationMode, string>;
}
