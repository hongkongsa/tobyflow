/**
 * Angles & Effects — Type Definitions
 */

export type AngleCategory = 'camera' | 'lighting' | 'style' | 'mood' | 'composition';
export type EffectCategory = 'style' | 'color' | 'texture' | 'atmosphere' | 'custom';

export interface AnglePreset {
  id: string;
  name: string;
  category: AngleCategory;
  modifier: string; // text appended/prepended to prompt
  is_custom: boolean;
}

export interface EffectPreset {
  id: string;
  name: string;
  category: EffectCategory;
  modifier: string;
  preview_prompt?: string;
  is_custom: boolean;
}

export interface AnglesJob {
  id: string;
  base_prompt: string;
  angles: AnglePreset[];
  provider: string;
  settings: Record<string, unknown>;
  state: 'pending' | 'running' | 'completed' | 'failed';
  results: AnglesResult[];
}

export interface AnglesResult {
  angle_id: string;
  full_prompt: string;
  media_urls: string[];
  status: 'pending' | 'completed' | 'failed';
  error?: string;
}

export interface EffectsJob {
  id: string;
  base_prompt: string;
  effects: EffectPreset[];
  provider: string;
  settings: Record<string, unknown>;
  state: 'pending' | 'running' | 'completed' | 'failed';
  results: EffectsResult[];
}

export interface EffectsResult {
  effect_id: string;
  full_prompt: string;
  media_urls: string[];
  status: 'pending' | 'completed' | 'failed';
  error?: string;
}
