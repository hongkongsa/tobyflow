const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// ─── API: Health Check ──────────────────────────────────────────────────────
app.get('/api/v1/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ─── API: System Settings Public ───────────────────────────────────────────
app.get('/api/v1/system-settings/public', (req, res) => {
  res.json({
    success: true,
    data: {
      google_enabled: false,
      show_upgrade_ui: false,
      show_tip_coffee: false,
      maintenance_mode: false,
      maintenance_message: '',
      app_name: 'Local Dev Server'
    },
    meta: { version: 1 }
  });
});

// ─── API: Execution Config ──────────────────────────────────────────────────
app.get('/api/v1/system-config/execution', (req, res) => {
  res.json({
    success: true,
    data: {
      workflow: {
        delay_nodes_sec: 0,
        max_retries: 3,
        timeout_sec: 120,
        on_error: 'continue'
      },
      queue: {
        batch_size: 4,
        max_monitor: 10,
        rest_min_sec: 2,
        rest_max_sec: 5
      },
      timing: {
        delay_between_prompts_sec: 2
      },
      flow_recovery: {
        session_refresh_enabled: false,
        auto_recovery_enabled: false,
        backoff_base_sec: 5,
        backoff_max_sec: 60,
        backoff_jitter_percent: 0.2
      }
    }
  });
});

// ─── API: Enroll (HMAC) ─────────────────────────────────────────────────────
// background.js dùng client_id + secret cho HMAC signing mọi request
app.post('/api/v1/enroll', (req, res) => {
  res.json({
    success: true,
    data: {
      client_id: 'dev-client-local-001',
      secret: 'dev-secret-local-12345678901234567890123456789012',
      expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
      token: 'dev-token-local-123',
      user: {
        id: 1,
        email: 'dev@localhost',
        name: 'Dev User',
        plan: { slug: 'pro', name: 'Pro' }
      }
    }
  });
});

// ─── API: Location Cache ────────────────────────────────────────────────────
app.get('/api/v1/location/me', (req, res) => {
  res.json({
    success: true,
    data: {
      country_code: 'VN',
      country_name: 'Vietnam',
      locale: 'vi',
      currency: 'VND',
      ip_masked: '127.0.0.1',
      cached_at: Date.now()
    }
  });
});

// ─── API: Validation Rules ──────────────────────────────────────────────────
app.get('/api/v1/validation-rules', (req, res) => {
  res.json({
    success: true,
    data: {
      prompt_max_length: 5000,
      quantity_min: 1,
      quantity_max: 4,
      workflow_max_run_duration_sec: 3600
    },
    meta: { version: 1 }
  });
});

// ─── API: Default settings ──────────────────────────────────────────────────
app.get('/api/v1/default-settings', (req, res) => {
  res.json({ success: true, data: {} });
});

// ─── API: I18n ──────────────────────────────────────────────────────────────
app.get('/api/v1/i18n/:locale', (req, res) => {
  const locale = req.params.locale;
  let mockTranslations = {};
  try {
    const fs = require('fs');
    const path = require('path');
    const mockFile = path.join(__dirname, 'mock_i18n.json');
    if (fs.existsSync(mockFile)) {
      mockTranslations = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
    }
  } catch (err) {
    console.error('Error loading mock_i18n.json:', err);
  }
  
  // Hardcode some specific overrides for better UI
  if (!mockTranslations.workflow) mockTranslations.workflow = {};
  Object.assign(mockTranslations.workflow, {
    subtabTemplates: 'Mẫu (Templates)',
    subtabWorkflows: 'Workflow của tôi',
    subtabShared: 'Được chia sẻ với tôi',
    searchTemplate: 'Tìm kiếm mẫu...',
    allCategories: 'Tất cả danh mục',
    createTemplate: '+ Tạo Mẫu',
    noTemplates: 'Chưa có mẫu nào ở đây.'
  });
  
  if (!mockTranslations.sidebar) mockTranslations.sidebar = {};
  Object.assign(mockTranslations.sidebar, {
    tabHome: 'Trang chủ',
    tabTasks: 'Tác vụ',
    tabHistory: 'Lịch sử',
    tabTemplates: 'Mẫu'
  });

  res.json({ success: true, data: mockTranslations });
});

// ─── API: Providers Meta ────────────────────────────────────────────────────
app.get('/api/v1/providers', (req, res) => {
  res.json({
    success: true,
    data: [
      { slug: 'flow', name: 'Flow', status: 'active', sort_order: 1, base_url: 'https://labs.google/fx/tools/flow' },
      { slug: 'chatgpt', name: 'ChatGPT', status: 'active', sort_order: 2, base_url: 'https://chatgpt.com' },
      { slug: 'grok', name: 'Grok', status: 'active', sort_order: 3, base_url: 'https://grok.com' },
      { slug: 'gemini', name: 'Gemini', status: 'active', sort_order: 4, base_url: 'https://gemini.google.com' }
    ]
  });
});

// ─── API: Provider Models ────────────────────────────────────────────────────
// Format: [{id, provider, media_type, name, value, is_default, sort_order, config}]
app.get('/api/v1/provider-models', (req, res) => {
  res.json({
    success: true,
    data: [
      // Flow image models
      { id: 1, provider: 'flow', media_type: 'image', name: 'Flow Image', value: 'flow-image', is_default: true, is_premium: false, sort_order: 1, config: null },
      // Flow video models
      { id: 2, provider: 'flow', media_type: 'video', name: 'Flow Video', value: 'flow-video', is_default: true, is_premium: false, sort_order: 1, config: { duration_tier: 'default' } },
      // Flow chat models
      { id: 3, provider: 'flow', media_type: 'chat', name: 'Flow Chat', value: 'flow-chat', is_default: true, is_premium: false, sort_order: 1, config: null },
      // ChatGPT chat models
      { id: 4, provider: 'chatgpt', media_type: 'chat', name: 'GPT-4o', value: 'gpt-4o', is_default: true, is_premium: false, sort_order: 1, config: null },
      { id: 5, provider: 'chatgpt', media_type: 'image', name: 'DALL-E 3', value: 'dall-e-3', is_default: true, is_premium: false, sort_order: 1, config: null },
      // Grok chat models
      { id: 6, provider: 'grok', media_type: 'chat', name: 'Grok 2', value: 'grok-2', is_default: true, is_premium: false, sort_order: 1, config: null },
      { id: 7, provider: 'grok', media_type: 'image', name: 'Aurora', value: 'aurora', is_default: true, is_premium: false, sort_order: 1, config: null },
      { id: 8, provider: 'grok', media_type: 'video', name: 'Grok Video', value: 'grok-video', is_default: true, is_premium: false, sort_order: 1, config: null },
      // Gemini models
      { id: 9, provider: 'gemini', media_type: 'chat', name: 'Gemini Pro', value: 'gemini-pro', is_default: true, is_premium: false, sort_order: 1, config: null },
      { id: 10, provider: 'gemini', media_type: 'image', name: 'Gemini Image', value: 'gemini-image', is_default: true, is_premium: false, sort_order: 1, config: null }
    ],
    meta: { version: 1 }
  });
});

// ─── API: Provider API Configs ───────────────────────────────────────────────
// CRITICAL: format = data[slug].configs.xxx
// - ratios[mode]: array of strings or {ui_name, value}
// - video_durations: { default, advanced, fixed }
// - supports: { ratio, quantity, video, ref_image, auto_download, humanized, image_mode }
// - max_ref_images: { image, video, video_ingredients }
// - download_resolutions: { image: [...], video: [...] }
// - urls: { tab_query, create_url, ... }
app.get('/api/v1/providers/api-configs', (req, res) => {
  res.json({
    success: true,
    data: {
      flow: {
        configs: {
          ratios: {
            image: ['1:1', '16:9', '9:16', '4:3', '3:4'],
            video: ['16:9', '9:16', '1:1']
          },
          dom_selectors: {
            slate_editor: { selectors: ["div[data-slate-editor='true']"] },
            submit_button: { selectors: ["button[type='submit']", "button[aria-label='Submit prompt']", "button[aria-label='Create']"], icon_text: "arrow_forward", button_text: ["Tạo", "Create"] },
            settings_button: { selectors: ["button[aria-label='Settings']", "button[aria-label='Cài đặt']"], icon_text: "tune" },
            icon_element: { selectors: ["i.google-symbols", "i[class*='google-symbols']", "span.material-symbols-outlined", "span.material-symbols-rounded"] },
            add_button: { selectors: ["button[aria-label='Add image or video']", "button[aria-label='Add']", "button[aria-label='Thêm nội dung nghe nhìn']"] },
            tile_container: { selectors: ["div[data-tile-id]"] }
          },
          video_durations: {
            default: ['4s', '6s', '8s'],
            advanced: ['4s', '6s', '8s', '10s'],
            fixed: ['8s']
          },
          supports: {
            ratio: true,
            quantity: true,
            video: true,
            ref_image: true,
            auto_download: true,
            humanized: false,
            image_mode: true
          },
          max_ref_images: {
            image: 4,
            video: 2,
            video_ingredients: 4
          },
          download_resolutions: {
            image: [
              { value: '4K', label: '4K', menu_label: '4K', pixel_width: 3840 },
              { value: '2K', label: '2K', menu_label: '2K', pixel_width: 2048 },
              { value: '1K', label: '1K', menu_label: '1K', pixel_width: 1024 }
            ],
            video: [
              { value: '720p', label: '720p', menu_label: '720p' },
              { value: '1080p', label: '1080p', menu_label: '1080p' }
            ],
            image_fallback_chain: ['4K', '2K', '1K'],
            video_fallback_chain: ['1080p', '720p']
          },
          urls: {
            tab_query: 'https://labs.google/fx/*',
            create_url: 'https://labs.google/fx/tools/flow'
          }
        }
      },
      chatgpt: {
        configs: {
          ratios: {
            image: [
              { ui_name: 'landscape', value: '16:9' },
              { ui_name: 'portrait', value: '9:16' },
              { ui_name: 'square', value: '1:1' }
            ]
          },
          supports: {
            ratio: true,
            quantity: true,
            video: false,
            ref_image: false,
            auto_download: false,
            humanized: true,
            image_mode: false
          },
          max_ref_images: { image: 1, video: 0, video_ingredients: 0 },
          // ChatGPTConfig reads these keys to merge into flat config
          error_patterns: {
            rate_limit_error_text: 'You have sent too many messages',
            content_blocked_text: 'This content may violate our usage policies',
            image_gen_failed_text: 'We were unable to generate an image',
            network_error_text: 'There was an error generating a response',
            cloudflare_challenge_text: 'Checking your browser'
          },
          ui_text_patterns: {
            delete_menu_text: 'Delete',
            create_image_menu_text: 'Create image',
            generated_image_alt_text: 'Generated image'
          },
          urls: {
            tab_query: '*://chatgpt.com/*',
            create_url: 'https://chatgpt.com'
          }
        }
      },
      grok: {
        configs: {
          ratios: {
            image: [
              { ui_name: 'landscape', value: '16:9' },
              { ui_name: 'portrait', value: '9:16' },
              { ui_name: 'square', value: '1:1' }
            ],
            video: ['16:9', '9:16', '1:1']
          },
          supports: {
            ratio: true,
            quantity: false,
            video: true,
            ref_image: true,
            auto_download: false,
            humanized: true,
            image_mode: false
          },
          max_ref_images: { image: 1, video: 1, video_ingredients: 0 },
          supported_durations: ['6s', '10s'],
          supported_resolutions: ['480p', '720p'],
          supported_image_qualities: ['speed', 'quality'],
          error_patterns: [],
          urls: {
            tab_query: '*://grok.com/*',
            create_url: 'https://grok.com'
          }
        }
      },
      gemini: {
        configs: {
          ratios: {
            image: ['1:1', '16:9', '9:16']
          },
          supports: {
            ratio: false,
            quantity: false,
            video: false,
            ref_image: false,
            auto_download: false,
            humanized: false,
            image_mode: false
          },
          max_ref_images: { image: 0, video: 0, video_ingredients: 0 },
          urls: {
            tab_query: '*://gemini.google.com/*',
            create_url: 'https://gemini.google.com'
          }
        }
      }
    },
    meta: { version: 1 }
  });
});

// ─── API: Provider DOM Selectors ─────────────────────────────────────────────
app.get('/api/v1/providers/dom-selectors', (req, res) => {
  console.log('[Local Server] ✅ DOM selectors requested (flow selectors will be sent)');
  res.json({
    success: true,
    data: {
      flow: {
        selectors: {
          slate_editor: { selectors: ["div[data-slate-editor='true']"], fallback: "div[contenteditable='true']" },
          submit_button: { selectors: ["button[type='submit']", "button[aria-label='Submit prompt']", "button[aria-label='Create']"], icon_text: "arrow_forward", button_text: ["Tạo", "Create"] },
          settings_button: { selectors: ["button[aria-label='Settings']", "button[aria-label='Cài đặt']"], icon_text: "tune" },
          icon_element: { selectors: ["i.google-symbols", "i[class*='google-symbols']", "span.material-symbols-outlined", "span.material-symbols-rounded"] },
          add_button: { selectors: ["button[aria-label='Add image or video']", "button[aria-label='Add']", "button[aria-label='Thêm nội dung nghe nhìn']"] },
          tile_container: { selectors: ["div[data-tile-id]", "[class*='tile']"] },
          media_url_pattern: { pattern: "https://lh3.googleusercontent.com/" },
          flow_agent_toggle_button: { selectors: ["button[aria-pressed]", "button[aria-label='Agent']"], icon_text: "smart_toy", button_text: ["Tác nhân", "Agent"] },
          flow_agent_instruction_done_button: { selectors: ["button[aria-label='Done']", "button[aria-label='Xong']"], button_text: ["Done", "Xong"] },
          flow_chat_agent_close_button: { selectors: ["button[aria-label='Close']", "button[aria-label='Đóng']", "button[aria-label='Cancel']"], button_text: ["Đóng", "Close"] },
          project_link: { selectors: ["a[href*='/project/']"] }
        },
        name: 'Flow', status: 'active', config_version: 2
      },
      chatgpt: {
        selectors: {
          textarea: { selectors: ["textarea#prompt-textarea", "div[contenteditable='true']#prompt-textarea"] },
          submit_button: { selectors: ["button[data-testid='send-button']", "button[aria-label='Send prompt']"] },
          response_container: { selectors: ["div[data-message-author-role='assistant']"] },
          image_container: { selectors: ["img[alt='Generated image']", "img[data-testid='generated-image']"] }
        },
        name: 'ChatGPT', status: 'active', config_version: 2
      },
      grok: {
        selectors: {
          editor: { selectors: ["div.ProseMirror[contenteditable='true']", "div[role='textbox']"] },
          submit_button: { selectors: ["button[aria-label='Submit']", "button[type='submit']"] },
          response_container: { selectors: ["div[class*='response']", "div[class*='message']"] }
        },
        name: 'Grok', status: 'active', config_version: 2
      },
      gemini: { selectors: {}, name: 'Gemini', status: 'active', config_version: 1 }
    },
    meta: { version: 1 }
  });
});

// ─── API: Provider Voices ────────────────────────────────────────────────────
app.get('/api/v1/voices/base', (req, res) => {
  res.json({ success: true, data: [] });
});
app.get('/api/v1/provider-voices', (req, res) => {
  res.json({ success: true, data: [] });
});

// ─── API: Entitlements ────────────────────────────────────────────────────────
// ─── DEV USER DATA (shared across auth endpoints) ────────────────────────────
const DEV_TOKEN = 'dev-auth-token-local-pro-2026';
const DEV_USER = {
  id: 1,
  email: 'dev@localhost',
  name: 'Dev Admin (Local)',
  plan_slug: 'pro',
  plan_name: 'Pro',
  role: 'admin',
  is_admin: true,
  email_verified_at: new Date().toISOString(),
  subscription_status: 'active',
  subscription_ends_at: null,
  avatar: null,
  google_linked: false
};

// Pro entitlements — all features unlocked, quotas unlimited (-1)
// Format: { type: 'boolean'|'quota', value } — same as FeatureGate._freeDefaults
const PRO_FEATURES = {
  gen_enabled:                  { type: 'boolean', value: true },
  gen_run_max:                  { type: 'quota',   value: -1   },
  chatgpt_enabled:              { type: 'boolean', value: true },
  chatgpt_run_max:              { type: 'quota',   value: -1   },
  grok_enabled:                 { type: 'boolean', value: true },
  grok_run_max:                 { type: 'quota',   value: -1   },
  gemini_enabled:               { type: 'boolean', value: true },
  gemini_run_max:               { type: 'quota',   value: -1   },
  tasks_enabled:                { type: 'boolean', value: true },
  tasks_max:                    { type: 'quota',   value: -1   },
  tasks_run_max:                { type: 'quota',   value: -1   },
  workflows_enabled:            { type: 'boolean', value: true },
  workflows_max:                { type: 'quota',   value: -1   },
  workflows_run_max:            { type: 'quota',   value: -1   },
  workflows_nodes_max:          { type: 'quota',   value: -1   },
  workflow_share_enabled:       { type: 'boolean', value: true },
  workflow_import:              { type: 'boolean', value: true },
  workflow_export:              { type: 'boolean', value: true },
  angles_enabled:               { type: 'boolean', value: true },
  angles_run_max:               { type: 'quota',   value: -1   },
  effects_enabled:              { type: 'boolean', value: true },
  effects_run_max:              { type: 'quota',   value: -1   },
  auto_download:                { type: 'boolean', value: true },
  retry_on_fail:                { type: 'boolean', value: true },
  ref_images:                   { type: 'boolean', value: true },
  prompt_templates_enabled:     { type: 'boolean', value: true },
  workflow_templates_enabled:   { type: 'boolean', value: true },
  history_enabled:              { type: 'boolean', value: true },
  snippets_max:                 { type: 'quota',   value: -1   },
  priority_support:             { type: 'boolean', value: true },
  pipeline_queue_enabled:       { type: 'boolean', value: true },
  prompt_submit_max:            { type: 'quota',   value: -1   },
  prompts_per_batch:            { type: 'quota',   value: -1   },
  api_rate_limit_per_minute:    { type: 'quota',   value: -1   },
  ai_agent_enabled:             { type: 'boolean', value: true },
  prompt_enhancer_enabled:      { type: 'boolean', value: true },
};

// ─── API: Auth ────────────────────────────────────────────────────────────────
app.get('/api/v1/auth/me', (req, res) => {
  res.json({ success: true, data: DEV_USER });
});

app.post('/api/v1/auth/login', (req, res) => {
  // Accept any credentials in dev mode
  res.json({
    success: true,
    data: { token: DEV_TOKEN, user: DEV_USER }
  });
});

app.post('/api/v1/auth/register', (req, res) => {
  res.json({
    success: true,
    data: { token: DEV_TOKEN, user: DEV_USER }
  });
});

app.post('/api/v1/auth/refresh', (req, res) => {
  res.json({
    success: true,
    data: { token: DEV_TOKEN, user: DEV_USER }
  });
});

app.post('/api/v1/auth/logout', (req, res) => {
  res.json({ success: true, data: null });
});

app.get('/api/v1/auth/google/url', (req, res) => {
  res.json({
    success: true,
    data: { url: 'http://localhost:3000/auth/google/callback' }
  });
});

app.get('/api/v1/auth/google/link-url', (req, res) => {
  res.json({
    success: true,
    data: { url: 'http://localhost:3000/auth/google/link' }
  });
});

app.post('/api/v1/auth/forgot-password', (req, res) => {
  res.json({ success: true, data: { message: 'Email sent (dev stub)' } });
});

app.post('/api/v1/auth/resend-verification', (req, res) => {
  res.json({ success: true, data: { message: 'Verification email sent (dev stub)' } });
});

app.post('/api/v1/auth/resend-verification-public', (req, res) => {
  res.json({ success: true, data: { message: 'Verification email sent (dev stub)' } });
});

// ─── API: Entitlements ────────────────────────────────────────────────────────
// Returns full pro plan with all features unlocked (value: -1 = unlimited quota)
app.get('/api/v1/entitlements', (req, res) => {
  res.json({
    success: true,
    data: {
      plan: { slug: 'pro', name: 'Pro' },
      features: PRO_FEATURES,
      usage: {},      // server usage_today = 0 for all features
    },
    meta: { version: 1, cached: false }
  });
});

// ─── API: Plans ──────────────────────────────────────────────────────────────
app.get('/api/v1/plans', (req, res) => {
  res.json({
    success: true,
    data: [
      { slug: 'free', name: 'Free', price: 0 },
      { slug: 'pro', name: 'Pro', price: 9.99 }
    ]
  });
});

// ─── API: Config Versions ─────────────────────────────────────────────────────
app.get('/api/v1/config/versions', (req, res) => {
  res.json({
    success: true,
    data: {
      provider_models: 1,
      provider_configs: 1,
      api_configs: 1,
      execution_config: 1
    }
  });
});

// ─── API: Workflow Templates ──────────────────────────────────────────────────
app.get('/api/v1/workflow-templates/categories', (req, res) => {
  res.json({ success: true, data: [] });
});
app.get('/api/v1/workflow-templates', (req, res) => {
  res.json({
    success: true,
    data: [],
    meta: { total: 0, page: 1, per_page: 20 }
  });
});

// ─── API: Templates (alias) ────────────────────────────────────────────────────
app.get('/api/v1/templates/categories', (req, res) => {
  res.json({ success: true, data: [] });
});
app.get('/api/v1/templates', (req, res) => {
  res.json({
    success: true,
    data: [],
    meta: { total: 0, page: 1, per_page: 20 }
  });
});

// ─── API: Settings (user settings sync) ──────────────────────────────────────
let _userSettings = {};
app.get('/api/v1/settings', (req, res) => {
  res.json({ success: true, data: _userSettings });
});
app.put('/api/v1/settings', (req, res) => {
  if (req.body?.settings_json) {
    _userSettings = { ..._userSettings, ...req.body.settings_json };
  }
  res.json({ success: true, data: _userSettings });
});

// ─── API: Workflows CRUD ──────────────────────────────────────────────────────
let _workflows = [
  {
    id: 1, wf_id: 'wf_demo_001', wf_name: 'Demo Workflow - Landscape',
    name: 'Demo Workflow - Landscape', description: 'Tạo ảnh phong cảnh tự động',
    status: 'idle', enabled: true, platform: 'flow',
    project_id: null, project_name: null,
    nodes_count: 2, run_count: 5,
    created_at: '2026-05-01T10:00:00Z', updated_at: '2026-06-01T10:00:00Z',
    user: { id: 1, name: 'Dev Admin (Local)' }
  },
  {
    id: 2, wf_id: 'wf_demo_002', wf_name: 'Batch Portrait Generator',
    name: 'Batch Portrait Generator', description: 'Chạy batch tạo ảnh chân dung',
    status: 'idle', enabled: true, platform: 'flow',
    project_id: null, project_name: null,
    nodes_count: 3, run_count: 12,
    created_at: '2026-04-15T08:30:00Z', updated_at: '2026-05-28T14:20:00Z',
    user: { id: 1, name: 'Dev Admin (Local)' }
  }
];
let _wfIdCounter = 3;

app.get('/api/v1/workflows', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.per_page) || 20;
  const start = (page - 1) * perPage;
  const paged = _workflows.slice(start, start + perPage);
  res.json({
    success: true,
    data: paged,
    meta: { current_page: page, last_page: Math.ceil(_workflows.length / perPage) || 1, per_page: perPage, total: _workflows.length }
  });
});
app.get('/api/v1/workflows/:wfId', (req, res) => {
  const wf = _workflows.find(w => w.wf_id === req.params.wfId);
  if (!wf) return res.status(404).json({ success: false, error: 'Workflow not found' });
  res.json({ success: true, data: wf });
});
app.post('/api/v1/workflows', (req, res) => {
  const wfId = `wf_${Date.now()}_${_wfIdCounter++}`;
  const wf = {
    id: _wfIdCounter, wf_id: wfId,
    wf_name: req.body.name || req.body.wf_name || 'New Workflow',
    name: req.body.name || req.body.wf_name || 'New Workflow',
    description: req.body.description || '',
    status: 'idle', enabled: true, platform: req.body.platform || 'flow',
    project_id: req.body.project_id || null,
    project_name: req.body.project_name || null,
    nodes_count: 0, run_count: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    user: { id: 1, name: 'Dev Admin (Local)' },
    ...req.body
  };
  wf.wf_id = wfId;
  _workflows.unshift(wf);
  res.json({ success: true, data: wf });
});
app.put('/api/v1/workflows/:wfId', (req, res) => {
  const idx = _workflows.findIndex(w => w.wf_id === req.params.wfId);
  if (idx < 0) return res.status(404).json({ success: false, error: 'Workflow not found' });
  _workflows[idx] = { ..._workflows[idx], ...req.body, updated_at: new Date().toISOString() };
  res.json({ success: true, data: _workflows[idx] });
});
app.delete('/api/v1/workflows/:wfId', (req, res) => {
  _workflows = _workflows.filter(w => w.wf_id !== req.params.wfId);
  res.json({ success: true });
});
app.post('/api/v1/workflows/bulk-save', (req, res) => {
  res.json({ success: true, data: { saved: 0 } });
});
app.post('/api/v1/workflows/:wfId/reset', (req, res) => {
  const wf = _workflows.find(w => w.wf_id === req.params.wfId);
  if (wf) { wf.status = 'idle'; wf.updated_at = new Date().toISOString(); }
  res.json({ success: true, data: wf || {} });
});

