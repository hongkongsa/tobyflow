/**
 * Snippets / Prompt Templates — Type Definitions
 */

export interface Snippet {
  id: string;
  name: string;
  content: string;
  variables: SnippetVariable[];
  category?: string;
  tags?: string[];
  use_count: number;
  created_at: string;
  updated_at: string;
}

export interface SnippetVariable {
  name: string;
  label?: string;
  default_value?: string;
  type: 'text' | 'select' | 'number';
  options?: string[]; // for select type
}

export interface ResolvedSnippet {
  content: string;
  resolved_variables: Record<string, string>;
}
