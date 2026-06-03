const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (!req.path.includes('health')) console.log(`[REQ] ${req.method} ${req.path}${Object.keys(req.query).length ? '?' + new URLSearchParams(req.query) : ''}`);
  next();
});

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
        delay_between_prompts_sec: 5,
        input_timeout_ms: 2000
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
  res.json({
    success: true,
    data: {
      humanizedMode: true,
      humanizedSpeed: 0.5,
      inputTimeout: 2000,
      randomDelayMin: 3,
      randomDelayMax: 8,
      defaultVideoInputType: 'frames'
    }
  });
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
          // Model labels for selectChatGPTModel — text matching in model menu
          chatgpt_model_labels: {
            'dall-e-3': 'DALL·E 3|DALL-E 3|DALL·E|dalle',
            'gpt-4o': '4o|GPT-4o|Instant',
            'o4-mini-high': 'o4-mini-high|Thinking'
          },
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
          // Composer / editor (ProseMirror contenteditable div)
          composer: { selectors: ["div.ProseMirror#prompt-textarea", "div#prompt-textarea[contenteditable='true']", "div[contenteditable='true']#prompt-textarea"] },
          textarea: { selectors: ["div#prompt-textarea", "textarea#prompt-textarea", "div[contenteditable='true']#prompt-textarea"] },
          // Submit / Send button
          submit_button: { selectors: ["button[data-testid='send-button']", "button#composer-submit-button", "button[aria-label='Send prompt']", "button.composer-submit-btn"] },
          // Model switcher dropdown
          model_switcher_button: { selectors: ["button[data-testid='model-switcher-dropdown-button']", "button[aria-label='Model selector']"] },
          // Composer plus button (attach files menu)
          plus_button: { selectors: ["button[data-testid='composer-plus-btn']", "button[aria-label='Add files and more']", "button[aria-label='Đính kèm tệp và nhiều tính năng khác']"] },
          // Open menu (dropdown from plus button)
          open_menu: { selectors: ["div[data-radix-popper-content-wrapper] [role='menu']", "div[role='menu']", "div[data-radix-menu-content]"] },
          // Menu items inside the dropdown
          menu_items: { selectors: ["div[role='menu'] [role='menuitemcheckbox']", "div[role='menu'] [role='menuitem']", "div[role='menu'] [role='menuitemradio']"] },
          // Mode menu item (for model selection menu)
          mode_menu_item: { selectors: ["[role='menuitemradio']", "[role='option']"] },
          // Ratio button (appears when image mode is active)
          ratio_button: { selectors: ["button[data-testid='image-aspect-ratio-button']", "button[aria-label*='aspect']", "button[aria-label*='ratio']"] },
          // New chat button
          new_chat_button: { selectors: ["a[data-testid='create-new-chat-button']", "button[data-testid='create-new-chat-button']", "a[aria-label='New chat']"] },
          // Stop generating button
          stop_button: { selectors: ["button[data-testid='stop-button']", "button[aria-label='Stop generating']", "button[aria-label='Stop']"] },
          // Response containers
          response_container: { selectors: ["div[data-message-author-role='assistant']"] },
          response_text_content: { selectors: ["div[data-message-author-role='assistant'] .markdown", "div[data-message-author-role='assistant'] .whitespace-pre-wrap"] },
          // Image generation results
          generated_image: { selectors: ["img[alt='Generated image']", "img[data-testid='generated-image']", "div[data-message-author-role='assistant'] img[src*='oaidalleapi']", "div[data-message-author-role='assistant'] img[alt]"] },
          image_container: { selectors: ["img[alt='Generated image']", "img[data-testid='generated-image']"] },
          // Generating/thinking indicators
          generating_indicator: { selectors: ["button[data-testid='stop-button']", "div[class*='result-streaming']", "div[class*='agent-turn']"] },
          thinking_indicator: { selectors: ["div[class*='thinking']", "details.thought-container"] },
          // Conversation turns
          assistant_turn: { selectors: ["div[data-message-author-role='assistant']"] },
          conversation_turn: { selectors: ["div[data-testid^='conversation-turn-']", "div[data-message-id]"] },
          message_author: { selectors: ["div[data-message-author-role]"] },
          // File/image upload
          file_input: { selectors: ["input[data-testid='upload-photos-input']", "input[type='file']"] },
          remove_ref_image_button: { selectors: ["button[aria-label='Remove file']", "button[aria-label='Remove']"] },
          // Image action buttons (download, etc.)
          image_action_buttons: { selectors: ["div[data-message-author-role='assistant'] button[aria-label]"] },
          // ParaGen container
          paragen_container: { selectors: ["div[class*='paragen']", "div[data-testid*='paragen']"] },
          // CDN image pattern
          cdn_image: { selectors: ["img[src*='oaidalleapi']", "img[src*='openai']"] },
          // Cloudflare challenge
          cloudflare_iframe: { selectors: ["iframe[src*='challenges.cloudflare.com']"] },
          challenge_overlay: { selectors: ["div[id*='challenge']", "div[class*='challenge']"] },
          // Delete chat
          delete_chat_menu_item: { selectors: ["[role='menuitem'][data-testid*='delete']", "[role='menuitem']"] }
        },
        name: 'ChatGPT', status: 'active', config_version: 3
      },
      grok: {
        selectors: {
          // Composer (ProseMirror or contenteditable)
          composer: { selectors: ["div[aria-label='Ask Grok anything']", "div.ProseMirror[contenteditable='true']", "div[contenteditable='true'][role='textbox']", "div[role='textbox']"] },
          editor: { selectors: ["div[aria-label='Ask Grok anything']", "div.ProseMirror[contenteditable='true']", "div[role='textbox']"] },
          // Submit button
          submit_button: { selectors: ["button[aria-label='Submit']", "button[type='submit']"] },
          // Generation mode (Image/Video toggle)
          generation_mode: { selectors: ["button[aria-label='Canvas']", "button:has(> div:contains('Image'))"] },
          // Ratio button
          ratio_button: { selectors: ["button[aria-label='Aspect Ratio']"] },
          // Image quality picker
          image_quality_picker: { selectors: ["button[aria-label='Quality']", "button[aria-label='Image Quality']"] },
          // Video duration/resolution
          video_duration_picker: { selectors: ["button[aria-label='Duration']"] },
          video_resolution_picker: { selectors: ["button[aria-label='Resolution']"] },
          // Result containers
          result_container: { selectors: ["div[class*='message']", "div[class*='response']"] },
          result_feed_section: { selectors: ["div[class*='feed']", "section[class*='result']"] },
          // CDN images
          grok_cdn_image: { selectors: ["img[src*='x.ai']", "img[src*='grok']"] },
          // Stop button
          stop_button: { selectors: ["button[aria-label='Stop']", "button[aria-label='Cancel']"] },
          // Open menu
          open_menu: { selectors: ["div[role='menu']", "div[role='listbox']"] },
          // File input
          file_input: { selectors: ["input[type='file']"] },
          // Upload indicators
          upload_loading_indicator: { selectors: ["div[class*='loading']", "div[class*='upload']"] },
          upload_error_icon: { selectors: ["div[class*='error']"] },
          // Remove image button
          remove_image_button: { selectors: ["button[aria-label='Remove']", "button[aria-label='Delete']"] },
          remove_image_button_broad: { selectors: ["button[class*='remove']", "button[class*='delete']"] },
          // Saved/liked button
          saved_button: { selectors: ["button[aria-label='Save']", "button[aria-label='Like']"] },
          // Navigation
          imagine_link: { selectors: ["a[href*='/imagine']", "a[href*='imagine']"] },
          back_button: { selectors: ["button[aria-label='Back']", "a[aria-label='Back']"] },
          // Auth
          auth_link: { selectors: ["a[href*='login']", "button:has-text('Sign in')"] },
          // Cloudflare
          cloudflare_turnstile: { selectors: ["div[id*='turnstile']", "div[class*='turnstile']"] },
          cloudflare_iframe: { selectors: ["iframe[src*='challenges.cloudflare.com']"] },
          // Age verification
          age_verification_modal: { selectors: ["div[role='dialog']", "div[class*='modal']"] }
        },
        name: 'Grok', status: 'active', config_version: 3
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
  res.json({ success: true, data: [
    { id: 1, name: 'Image Generation', slug: 'image-generation', description: 'Tạo ảnh với các provider AI', icon: 'image', count: 3 },
    { id: 2, name: 'Video Generation', slug: 'video-generation', description: 'Tạo video ngắn bằng AI', icon: 'video_camera', count: 1 },
    { id: 3, name: 'Multi-Provider', slug: 'multi-provider', description: 'Kết hợp nhiều AI provider', icon: 'merge', count: 2 },
    { id: 4, name: 'Text Processing', slug: 'text-processing', description: 'Xử lý text, viết prompt tự động', icon: 'text', count: 1 },
    { id: 5, name: 'Automation', slug: 'automation', description: 'Tự động hoá quy trình', icon: 'generate', count: 1 }
  ] });
});
let _wfTemplates = [
  {
    id: 1, name: 'Flow: Landscape Generator', description: 'Tạo ảnh phong cảnh bằng Google Flow với auto-download',
    category_id: 1, category: { id: 1, name: 'Image Generation' },
    thumbnail: '', preview_url: '',
    provider: 'flow', difficulty: 'easy', is_premium: false,
    nodes_count: 3, avg_rating: 4.6, ratings_count: 25, usage_count: 150,
    tags: ['landscape', 'flow', 'download'],
    nodes: [
      { node_type: 'text', node_name: 'Prompt nguồn', prompt: 'Beautiful landscape with mountains and lake', pos_x: 100, pos_y: 150 },
      { node_type: 'generate', node_name: 'Flow Generate', media_type: 'Image', ratio: '16:9', quantity: 2, pos_x: 400, pos_y: 150 },
      { node_type: 'download', node_name: 'Download', download_resolution: '1k', pos_x: 700, pos_y: 150 }
    ],
    edges: [
      { source_node_index: 0, target_node_index: 1, source_port: 'text', target_port: 'text' },
      { source_node_index: 1, target_node_index: 2, source_port: 'media', target_port: 'media_in' }
    ],
    author: { id: 1, name: 'AobyFlowss' },
    created_at: '2026-05-01T10:00:00Z', updated_at: '2026-06-01T10:00:00Z'
  },
  {
    id: 2, name: 'ChatGPT: Portrait Maker', description: 'Tạo ảnh chân dung bằng ChatGPT với AI Agent viết prompt',
    category_id: 1, category: { id: 1, name: 'Image Generation' },
    thumbnail: '', preview_url: '',
    provider: 'chatgpt', difficulty: 'medium', is_premium: false,
    nodes_count: 3, avg_rating: 4.3, ratings_count: 18, usage_count: 89,
    tags: ['portrait', 'chatgpt', 'ai-agent'],
    nodes: [
      { node_type: 'prompt', node_name: 'AI Agent', prompt: 'Viết prompt chi tiết cho ảnh chân dung', use_ai: true, provider: 'chatgpt', pos_x: 100, pos_y: 200 },
      { node_type: 'chatgpt', node_name: 'ChatGPT Generate', ratio: 'portrait', pos_x: 400, pos_y: 200 },
      { node_type: 'download', node_name: 'Download', download_resolution: '1k', pos_x: 700, pos_y: 200 }
    ],
    edges: [
      { source_node_index: 0, target_node_index: 1, source_port: 'text', target_port: 'text' },
      { source_node_index: 1, target_node_index: 2, source_port: 'media', target_port: 'media_in' }
    ],
    author: { id: 1, name: 'AobyFlowss' },
    created_at: '2026-04-20T08:00:00Z', updated_at: '2026-05-25T14:00:00Z'
  },
  {
    id: 3, name: 'Grok: Video Creator', description: 'AI viết kịch bản, trích xuất prompt, Grok tạo video',
    category_id: 2, category: { id: 2, name: 'Video Generation' },
    thumbnail: '', preview_url: '',
    provider: 'grok', difficulty: 'hard', is_premium: true,
    nodes_count: 4, avg_rating: 4.8, ratings_count: 12, usage_count: 45,
    tags: ['video', 'grok', 'text-extract', 'ai-agent'],
    nodes: [
      { node_type: 'prompt', node_name: 'AI Agent', prompt: 'Viết kịch bản video', use_ai: true, pos_x: 100, pos_y: 200 },
      { node_type: 'text_extract', node_name: 'Extract Prompt', extract_mode: 'marker', extract_marker: 'PROMPT', pos_x: 400, pos_y: 200 },
      { node_type: 'grok', node_name: 'Grok Video', grok_mode: 'video', ratio: 'widescreen', pos_x: 700, pos_y: 200 },
      { node_type: 'download', node_name: 'Download', download_resolution: '720p', pos_x: 1000, pos_y: 200 }
    ],
    edges: [
      { source_node_index: 0, target_node_index: 1, source_port: 'text', target_port: 'text' },
      { source_node_index: 1, target_node_index: 2, source_port: 'text', target_port: 'text' },
      { source_node_index: 2, target_node_index: 3, source_port: 'media', target_port: 'media_in' }
    ],
    author: { id: 1, name: 'AobyFlowss' },
    created_at: '2026-05-15T12:00:00Z', updated_at: '2026-06-01T09:00:00Z'
  },
  {
    id: 4, name: 'Multi-AI Pipeline', description: 'Flow tạo ảnh gốc → ChatGPT enhance → Telegram gửi kết quả',
    category_id: 3, category: { id: 3, name: 'Multi-Provider' },
    thumbnail: '', preview_url: '',
    provider: 'multi', difficulty: 'hard', is_premium: true,
    nodes_count: 5, avg_rating: 4.9, ratings_count: 8, usage_count: 30,
    tags: ['multi-provider', 'flow', 'chatgpt', 'telegram'],
    nodes: [
      { node_type: 'prompt', node_name: 'AI Agent', use_ai: true, pos_x: 50, pos_y: 200 },
      { node_type: 'generate', node_name: 'Flow', media_type: 'Image', pos_x: 300, pos_y: 100 },
      { node_type: 'chatgpt', node_name: 'ChatGPT', pos_x: 300, pos_y: 350 },
      { node_type: 'delay', node_name: 'Wait', delay_seconds: 5, pos_x: 550, pos_y: 200 },
      { node_type: 'telegram', node_name: 'Telegram', pos_x: 800, pos_y: 200 }
    ],
    edges: [
      { source_node_index: 0, target_node_index: 1 },
      { source_node_index: 0, target_node_index: 2 },
      { source_node_index: 1, target_node_index: 3 },
      { source_node_index: 2, target_node_index: 3 },
      { source_node_index: 3, target_node_index: 4 }
    ],
    author: { id: 1, name: 'AobyFlowss' },
    created_at: '2026-05-10T16:00:00Z', updated_at: '2026-06-02T11:00:00Z'
  },
  {
    id: 5, name: 'Ref Image Remix', description: 'Upload ảnh tham chiếu → ChatGPT tạo lại với style mới',
    category_id: 1, category: { id: 1, name: 'Image Generation' },
    thumbnail: '', preview_url: '',
    provider: 'chatgpt', difficulty: 'easy', is_premium: false,
    nodes_count: 3, avg_rating: 4.4, ratings_count: 30, usage_count: 200,
    tags: ['reference', 'chatgpt', 'remix', 'style-transfer'],
    nodes: [
      { node_type: 'image', node_name: 'Reference', pos_x: 100, pos_y: 200 },
      { node_type: 'chatgpt', node_name: 'ChatGPT Remix', prompt: 'Recreate in watercolor style', pos_x: 400, pos_y: 200 },
      { node_type: 'download', node_name: 'Download', pos_x: 700, pos_y: 200 }
    ],
    edges: [
      { source_node_index: 0, target_node_index: 1, source_port: 'media', target_port: 'image_ref' },
      { source_node_index: 1, target_node_index: 2, source_port: 'media', target_port: 'media_in' }
    ],
    author: { id: 1, name: 'AobyFlowss' },
    created_at: '2026-04-25T09:00:00Z', updated_at: '2026-05-30T15:00:00Z'
  }
];
app.get('/api/v1/workflow-templates', (req, res) => {
  let filtered = [..._wfTemplates];
  if (req.query.category_id) filtered = filtered.filter(t => t.category_id === parseInt(req.query.category_id));
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    filtered = filtered.filter(t => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || (t.tags || []).some(tag => tag.includes(q)));
  }
  if (req.query.difficulty) filtered = filtered.filter(t => t.difficulty === req.query.difficulty);
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.per_page) || 20;
  const start = (page - 1) * perPage;
  res.json({
    success: true,
    data: filtered.slice(start, start + perPage),
    meta: { total: filtered.length, page, per_page: perPage, last_page: Math.ceil(filtered.length / perPage) || 1 }
  });
});
app.get('/api/v1/workflow-templates/:id', (req, res) => {
  const tpl = _wfTemplates.find(t => t.id === parseInt(req.params.id));
  if (!tpl) return res.status(404).json({ success: false, error: 'Template not found' });
  res.json({ success: true, data: tpl });
});
app.post('/api/v1/workflow-templates/:id/use', (req, res) => {
  const tpl = _wfTemplates.find(t => t.id === parseInt(req.params.id));
  if (tpl) tpl.usage_count = (tpl.usage_count || 0) + 1;
  res.json({ success: true, data: { template_id: req.params.id, used_at: new Date().toISOString() } });
});
app.post('/api/v1/workflow-templates/:id/rate', (req, res) => {
  const tpl = _wfTemplates.find(t => t.id === parseInt(req.params.id));
  if (tpl) {
    tpl.ratings_count = (tpl.ratings_count || 0) + 1;
    tpl.user_rating = req.body.rating;
  }
  res.json({ success: true, data: { template_id: req.params.id, rating: req.body.rating, user_rating: req.body.rating } });
});
app.post('/api/v1/workflow-templates/:id/clone', (req, res) => {
  const tpl = _wfTemplates.find(t => t.id === parseInt(req.params.id));
  if (!tpl) return res.status(404).json({ success: false, error: 'Template not found' });
  const wfId = `wf_${Date.now()}_${_wfIdCounter++}`;
  const wf = {
    id: _wfIdCounter, wf_id: wfId,
    wf_name: (tpl.name || 'Template') + ' (Import)',
    name: (tpl.name || 'Template') + ' (Import)',
    description: tpl.description || '',
    status: 'idle', enabled: true, platform: tpl.provider || 'flow',
    project_id: null, project_name: null,
    nodes_count: tpl.nodes_count || 0, run_count: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    user: { id: 1, name: 'Dev Admin (Local)' }
  };
  _workflows.unshift(wf);
  // Clone nodes
  if (tpl.nodes) {
    _wfNodes[wfId] = tpl.nodes.map((n, i) => ({
      id: Date.now() + i, node_id: `node_${Date.now()}_${i}`, ...n,
      enabled: true, status: 'pending', created_at: new Date().toISOString()
    }));
  }
  res.json({ success: true, data: wf });
});