// ─── API: Workflow Nodes ──────────────────────────────────────────────────────
let _wfNodes = {};
app.get('/api/v1/workflows/:wfId/nodes', (req, res) => {
  res.json({ success: true, data: _wfNodes[req.params.wfId] || [] });
});
app.post('/api/v1/workflows/:wfId/nodes', (req, res) => {
  const wfId = req.params.wfId;
  if (!_wfNodes[wfId]) _wfNodes[wfId] = [];
  const node = { id: Date.now(), node_id: `node_${Date.now()}`, ...req.body, created_at: new Date().toISOString() };
  _wfNodes[wfId].push(node);
  res.json({ success: true, data: node });
});
app.put('/api/v1/workflows/:wfId/nodes/:nodeId', (req, res) => {
  const nodes = _wfNodes[req.params.wfId] || [];
  const idx = nodes.findIndex(n => n.node_id === req.params.nodeId);
  if (idx >= 0) nodes[idx] = { ...nodes[idx], ...req.body };
  res.json({ success: true, data: idx >= 0 ? nodes[idx] : req.body });
});
app.delete('/api/v1/workflows/:wfId/nodes/:nodeId', (req, res) => {
  if (_wfNodes[req.params.wfId]) {
    _wfNodes[req.params.wfId] = _wfNodes[req.params.wfId].filter(n => n.node_id !== req.params.nodeId);
  }
  res.json({ success: true });
});
app.patch('/api/v1/workflows/:wfId/nodes/:nodeId/status', (req, res) => {
  res.json({ success: true, data: { node_id: req.params.nodeId, ...req.body } });
});

