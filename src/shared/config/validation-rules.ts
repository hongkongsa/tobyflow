/**
 * ValidationRules — Server-driven validation
 * Rules fetched from backend, used to validate inputs before submission
 */

export interface ValidationRule {
  field: string;
  min?: number;
  max?: number;
  pattern?: string;
  message_key: string;
}

export interface ValidationRuleSet {
  prompt_min_length: number;
  prompt_max_length: number;
  prompt_max_length_chatgpt: number;
  prompt_max_length_grok: number;
  file_max_size_bytes: number;
  file_allowed_types: string[];
  max_ref_images: number;
  max_batch_items: number;
  max_workflow_nodes: number;
  snippet_name_max_length: number;
  snippet_content_max_length: number;
  album_name_max_length: number;
}

const DEFAULT_RULES: ValidationRuleSet = {
  prompt_min_length: 1,
  prompt_max_length: 4000,
  prompt_max_length_chatgpt: 2000,
  prompt_max_length_grok: 3000,
  file_max_size_bytes: 10 * 1024 * 1024, // 10MB
  file_allowed_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  max_ref_images: 5,
  max_batch_items: 100,
  max_workflow_nodes: 20,
  snippet_name_max_length: 100,
  snippet_content_max_length: 10_000,
  album_name_max_length: 50,
};

export class ValidationRules {
  private rules: ValidationRuleSet = { ...DEFAULT_RULES };

  get<K extends keyof ValidationRuleSet>(key: K): ValidationRuleSet[K] {
    return this.rules[key];
  }

  async loadFromServer(): Promise<void> {
    // TODO: Fetch from /config/versions → delta fetch validation_rules
  }

  update(partial: Partial<ValidationRuleSet>): void {
    Object.assign(this.rules, partial);
  }

  validatePrompt(text: string, provider?: string): { valid: boolean; error?: string } {
    if (text.length < this.rules.prompt_min_length) {
      return { valid: false, error: 'prompt_too_short' };
    }
    const maxLen = provider === 'chatgpt'
      ? this.rules.prompt_max_length_chatgpt
      : provider === 'grok'
        ? this.rules.prompt_max_length_grok
        : this.rules.prompt_max_length;
    if (text.length > maxLen) {
      return { valid: false, error: 'prompt_too_long' };
    }
    return { valid: true };
  }

  validateFile(file: File): { valid: boolean; error?: string } {
    if (file.size > this.rules.file_max_size_bytes) {
      return { valid: false, error: 'file_too_large' };
    }
    if (!this.rules.file_allowed_types.includes(file.type)) {
      return { valid: false, error: 'file_type_not_allowed' };
    }
    return { valid: true };
  }
}

export const validationRules = new ValidationRules();