// ─── API: Templates (alias) ────────────────────────────────────────────────────
app.get('/api/v1/templates/categories', (req, res) => {
  res.json({ success: true, data: [] });
});
app.get('/api/v1/templates', (req, res) => {
  res.json({
    success: true,
    data: [
      { id: 1, name: 'Phong cảnh thiên nhiên', prompt: 'Beautiful natural landscape with mountains and rivers, photorealistic, 8K', category: 'landscape', media_type: 'Image', difficulty: 'easy', is_premium: false, usage_count: 150, rating: 4.5, author: 'TobyFlow', preview_url: '' },
      { id: 2, name: 'Logo công nghệ', prompt: 'Professional minimalist tech company logo, flat design, modern', category: 'design', media_type: 'Image', difficulty: 'medium', is_premium: false, usage_count: 89, rating: 4.2, author: 'TobyFlow', preview_url: '' },
      { id: 3, name: 'Chân dung nghệ thuật', prompt: 'Artistic portrait, oil painting style, dramatic lighting, renaissance', category: 'portrait', media_type: 'Image', difficulty: 'hard', is_premium: true, usage_count: 200, rating: 4.8, author: 'TobyFlow', preview_url: '' }
    ],
    meta: { total: 3, page: 1, per_page: 20 }
  });
});
app.post('/api/v1/templates/:id/use', (req, res) => {
  res.json({ success: true, data: { template_id: req.params.id, used_at: new Date().toISOString() } });
});
app.post('/api/v1/templates/:id/rate', (req, res) => {
  res.json({ success: true, data: { template_id: req.params.id, rating: req.body.rating } });
});