// ─── API: Workflow Edges ──────────────────────────────────────────────────────
let _wfEdges = {};
app.get('/api/v1/workflows/:wfId/edges', (req, res) => {
  res.json({ success: true, data: _wfEdges[req.params.wfId] || [] });
});
app.post('/api/v1/workflows/:wfId/edges', (req, res) => {
  const wfId = req.params.wfId;
  if (!_wfEdges[wfId]) _wfEdges[wfId] = [];
  const edge = { id: Date.now(), edge_id: `edge_${Date.now()}`, ...req.body };
  _wfEdges[wfId].push(edge);
  res.json({ success: true, data: edge });
});
app.delete('/api/v1/workflows/:wfId/edges/:edgeId', (req, res) => {
  if (_wfEdges[req.params.wfId]) {
    _wfEdges[req.params.wfId] = _wfEdges[req.params.wfId].filter(e => e.edge_id !== req.params.edgeId);
  }
  res.json({ success: true });
});

// ─── API: Shared Workflows ────────────────────────────────────────────────────
app.get('/api/v1/shared-workflows', (req, res) => {
  res.json({ success: true, data: [], meta: { total: 0, page: 1, per_page: 20 } });
});

// ─── API: Tasks CRUD ──────────────────────────────────────────────────────────
let _tasks = [
  {
    id: 1, task_id: 'task_demo_001', name: 'Tạo ảnh banner website',
    prompt: 'Modern website banner with gradient colors, minimalist design',
    provider: 'flow', status: 'completed', platform: 'flow',
    settings: { ratio: '16:9', quantity: 2, model: 'flow-image' },
    project_id: null, project_name: null,
    file_ids: [], result_count: 2,
    created_at: '2026-05-20T09:00:00Z', updated_at: '2026-05-20T09:15:00Z',
    user: { id: 1, name: 'Dev Admin (Local)' }
  },
  {
    id: 2, task_id: 'task_demo_002', name: 'Chạy batch logo design',
    prompt: 'Professional logo design, flat style, tech company',
    provider: 'flow', status: 'pending', platform: 'flow',
    settings: { ratio: '1:1', quantity: 4, model: 'flow-image' },
    project_id: null, project_name: null,
    file_ids: [], result_count: 0,
    created_at: '2026-06-01T14:00:00Z', updated_at: '2026-06-01T14:00:00Z',
    user: { id: 1, name: 'Dev Admin (Local)' }
  }
];
let _taskIdCounter = 3;

app.get('/api/v1/tasks', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.per_page) || 20;
  const start = (page - 1) * perPage;
  const paged = _tasks.slice(start, start + perPage);
  res.json({
    success: true,
    data: paged,
    meta: { current_page: page, last_page: Math.ceil(_tasks.length / perPage) || 1, per_page: perPage, total: _tasks.length }
  });
});
app.get('/api/v1/tasks/:taskId', (req, res) => {
  const task = _tasks.find(t => t.task_id === req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: 'Task not found' });
  res.json({ success: true, data: task });
});
app.post('/api/v1/tasks', (req, res) => {
  const taskId = `task_${Date.now()}_${_taskIdCounter++}`;
  const task = {
    id: _taskIdCounter, task_id: taskId,
    name: req.body.name || 'New Task',
    prompt: req.body.prompt || '',
    provider: req.body.provider || 'flow',
    status: 'pending', platform: req.body.platform || 'flow',
    settings: req.body.settings || {},
    project_id: req.body.project_id || null,
    project_name: req.body.project_name || null,
    file_ids: [], result_count: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    user: { id: 1, name: 'Dev Admin (Local)' },
    ...req.body
  };
  task.task_id = taskId;
  _tasks.unshift(task);
  res.json({ success: true, data: task });
});
app.put('/api/v1/tasks/:taskId', (req, res) => {
  const idx = _tasks.findIndex(t => t.task_id === req.params.taskId);
  if (idx < 0) return res.status(404).json({ success: false, error: 'Task not found' });
  _tasks[idx] = { ..._tasks[idx], ...req.body, updated_at: new Date().toISOString() };
  res.json({ success: true, data: _tasks[idx] });
});
app.delete('/api/v1/tasks/:taskId', (req, res) => {
  _tasks = _tasks.filter(t => t.task_id !== req.params.taskId);
  res.json({ success: true });
});
app.patch('/api/v1/tasks/:taskId/status', (req, res) => {
  const task = _tasks.find(t => t.task_id === req.params.taskId);
  if (task) {
    task.status = req.body.status || task.status;
    task.updated_at = new Date().toISOString();
  }
  res.json({ success: true, data: task || {} });
});