// ─── API: Settings (user settings sync) ──────────────────────────────────────
let _userSettings = {
  humanizedMode: true,
  humanizedSpeed: 0.5,
  inputTimeout: 2000,
  randomDelayMin: 3,
  randomDelayMax: 8
};
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
    id: 1, wf_id: 'wf_demo_001', wf_name: 'Landscape + Download',
    name: 'Landscape + Download', description: 'Tạo ảnh phong cảnh bằng Flow rồi tự động download kết quả',
    status: 'idle', enabled: true, platform: 'flow',
    project_id: null, project_name: null,
    nodes_count: 3, progress_total: 3, run_count: 5,
    created_at: '2026-05-01T10:00:00Z', updated_at: '2026-06-01T10:00:00Z',
    user: { id: 1, name: 'Dev Admin (Local)' }
  },
  {
    id: 2, wf_id: 'wf_demo_002', wf_name: 'Multi-Provider Pipeline',
    name: 'Multi-Provider Pipeline', description: 'AI Agent viết prompt → Flow tạo ảnh → ChatGPT enhance → Telegram gửi kết quả',
    status: 'idle', enabled: true, platform: 'flow',
    project_id: null, project_name: null,
    nodes_count: 5, progress_total: 5, run_count: 12,
    created_at: '2026-04-15T08:30:00Z', updated_at: '2026-05-28T14:20:00Z',
    user: { id: 1, name: 'Dev Admin (Local)' }
  },
  {
    id: 3, wf_id: 'wf_demo_003', wf_name: 'Grok Video + Text Extract',
    name: 'Grok Video + Text Extract', description: 'Dùng AI Agent phân tích text, trích xuất keyword, rồi tạo video bằng Grok',
    status: 'idle', enabled: true, platform: 'grok',
    project_id: null, project_name: null,
    nodes_count: 4, progress_total: 4, run_count: 3,
    created_at: '2026-05-20T14:00:00Z', updated_at: '2026-06-02T09:00:00Z',
    user: { id: 1, name: 'Dev Admin (Local)' }
  },
  {
    id: 4, wf_id: 'wf_demo_004', wf_name: 'Ref Image → ChatGPT Remake',
    name: 'Ref Image → ChatGPT Remake', description: 'Upload ảnh tham chiếu, dùng ChatGPT tạo lại ảnh với style mới',
    status: 'idle', enabled: true, platform: 'chatgpt',
    project_id: null, project_name: null,
    nodes_count: 3, progress_total: 3, run_count: 8,
    created_at: '2026-05-10T11:00:00Z', updated_at: '2026-06-01T16:30:00Z',
    user: { id: 1, name: 'Dev Admin (Local)' }
  }
];
let _wfIdCounter = 5;

// ─── Seed workflow nodes ──────────────────────────────────────────────────────
let _wfNodes = {
  'wf_demo_001': [
    { id: 1, node_id: 'node_001_1', node_type: 'text', node_name: 'Prompt nguồn', slug: 'prompt-nguon', prompt: 'Beautiful landscape with mountains, lake, sunset, photorealistic 8K', slug_auto: true, enabled: true, status: 'pending', pos_x: 100, pos_y: 150, created_at: '2026-05-01T10:00:00Z' },
    { id: 2, node_id: 'node_001_2', node_type: 'generate', node_name: 'Tạo ảnh Flow', prompt: '', media_type: 'Image', ratio: '16:9', quantity: 2, model: null, auto_download: false, enabled: true, status: 'pending', pos_x: 400, pos_y: 150, created_at: '2026-05-01T10:01:00Z' },
    { id: 3, node_id: 'node_001_3', node_type: 'download', node_name: 'Download kết quả', download_resolution: '1k', download_folder: 'landscapes', download_collect_all: true, enabled: true, status: 'pending', pos_x: 700, pos_y: 150, created_at: '2026-05-01T10:02:00Z' }
  ],
  'wf_demo_002': [
    { id: 4, node_id: 'node_002_1', node_type: 'prompt', node_name: 'AI Agent - Viết prompt', prompt: 'Viết 1 prompt chi tiết để tạo ảnh chân dung phong cách Renaissance, dramatic lighting', use_ai: true, ai_fallback: true, ai_delete_after_run: true, provider: 'chatgpt', timeout_sec: 60, enabled: true, status: 'pending', pos_x: 50, pos_y: 200, created_at: '2026-04-15T08:30:00Z' },
    { id: 5, node_id: 'node_002_2', node_type: 'generate', node_name: 'Flow - Tạo ảnh', prompt: '', media_type: 'Image', ratio: '9:16', quantity: 1, model: null, auto_download: false, enabled: true, status: 'pending', pos_x: 350, pos_y: 100, created_at: '2026-04-15T08:31:00Z' },
    { id: 6, node_id: 'node_002_3', node_type: 'chatgpt', node_name: 'ChatGPT - Enhance', prompt: 'Recreate this image with more dramatic lighting and vibrant colors', ratio: 'story', use_fallback_prefix: 'auto', timeout_ms: 120000, max_ref_images: 4, auto_download: false, enabled: true, status: 'pending', pos_x: 350, pos_y: 350, created_at: '2026-04-15T08:32:00Z' },
    { id: 7, node_id: 'node_002_4', node_type: 'delay', node_name: 'Chờ 5 giây', delay_seconds: 5, enabled: true, status: 'pending', pos_x: 650, pos_y: 200, created_at: '2026-04-15T08:33:00Z' },
    { id: 8, node_id: 'node_002_5', node_type: 'telegram', node_name: 'Gửi Telegram', telegram_send_mode: 'group', telegram_message: 'Ảnh mới từ Multi-Provider Pipeline!', enabled: true, status: 'pending', pos_x: 900, pos_y: 200, created_at: '2026-04-15T08:34:00Z' }
  ],
  'wf_demo_003': [
    { id: 9, node_id: 'node_003_1', node_type: 'prompt', node_name: 'AI Agent - Phân tích', prompt: 'Phân tích chủ đề "cyberpunk city" và viết prompt video chi tiết. Trả về prompt trong [PROMPT]...[/PROMPT]', use_ai: true, ai_fallback: true, provider: 'chatgpt', timeout_sec: 60, enabled: true, status: 'pending', pos_x: 100, pos_y: 200, created_at: '2026-05-20T14:00:00Z' },
    { id: 10, node_id: 'node_003_2', node_type: 'text_extract', node_name: 'Trích xuất prompt', extract_mode: 'marker', extract_marker: 'PROMPT', extract_strict: false, extract_multi_match: 'first', extract_on_fail: 'skip_downstream', slug_auto: true, enabled: true, status: 'pending', pos_x: 400, pos_y: 200, created_at: '2026-05-20T14:01:00Z' },
    { id: 11, node_id: 'node_003_3', node_type: 'grok', node_name: 'Grok - Tạo video', prompt: '', grok_mode: 'video', ratio: 'widescreen', grok_duration: '6s', grok_resolution: '720p', grok_image_quality: 'speed', quantity: 1, timeout_ms: 180000, auto_download: false, enabled: true, status: 'pending', pos_x: 700, pos_y: 200, created_at: '2026-05-20T14:02:00Z' },
    { id: 12, node_id: 'node_003_4', node_type: 'download', node_name: 'Download video', download_resolution: '720p', download_folder: 'grok-videos', download_collect_all: false, enabled: true, status: 'pending', pos_x: 1000, pos_y: 200, created_at: '2026-05-20T14:03:00Z' }
  ],
  'wf_demo_004': [
    { id: 13, node_id: 'node_004_1', node_type: 'image', node_name: 'Ảnh tham chiếu', ref_file_ids: '', max_ref_images: 1, enabled: true, status: 'pending', pos_x: 100, pos_y: 200, created_at: '2026-05-10T11:00:00Z' },
    { id: 14, node_id: 'node_004_2', node_type: 'chatgpt', node_name: 'ChatGPT Remake', prompt: 'Recreate this image in watercolor painting style, soft colors, artistic', ratio: 'landscape', use_fallback_prefix: 'auto', timeout_ms: 120000, max_ref_images: 4, auto_download: false, enabled: true, status: 'pending', pos_x: 400, pos_y: 200, created_at: '2026-05-10T11:01:00Z' },
    { id: 15, node_id: 'node_004_3', node_type: 'download', node_name: 'Download', download_resolution: '1k', download_folder: 'chatgpt-remakes', download_collect_all: false, enabled: true, status: 'pending', pos_x: 700, pos_y: 200, created_at: '2026-05-10T11:02:00Z' }
  ]
};