// ─── API: History (execution records) ─────────────────────────────────────────
let _history = [
  {
    id: 1, execution_id: 'exec_001', prompt: 'beautiful sunset over ocean',
    provider: 'flow', model: 'flow-image', status: 'completed',
    settings: { ratio: '16:9', quantity: 1 },
    result_count: 1, duration_sec: 12,
    created_at: '2026-06-01T10:30:00Z',
    user: { id: 1, name: 'Dev Admin (Local)' }
  },
  {
    id: 2, execution_id: 'exec_002', prompt: 'futuristic city with flying cars',
    provider: 'flow', model: 'flow-image', status: 'completed',
    settings: { ratio: '16:9', quantity: 2 },
    result_count: 2, duration_sec: 25,
    created_at: '2026-06-02T15:45:00Z',
    user: { id: 1, name: 'Dev Admin (Local)' }
  },
  {
    id: 3, execution_id: 'exec_003', prompt: 'professional logo design for tech startup',
    provider: 'chatgpt', model: 'dall-e-3', status: 'completed',
    settings: { ratio: '1:1', quantity: 1 },
    result_count: 1, duration_sec: 8,
    created_at: '2026-06-03T07:00:00Z',
    user: { id: 1, name: 'Dev Admin (Local)' }
  }
];

app.get('/api/v1/history', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.per_page) || 20;
  const start = (page - 1) * perPage;
  const paged = _history.slice(start, start + perPage);
  res.json({
    success: true,
    data: paged,
    meta: { current_page: page, last_page: Math.ceil(_history.length / perPage) || 1, per_page: perPage, total: _history.length }
  });
});

// ─── API: Execution Complete/Cancel ───────────────────────────────────────────
app.post('/api/v1/execution/complete', (req, res) => {
  res.json({ success: true, data: { status: 'completed' } });
});
app.post('/api/v1/execution/cancel', (req, res) => {
  res.json({ success: true, data: { status: 'cancelled' } });
});

// ─── API: Notifications ───────────────────────────────────────────────────────
let _notifications = [
  {
    id: 1, type: 'system', title: 'Chào mừng đến AobyFlowss!',
    message: 'Extension đã được cài đặt thành công. Hãy bắt đầu tạo ảnh AI ngay!',
    read: false, created_at: '2026-06-03T08:00:00Z'
  }
];

app.get('/api/v1/notifications', (req, res) => {
  res.json({ success: true, data: _notifications, meta: { unread_count: _notifications.filter(n => !n.read).length } });
});
app.post('/api/v1/notifications/mark-read', (req, res) => {
  _notifications.forEach(n => n.read = true);
  res.json({ success: true });
});
app.delete('/api/v1/notifications', (req, res) => {
  _notifications = [];
  res.json({ success: true });
});

// ─── API: User Prompts (saved prompts) ────────────────────────────────────────
let _userPrompts = [
  {
    id: 1, prompt_id: 'prompt_001', name: 'Phong cảnh thiên nhiên',
    text: 'Beautiful natural landscape with mountains, rivers, sunset, photorealistic, 8K',
    tags: ['landscape', 'nature'], is_favorite: true,
    created_at: '2026-05-15T10:00:00Z', updated_at: '2026-05-15T10:00:00Z'
  },
  {
    id: 2, prompt_id: 'prompt_002', name: 'Logo công ty',
    text: 'Professional minimalist logo design, flat style, modern tech company, clean lines',
    tags: ['logo', 'design'], is_favorite: false,
    created_at: '2026-05-20T14:30:00Z', updated_at: '2026-05-20T14:30:00Z'
  }
];
let _promptIdCounter = 3;