// ─── Seed workflow edges ──────────────────────────────────────────────────────
let _wfEdges = {
  'wf_demo_001': [
    { id: 1, edge_id: 'edge_001_1', source_node_id: 'node_001_1', target_node_id: 'node_001_2', source_port: 'text', target_port: 'text', created_at: '2026-05-01T10:05:00Z' },
    { id: 2, edge_id: 'edge_001_2', source_node_id: 'node_001_2', target_node_id: 'node_001_3', source_port: 'media', target_port: 'media_in', created_at: '2026-05-01T10:06:00Z' }
  ],
  'wf_demo_002': [
    { id: 3, edge_id: 'edge_002_1', source_node_id: 'node_002_1', target_node_id: 'node_002_2', source_port: 'text', target_port: 'text', created_at: '2026-04-15T08:35:00Z' },
    { id: 4, edge_id: 'edge_002_2', source_node_id: 'node_002_1', target_node_id: 'node_002_3', source_port: 'text', target_port: 'text', created_at: '2026-04-15T08:36:00Z' },
    { id: 5, edge_id: 'edge_002_3', source_node_id: 'node_002_2', target_node_id: 'node_002_4', source_port: 'media', target_port: 'any_in', created_at: '2026-04-15T08:37:00Z' },
    { id: 6, edge_id: 'edge_002_4', source_node_id: 'node_002_3', target_node_id: 'node_002_4', source_port: 'media', target_port: 'any_in', created_at: '2026-04-15T08:38:00Z' },
    { id: 7, edge_id: 'edge_002_5', source_node_id: 'node_002_4', target_node_id: 'node_002_5', source_port: 'any_out', target_port: 'media_in', created_at: '2026-04-15T08:39:00Z' }
  ],
  'wf_demo_003': [
    { id: 8, edge_id: 'edge_003_1', source_node_id: 'node_003_1', target_node_id: 'node_003_2', source_port: 'text', target_port: 'text', created_at: '2026-05-20T14:05:00Z' },
    { id: 9, edge_id: 'edge_003_2', source_node_id: 'node_003_2', target_node_id: 'node_003_3', source_port: 'text', target_port: 'text', created_at: '2026-05-20T14:06:00Z' },
    { id: 10, edge_id: 'edge_003_3', source_node_id: 'node_003_3', target_node_id: 'node_003_4', source_port: 'media', target_port: 'media_in', created_at: '2026-05-20T14:07:00Z' }
  ],
  'wf_demo_004': [
    { id: 11, edge_id: 'edge_004_1', source_node_id: 'node_004_1', target_node_id: 'node_004_2', source_port: 'media', target_port: 'image_ref', created_at: '2026-05-10T11:05:00Z' },
    { id: 12, edge_id: 'edge_004_2', source_node_id: 'node_004_2', target_node_id: 'node_004_3', source_port: 'media', target_port: 'media_in', created_at: '2026-05-10T11:06:00Z' }
  ]
};

app.get('/api/v1/workflows', (req, res) => {
  let filtered = [..._workflows];
  if (req.query.platform) filtered = filtered.filter(w => w.platform === req.query.platform);
  if (req.query.search) {
    const q = req.query.search.toLowerCase();
    filtered = filtered.filter(w => (w.name || w.wf_name || '').toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q));
  }
  if (req.query.project_id) filtered = filtered.filter(w => String(w.project_id) === String(req.query.project_id));
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.per_page) || 20;
  const start = (page - 1) * perPage;
  const paged = filtered.slice(start, start + perPage);
  res.json({
    success: true,
    data: paged,
    meta: { current_page: page, last_page: Math.ceil(filtered.length / perPage) || 1, per_page: perPage, total: filtered.length }
  });
});
app.get('/api/v1/workflows/shared-with-me', (req, res) => {
  res.json({ success: true, data: { workflows: [] } });
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
  const payload = req.body || {};
  let savedCount = 0;
  // Save workflow metadata
  if (payload.workflow) {
    const idx = _workflows.findIndex(w => w.wf_id === payload.workflow.wf_id);
    if (idx >= 0) { _workflows[idx] = { ..._workflows[idx], ...payload.workflow, updated_at: new Date().toISOString() }; }
    else { _workflows.unshift({ id: _wfIdCounter++, ...payload.workflow, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); }
    savedCount++;
  }
  // Save nodes
  if (payload.nodes && payload.wf_id) {
    _wfNodes[payload.wf_id] = payload.nodes.map((n, i) => ({
      id: n.id || Date.now() + i, node_id: n.node_id || `node_${Date.now()}_${i}`, ...n, created_at: n.created_at || new Date().toISOString()
    }));
    savedCount += payload.nodes.length;
    // Auto-update progress_total on the workflow
    const wf = _workflows.find(w => w.wf_id === payload.wf_id);
    if (wf) { wf.nodes_count = payload.nodes.length; wf.progress_total = payload.nodes.length; }
  }
  // Save edges
  if (payload.edges && payload.wf_id) {
    _wfEdges[payload.wf_id] = payload.edges.map((e, i) => ({
      id: e.id || Date.now() + i, edge_id: e.edge_id || `edge_${Date.now()}_${i}`, ...e, created_at: e.created_at || new Date().toISOString()
    }));
    savedCount += payload.edges.length;
  }
  res.json({ success: true, data: { saved: savedCount } });
});
app.post('/api/v1/workflows/:wfId/reset', (req, res) => {
  const wf = _workflows.find(w => w.wf_id === req.params.wfId);
  if (wf) { wf.status = 'idle'; wf.updated_at = new Date().toISOString(); }
  res.json({ success: true, data: wf || {} });
});

// ─── API: Workflow Nodes ──────────────────────────────────────────────────────
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
  const nodes = _wfNodes[req.params.wfId] || [];
  const node = nodes.find(n => n.node_id === req.params.nodeId);
  if (node) { Object.assign(node, req.body); }
  res.json({ success: true, data: node || { node_id: req.params.nodeId, ...req.body } });
});