app.get('/api/v1/prompts/user', (req, res) => {
  res.json({ success: true, data: _userPrompts });
});
app.post('/api/v1/prompts/user', (req, res) => {
  const promptId = `prompt_${Date.now()}_${_promptIdCounter++}`;
  const prompt = {
    id: _promptIdCounter, prompt_id: promptId,
    name: req.body.name || 'Untitled',
    text: req.body.text || req.body.prompt || '',
    tags: req.body.tags || [],
    is_favorite: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...req.body
  };
  _userPrompts.unshift(prompt);
  res.json({ success: true, data: prompt });
});
app.delete('/api/v1/prompts/user/:promptId', (req, res) => {
  _userPrompts = _userPrompts.filter(p => p.prompt_id !== req.params.promptId);
  res.json({ success: true });
});

// ─── API: Albums ──────────────────────────────────────────────────────────────
let _albums = [
  { id: 1, album_id: 'album_default', name: 'Mặc định', image_count: 3, created_at: '2026-05-01T00:00:00Z' },
  { id: 2, album_id: 'album_favorites', name: 'Yêu thích', image_count: 5, created_at: '2026-05-10T00:00:00Z' }
];

app.get('/api/v1/albums', (req, res) => {
  res.json({ success: true, data: _albums });
});
app.post('/api/v1/albums', (req, res) => {
  const album = {
    id: _albums.length + 1, album_id: `album_${Date.now()}`,
    name: req.body.name || 'New Album', image_count: 0,
    created_at: new Date().toISOString()
  };
  _albums.push(album);
  res.json({ success: true, data: album });
});

// ─── API: Snippets ────────────────────────────────────────────────────────────
app.get('/api/v1/snippets', (req, res) => {
  res.json({ success: true, data: [] });
});
app.post('/api/v1/snippets', (req, res) => {
  res.json({ success: true, data: { id: Date.now(), ...req.body } });
});

// ─── API: Preferred Currency ──────────────────────────────────────────────────
app.get('/api/v1/auth/me/preferred-currency', (req, res) => {
  res.json({ success: true, data: { currency: 'VND' } });
});
app.put('/api/v1/auth/me/preferred-currency', (req, res) => {
  res.json({ success: true, data: { currency: req.body.currency || 'VND' } });
});

// ─── API: Telegram ────────────────────────────────────────────────────────────
app.get('/api/v1/telegram/status', (req, res) => {
  res.json({ success: true, data: { linked: false, chat_id: null, bot_username: null } });
});
app.post('/api/v1/telegram/link', (req, res) => {
  res.json({ success: true, data: { linked: true, chat_id: req.body.chat_id, bot_username: 'AobyFlowBot' } });
});
app.post('/api/v1/telegram/unlink', (req, res) => {
  res.json({ success: true, data: { linked: false } });
});
app.post('/api/v1/telegram/otp', (req, res) => {
  res.json({ success: true, data: { code: '123456', expires_at: new Date(Date.now() + 300000).toISOString() } });
});

// ─── API: Events Poll (fallback for SSE) ──────────────────────────────────────
app.get('/api/v1/events/poll', (req, res) => {
  res.json({ success: true, data: [] });
});

// ─── API: Analytics ───────────────────────────────────────────────────────────
app.post('/api/v1/analytics/selector-failure', (req, res) => {
  console.log('[Local Server] Selector failure report:', JSON.stringify(req.body).slice(0, 200));
  res.json({ success: true });
});

// ─── API: SSE (stub) ──────────────────────────────────────────────────────────
app.get('/api/v1/sse/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Send a connected event then keep alive
  res.write('data: {"type":"connected"}\n\n');
  // Keep connection alive with heartbeat
  const interval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);
  req.on('close', () => clearInterval(interval));
});
app.post('/api/v1/sse/end-session', (req, res) => res.json({ success: true }));

app.get('/api/v1/sse/subscribe-token', (req, res) => {
  res.json({
    success: true,
    data: {
      token: 'mock-mercure-token',
      hub_url: 'http://localhost:3000/api/v1/sse/stream'
    }
  });
});

app.post('/api/v1/sse/ticket', (req, res) => {
  res.json({
    success: true,
    data: { ticket: 'mock-sse-ticket' }
  });
});

// ─── API: Node Templates ──────────────────────────────────────────────────────
app.get('/api/v1/workflow-node-types', (req, res) => {
  res.json({ success: true, data: [] });
});

// ─── API: Addon Prompts ────────────────────────────────────────────────────────
app.get('/api/v1/addon-prompts', (req, res) => {
  res.json({ success: true, data: [] });
});

// ─── API: Announcement ────────────────────────────────────────────────────────
app.get('/api/v1/announcement', (req, res) => {
  res.json({ success: true, data: null });
});

// ─── API: Execution Request ───────────────────────────────────────────────────
app.post('/api/v1/execution/request', (req, res) => {
  res.json({
    success: true,
    data: {
      allowed: true,
      token: 'dev-exec-token-123',
      reason: 'SERVER_APPROVED',
      remaining: 999,
      limit: 999,
      used: 0,
      global_remaining: 999,
      global_limit: 999,
      global_used: 0,
      reset_at: null,
      reset_at_sec: null
    }
  });
});

// ─── API: Usage (fire-and-forget, ignore) ─────────────────────────────────────
app.post('/api/v1/usage/heartbeat', (req, res) => res.json({ success: true }));
app.post('/api/v1/usage/session-end', (req, res) => res.json({ success: true }));
app.post('/api/v1/usage/session-start', (req, res) => res.json({ success: true }));
app.post('/api/v1/analytics/event', (req, res) => res.json({ success: true }));

// ─── Fallback catch-all ────────────────────────────────────────────────────────
app.use((req, res) => {
  console.log(`[Local Server] Fallback handler hit: ${req.method} ${req.url}`);
  res.json({ success: true, data: {} });
});

app.listen(PORT, () => {
  console.log(`[Local Server] Running on http://localhost:${PORT}`);
  console.log('[Local Server] All endpoints ready with proper data structures');
});