// ─── API: Workflow Edges ──────────────────────────────────────────────────────
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
// Moved above: shared-with-me is added before /:wfId route

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

// ─── API: History PATCH/DELETE ─────────────────────────────────────────────────
app.patch('/api/v1/history/:id/favorite', (req, res) => {
  const item = _history.find(h => h.id === parseInt(req.params.id));
  if (item) { item.is_favorite = !item.is_favorite; }
  res.json({ success: true, data: item || {} });
});
app.delete('/api/v1/history/:id', (req, res) => {
  _history = _history.filter(h => h.id !== parseInt(req.params.id));
  res.json({ success: true });
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

// Route variants: source code calls GET/POST /prompts, PUT/DELETE /prompts/:id
// Keep /prompts/user aliases for backward compatibility
app.get('/api/v1/prompts/user', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.per_page) || 20;
  const start = (page - 1) * perPage;
  const paged = _userPrompts.slice(start, start + perPage);
  res.json({ success: true, data: paged, meta: { current_page: page, last_page: Math.ceil(_userPrompts.length / perPage) || 1, per_page: perPage, total: _userPrompts.length } });
});
app.get('/api/v1/prompts', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const perPage = parseInt(req.query.per_page) || 20;
  const start = (page - 1) * perPage;
  const paged = _userPrompts.slice(start, start + perPage);
  res.json({ success: true, data: paged, meta: { current_page: page, last_page: Math.ceil(_userPrompts.length / perPage) || 1, per_page: perPage, total: _userPrompts.length } });
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
app.post('/api/v1/prompts', (req, res) => {
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
app.put('/api/v1/prompts/:id', (req, res) => {
  const idx = _userPrompts.findIndex(p => p.id === parseInt(req.params.id) || p.prompt_id === req.params.id);
  if (idx >= 0) {
    _userPrompts[idx] = { ..._userPrompts[idx], ...req.body, updated_at: new Date().toISOString() };
    res.json({ success: true, data: _userPrompts[idx] });
  } else {
    res.status(404).json({ success: false, error: 'Prompt not found' });
  }
});
app.delete('/api/v1/prompts/user/:promptId', (req, res) => {
  _userPrompts = _userPrompts.filter(p => p.prompt_id !== req.params.promptId);
  res.json({ success: true });
});
app.delete('/api/v1/prompts/:id', (req, res) => {
  _userPrompts = _userPrompts.filter(p => p.id !== parseInt(req.params.id) && p.prompt_id !== req.params.id);
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
  res.json({
    success: true,
    data: [
      {
        type: 'generate', name: 'Tạo ảnh/video (Flow)', description: 'Tạo ảnh hoặc video mới bằng Google Flow',
        icon: 'generate', color: 'generate', sort_order: 1, coming_soon: false,
        config: {
          defaults: { media_type: 'Image', ratio: '16:9', quantity: 1, model: null, video_input_type: 'Frames', video_duration: '6s' },
          validation: { prompt_max_length: 5000, max_ref_images: 10, max_quantity: 4 },
          ui: { show_model_picker: true, show_ratio_picker: true, show_quantity: true, show_video_toggle: true, show_ref_upload: true, show_voice_picker: true, supports_slug: true },
          ports: {
            in: [
              { name: 'image_ref', type: 'image', required: false, multiple: true, label: 'Reference images' },
              { name: 'text', type: 'text', required: false, multiple: false, label: 'Prompt text' },
              { name: 'frame_1', type: 'frame', required: false, multiple: false, label: 'Frame 1 (video)', visibleWhen: 'isVideoFrames' },
              { name: 'frame_2', type: 'frame', required: false, multiple: false, label: 'Frame 2 (video)', visibleWhen: 'isVideoFrames' }
            ],
            out: [{ name: 'media', type: 'image', label: 'Result', dynamicType: 'media_type' }]
          }
        }
      },
      {
        type: 'chatgpt', name: 'ChatGPT', description: 'Tạo ảnh qua ChatGPT (DALL·E / GPT-Image)',
        icon: 'chatgpt', color: 'chatgpt', sort_order: 2, coming_soon: false,
        config: {
          defaults: { ratio: 'story', use_fallback_prefix: 'auto', timeout_ms: 120000, max_ref_images: 4 },
          validation: { prompt_max_length: 4000, max_ref_images: 4 },
          ui: { show_ratio_picker: true, show_ref_upload: true, supports_slug: true },
          ports: {
            in: [
              { name: 'image_ref', type: 'image', required: false, multiple: true, label: 'Reference images' },
              { name: 'text', type: 'text', required: false, multiple: false, label: 'Prompt text' }
            ],
            out: [{ name: 'media', type: 'image', label: 'ChatGPT images' }]
          }
        }
      },
      {
        type: 'grok', name: 'Grok', description: 'Tạo ảnh/video qua Grok (xAI)',
        icon: 'grok', color: 'grok', sort_order: 3, coming_soon: false,
        config: {
          defaults: { ratio: 'widescreen', grok_mode: 'image', grok_duration: '6s', grok_resolution: '720p', grok_image_quality: 'speed', quantity: 1, timeout_ms: 180000, max_ref_images: 4 },
          validation: { prompt_max_length: 5000, max_ref_images: 4 },
          ui: { show_ratio_picker: true, show_ref_upload: true, show_mode_toggle: true, supports_slug: true },
          ports: {
            in: [
              { name: 'image_ref', type: 'image', required: false, multiple: true, label: 'Reference images' },
              { name: 'text', type: 'text', required: false, multiple: false, label: 'Prompt text' }
            ],
            out: [{ name: 'media', type: 'image', label: 'Result', dynamicType: 'grok_mode' }]
          }
        }
      },
      {
        type: 'prompt', name: 'AI Agent', description: 'Pass-through text hoặc dùng AI (ChatGPT/Gemini) để xử lý text — enhance prompt, viết kịch bản, phân tích ảnh, summarize, translate, brainstorm.',
        icon: 'prompt', color: 'prompt', sort_order: 4, coming_soon: false,
        config: {
          defaults: { use_ai: false, ai_fallback: true, ai_delete_after_run: true, provider: 'chatgpt', timeout_sec: 60, max_ref_images: 4 },
          validation: { prompt_max_length: 10000, max_ref_images: 4 },
          ui: { show_ai_toggle: true, show_provider_select: true, supports_slug: true },
          ports: {
            in: [
              { name: 'text', type: 'text', required: false, multiple: false, label: 'Prompt upstream' },
              { name: 'image_ref', type: 'image', required: false, multiple: true, label: 'Reference images', visibleWhen: 'enhance' }
            ],
            out: [{ name: 'text', type: 'text', label: 'Result text' }]
          }
        }
      },
      {
        type: 'text', name: 'Text', description: 'Static text/prompt source for @mentions',
        icon: 'text', color: 'text', sort_order: 5, coming_soon: false,
        config: {
          defaults: { prompt: '', slug_auto: true },
          ui: { supports_slug: true },
          ports: { in: [], out: [{ name: 'text', type: 'text', label: 'Text output' }] }
        }
      },
      {
        type: 'text_extract', name: 'Text Extract', description: 'Trích xuất text từ AI response (regex/JSON)',
        icon: 'text_extract', color: 'text_extract', sort_order: 6, coming_soon: false,
        config: {
          defaults: { extract_mode: 'marker', extract_marker: '', extract_regex: '', extract_strict: false, extract_multi_match: 'first', extract_on_fail: 'skip_downstream', slug_auto: true },
          ui: { supports_slug: true },
          ports: {
            in: [{ name: 'text', type: 'text', required: true, multiple: false, label: 'Input text' }],
            out: [{ name: 'text', type: 'text', label: 'Extracted text' }]
          }
        }
      },
      {
        type: 'image', name: 'Image', description: 'Upload hoặc gán ảnh tham chiếu',
        icon: 'image', color: 'image', sort_order: 7, coming_soon: false,
        config: {
          defaults: { max_ref_images: 1 },
          ui: { show_ref_upload: true },
          ports: { in: [], out: [{ name: 'media', type: 'image', label: 'Ref image' }] }
        }
      },
      {
        type: 'delay', name: 'Wait', description: 'Chờ X giây trước khi tiếp tục',
        icon: 'delay', color: 'delay', sort_order: 8, coming_soon: false,
        config: {
          defaults: { delay_seconds: 3 },
          ui: {},
          ports: {
            in: [{ name: 'any_in', type: 'any', required: false, label: 'Input pass-through' }],
            out: [{ name: 'any_out', type: 'any', label: 'Output (after delay)' }]
          }
        }
      },
      {
        type: 'download', name: 'Download', description: 'Tải xuống kết quả tự động',
        icon: 'download', color: 'download', sort_order: 9, coming_soon: false,
        config: {
          defaults: { download_resolution: '1k', download_folder: '', download_file_template: '', download_collect_all: false },
          ui: {},
          ports: {
            in: [{ name: 'media_in', type: 'any', required: true, multiple: true, label: 'Files to download' }],
            out: []
          }
        }
      },
      {
        type: 'telegram', name: 'Telegram', description: 'Gửi kết quả qua Telegram',
        icon: 'telegram', color: 'telegram', sort_order: 10, coming_soon: false,
        config: {
          defaults: { telegram_send_mode: 'group', telegram_message: '' },
          ui: { terminal_sink: true },
          ports: {
            in: [{ name: 'media_in', type: 'any', required: true, multiple: true, label: 'Files to Telegram' }],
            out: [{ name: 'pass', type: 'any', label: 'Pass-through' }]
          }
        }
      },
      {
        type: 'note', name: 'Ghi chú', description: 'Ghi chú trên canvas (không có kết nối)',
        icon: 'note', color: 'note', sort_order: 11, coming_soon: false,
        config: {
          defaults: { note_text: '' },
          ui: {},
          ports: { in: [], out: [] }
        }
      },
      { type: 'transform', name: 'Transform', description: 'Biến đổi ảnh/video (upscale, effects)', icon: 'transform', color: 'transform', sort_order: 90, coming_soon: true, config: { ui: {} } },
      { type: 'condition', name: 'Condition', description: 'Điều kiện rẽ nhánh', icon: 'condition', color: 'condition', sort_order: 91, coming_soon: true, config: { ui: {} } },
      { type: 'merge', name: 'Merge', description: 'Gộp nhiều inputs', icon: 'merge', color: 'merge', sort_order: 92, coming_soon: true, config: { ui: {} } },
      { type: 'output', name: 'Output', description: 'Kết quả cuối cùng', icon: 'output', color: 'output', sort_order: 93, coming_soon: true, config: { ui: {} } }
    ],
    meta: { version: 1 }
  });
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
app.post('/api/v1/usage/events', (req, res) => res.json({ success: true }));
app.post('/api/v1/usage/track', (req, res) => res.json({ success: true }));
app.post('/api/v1/usage/sync-daily', (req, res) => res.json({ success: true }));
app.post('/api/v1/usage/sync-offline', (req, res) => res.json({ success: true }));
app.post('/api/v1/analytics/event', (req, res) => res.json({ success: true }));

// ─── API: Google Auth (link/unlink) ────────────────────────────────────────────
app.post('/api/v1/auth/google/link', (req, res) => {
  res.json({ success: true, data: { linked: true, email: 'user@gmail.com' } });
});
app.post('/api/v1/auth/google/unlink', (req, res) => {
  res.json({ success: true, data: { linked: false } });
});

// ─── API: Preferred Currency ───────────────────────────────────────────────────
app.patch('/api/v1/auth/me/preferred-currency', (req, res) => {
  res.json({ success: true, data: { preferred_currency: req.body?.currency || 'VND' } });
});

// ─── API: Angle Presets ────────────────────────────────────────────────────────
app.get('/api/v1/angle-presets', (req, res) => {
  res.json({
    success: true,
    data: [
      { id: 1, name: 'Góc trước', value: 'front-view', icon: '🔲', sort_order: 1 },
      { id: 2, name: 'Góc trên', value: 'top-view', icon: '🔝', sort_order: 2 },
      { id: 3, name: 'Góc bên', value: 'side-view', icon: '➡️', sort_order: 3 },
      { id: 4, name: 'Góc 45°', value: '45-degree', icon: '📐', sort_order: 4 },
      { id: 5, name: 'Close-up', value: 'close-up', icon: '🔍', sort_order: 5 },
      { id: 6, name: 'Wide shot', value: 'wide-shot', icon: '🌄', sort_order: 6 }
    ]
  });
});

// ─── API: Referral ─────────────────────────────────────────────────────────────
app.get('/api/v1/referral/code', (req, res) => {
  res.json({ success: true, data: { code: 'TOBY-REF-12345', url: 'https://tobyflow.com/ref/TOBY-REF-12345' } });
});
app.get('/api/v1/referral/stats', (req, res) => {
  res.json({ success: true, data: { total_referrals: 0, successful_referrals: 0, pending_rewards: 0, earned_rewards: 0 } });
});

// ─── API: Telegram (full) ──────────────────────────────────────────────────────
app.get('/api/v1/telegram/link/status', (req, res) => {
  res.json({ success: true, data: { linked: false, chat_id: null, username: null } });
});
app.post('/api/v1/telegram/notify-completion', (req, res) => {
  res.json({ success: true });
});
app.post('/api/v1/telegram/result', (req, res) => {
  res.json({ success: true });
});
app.post('/api/v1/telegram/send-workflow-images', (req, res) => {
  res.json({ success: true });
});

// ─── API: Webhook Settings ─────────────────────────────────────────────────────
app.get('/api/v1/webhook-settings', (req, res) => {
  res.json({ success: true, data: { enabled: false, url: null, events: [] } });
});

// ─── API: Execution Start ──────────────────────────────────────────────────────
app.post('/api/v1/executions/start', (req, res) => {
  res.json({
    success: true,
    data: {
      execution_id: 'exec_' + Date.now(),
      token: 'exec_token_' + Math.random().toString(36).substring(7),
      status: 'started',
      started_at: new Date().toISOString()
    }
  });
});

// ─── API: History (POST - save execution result) ───────────────────────────────
app.post('/api/v1/history', (req, res) => {
  const { provider, prompt, status, images, execution_id } = req.body || {};
  res.json({
    success: true,
    data: {
      id: Date.now(),
      provider: provider || 'flow',
      prompt: prompt || '',
      status: status || 'completed',
      images: images || [],
      execution_id: execution_id || null,
      created_at: new Date().toISOString()
    }
  });
});

// ─── API: Results Sync ─────────────────────────────────────────────────────────
app.post('/api/v1/results/sync', (req, res) => {
  res.json({ success: true, data: { synced: true, count: req.body?.results?.length || 0 } });
});

// ─── API: Orders ───────────────────────────────────────────────────────────────
app.post('/api/v1/orders', (req, res) => {
  res.json({
    success: true,
    data: {
      order_id: 'order_' + Date.now(),
      status: 'pending',
      plan: req.body?.plan || 'pro',
      amount: req.body?.amount || 0,
      currency: req.body?.currency || 'VND',
      payment_url: null,
      created_at: new Date().toISOString()
    }
  });
});
app.post('/api/v1/orders/upgrade-quote', (req, res) => {
  res.json({
    success: true,
    data: {
      plan: req.body?.plan || 'pro',
      price: 99000,
      currency: 'VND',
      discount: 0,
      total: 99000,
      period: 'monthly'
    }
  });
});

// ─── API: Image Effects ────────────────────────────────────────────────────────
app.get('/api/v1/image-effects', (req, res) => {
  res.json({
    success: true,
    data: [
      { id: 1, name: 'Cinematic Film', slug: 'cinematic-film', category: 'Color Grading', base_prompt: 'Apply cinematic film color grading with orange and teal tones, {intensity} contrast, subtle film grain', intensity_keywords: { '25': 'very subtle', '50': 'moderate', '75': 'strong', '100': 'intense dramatic' }, default_intensity: 75 },
      { id: 2, name: 'Vintage 70s', slug: 'vintage-70s', category: 'Color Grading', base_prompt: 'Transform with 1970s vintage film look, {intensity} faded colors, warm yellow cast, light leaks', intensity_keywords: { '25': 'subtle', '50': 'noticeable', '75': 'prominent', '100': 'heavy' }, default_intensity: 65 },
      { id: 10, name: 'Golden Hour', slug: 'golden-hour', category: 'Light', base_prompt: 'Apply golden hour lighting with warm orange-gold sunlight, {intensity} soft glow, lens flare', intensity_keywords: { '25': 'subtle hint of', '50': 'moderate', '75': 'prominent', '100': 'intense' }, default_intensity: 70 },
      { id: 11, name: 'Neon Glow', slug: 'neon-glow', category: 'Light', base_prompt: 'Add neon light glow effect with {intensity} pink and cyan rim lighting, cyberpunk atmosphere', intensity_keywords: { '25': 'subtle', '50': 'moderate', '75': 'vibrant', '100': 'intense' }, default_intensity: 75 },
      { id: 20, name: 'Rain', slug: 'rain', category: 'Weather', base_prompt: 'Add {intensity} rain effect with visible raindrops, wet reflective surfaces, moody atmosphere', intensity_keywords: { '25': 'light drizzle', '50': 'steady', '75': 'heavy', '100': 'torrential' }, default_intensity: 60 },
      { id: 30, name: 'Watercolor', slug: 'watercolor', category: 'Artistic', base_prompt: 'Transform to watercolor painting style with {intensity} soft brush strokes, fluid colors', intensity_keywords: { '25': 'subtle', '50': 'moderate', '75': 'strong', '100': 'heavy' }, default_intensity: 75 }
    ]
  });
});

// ─── API: Notifications Extended ───────────────────────────────────────────────
app.post('/api/v1/notifications/mark-all-read', (req, res) => {
  _notifications.forEach(n => { n.read = true; });
  res.json({ success: true });
});
app.get('/api/v1/notifications/unread-count', (req, res) => {
  const count = _notifications.filter(n => !n.read).length;
  res.json({ success: true, data: { count } });
});
app.put('/api/v1/notifications/:id/read', (req, res) => {
  const n = _notifications.find(n => n.id === parseInt(req.params.id));
  if (n) n.read = true;
  res.json({ success: true });
});

// ─── API: Payment Settings ─────────────────────────────────────────────────────
app.get('/api/v1/payment-settings/providers', (req, res) => {
  res.json({
    success: true,
    data: [
      { id: 'vietqr', name: 'VietQR', enabled: true, type: 'bank_transfer' },
      { id: 'stripe', name: 'Stripe', enabled: true, type: 'card' },
      { id: 'paypal', name: 'PayPal', enabled: false, type: 'wallet' }
    ]
  });
});

// ─── API: Projects ─────────────────────────────────────────────────────────────
app.get('/api/v1/projects/names', (req, res) => {
  res.json({ success: true, data: [] });
});
app.post('/api/v1/projects/sync', (req, res) => {
  res.json({ success: true, data: { synced: true } });
});

// ─── API: Workflow Shares ──────────────────────────────────────────────────────
app.get('/api/v1/workflows/:wfId/shares', (req, res) => {
  res.json({ success: true, data: [] });
});
app.post('/api/v1/workflows/:wfId/shares', (req, res) => {
  res.json({ success: true, data: { share_id: 'share_' + Date.now(), wf_id: req.params.wfId, shared_to: req.body.email, permission: req.body.permission || 'view', created_at: new Date().toISOString() } });
});
app.post('/api/v1/workflow-shares/:shareId/reject', (req, res) => {
  res.json({ success: true });
});
app.post('/api/v1/workflow-shares/:token/accept', (req, res) => {
  res.json({ success: true, data: { workflow: { wf_id: 'wf_shared_001', name: 'Shared Workflow' } } });
});

// ─── Fallback catch-all ────────────────────────────────────────────────────────
app.use((req, res) => {
  console.log(`[Local Server] Fallback handler hit: ${req.method} ${req.url}`);
  res.json({ success: true, data: {} });
});

// Express 5 returns a Promise from app.listen — must await it to keep the process alive
(async () => {
  await app.listen(PORT);
  console.log(`[Local Server] Running on http://localhost:${PORT}`);
  console.log('[Local Server] All endpoints ready with proper data structures');
})();
