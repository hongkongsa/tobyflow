/**
 * TobyFlow Mock Backend Server
 * Simulates labs.toby.vn/api/v1 for local development & testing
 */

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// ─── State ───────────────────────────────────────────────────────────
const enrolledDevices = new Map();
const executionTokens = new Map();
let configVersions = {
  system_settings: 1,
  providers: 1,
  provider_models: 1,
  node_types: 1,
  validation_rules: 1,
  default_settings: 1,
  i18n: 1,
  user_entitlements: 1,
};

// ─── Middleware: Log requests ────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── Auth Endpoints ──────────────────────────────────────────────────
app.post('/api/v1/auth/login', (req, res) => {
  const { email, password } = req.body;
  res.json({
    token: 'mock_jwt_token_' + Date.now(),
    user: {
      id: 'user_001',
      email: email || 'test@tobyflow.dev',
      name: 'Test User',
      plan: 'pro',
      avatar: null,
    },
  });
});

app.post('/api/v1/auth/register', (req, res) => {
  res.json({
    token: 'mock_jwt_token_' + Date.now(),
    user: {
      id: 'user_' + crypto.randomUUID().slice(0, 8),
      email: req.body.email,
      name: req.body.name || 'New User',
      plan: 'free',
    },
  });
});

app.get('/api/v1/auth/me', (req, res) => {
  res.json({
    id: 'user_001',
    email: 'test@tobyflow.dev',
    name: 'Test User',
    plan: 'pro',
    avatar: null,
  });
});

app.post('/api/v1/auth/logout', (req, res) => {
  res.json({ success: true });
});

app.post('/api/v1/auth/refresh', (req, res) => {
  res.json({ token: 'mock_jwt_refreshed_' + Date.now() });
});

// ─── Enrollment ──────────────────────────────────────────────────────
app.post('/api/v1/enroll', (req, res) => {
  const { device_fp, extension_id } = req.body;
  const clientId = 'client_' + crypto.randomUUID().slice(0, 12);
  const secret = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  enrolledDevices.set(clientId, { device_fp, extension_id, secret, created: Date.now() });

  res.json({
    client_id: clientId,
    secret,
    expires_at: expiresAt,
  });
});

// ─── Entitlements ────────────────────────────────────────────────────
app.get('/api/v1/entitlements', (req, res) => {
  res.json({
    plan: 'pro',
    features: {
      gen_enabled: true,
      chatgpt_enabled: true,
      grok_enabled: true,
      tasks_enabled: true,
      workflows_enabled: true,
      workflow_share_enabled: true,
      workflow_import: true,
      workflow_export: true,
      angles_enabled: true,
      effects_enabled: true,
      auto_download: true,
      retry_on_fail: true,
      ref_images: true,
      prompt_templates_enabled: true,
      workflow_templates_enabled: true,
      history_enabled: true,
    },
    limits: {
      gen_run_max: -1,
      chatgpt_run_max: 50,
      grok_run_max: 50,
      tasks_max: 20,
      tasks_run_max: 50,
      workflows_max: 10,
      workflows_run_max: 20,
      workflows_nodes_max: 50,
      angles_run_max: 20,
      effects_run_max: 20,
      snippets_max: -1,
    },
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
});

// ─── Config ──────────────────────────────────────────────────────────
app.get('/api/v1/config/versions', (req, res) => {
  res.json(configVersions);
});

app.get('/api/v1/settings/defaults', (req, res) => {
  res.json({
    locale: 'vi',
    theme: 'dark',
    notifications_enabled: true,
    sound_enabled: true,
    auto_download: false,
    download_quality: '2k',
    input_timeout: 1200,
    retry_on_fail: true,
    humanized_typing: true,
    default_provider: 'flow',
    default_ratio: '1:1',
    default_model: 'imagen-3',
    default_quantity: 4,
  });
});

// ─── Provider Config ─────────────────────────────────────────────────
app.get('/api/v1/providers/dom-selectors', (req, res) => {
  res.json({
    flow: {
      slate_editor: {
        selectors: ['[data-testid="slate-editor"]', '[contenteditable="true"]', '.slate-editor'],
      },
      submit_button: {
        selectors: ['button[aria-label="Generate"]', 'button[data-testid="submit"]', 'button.generate-btn'],
      },
      tile_container: {
        selectors: ['[data-testid="tile"]', '.tile-container', '[class*="tile"]'],
      },
      retry_button: {
        selectors: ['button[aria-label="Retry"]', '[data-testid="retry-btn"]'],
      },
      ratio_trigger: {
        selectors: ['button[id$="-trigger-ratio"]', '[data-testid="ratio-select"]'],
      },
    },
    chatgpt: {
      editor: {
        selectors: ['#prompt-textarea', '[contenteditable="true"]', 'textarea'],
      },
      submit_button: {
        selectors: ['button[data-testid="send-button"]', 'button[aria-label="Send"]'],
      },
      image_toggle: {
        selectors: ['button[aria-label="Create image"]', '[data-testid="image-mode-toggle"]'],
      },
    },
    grok: {
      editor: {
        selectors: ['.tiptap', '[contenteditable="true"]', '.ProseMirror'],
      },
      submit_button: {
        selectors: ['button[aria-label="Submit"]', 'button.submit-btn'],
      },
      mode_selector: {
        selectors: ['[data-testid="mode-select"]', 'select.mode-select'],
      },
    },
    gemini: {
      editor: {
        selectors: ['[contenteditable="true"]', 'rich-textarea'],
      },
      submit_button: {
        selectors: ['button[aria-label="Send message"]', '.send-button'],
      },
    },
  });
});

app.get('/api/v1/providers/api-configs', (req, res) => {
  res.json({
    flow: {
      base_url: 'https://labs.google',
      tab_query: '*://labs.google/fx/*',
      create_url: 'https://labs.google/fx/tools/image-fx',
      display_name: 'Google Flow',
    },
    chatgpt: {
      base_url: 'https://chatgpt.com',
      tab_query: '*://chatgpt.com/*',
      create_url: 'https://chatgpt.com/',
      display_name: 'ChatGPT',
    },
    grok: {
      base_url: 'https://grok.com',
      tab_query: '*://grok.com/*',
      create_url: 'https://grok.com/imagine',
      display_name: 'Grok',
    },
    gemini: {
      base_url: 'https://gemini.google.com',
      tab_query: '*://gemini.google.com/*',
      create_url: 'https://gemini.google.com/app',
      display_name: 'Gemini',
    },
  });
});

app.get('/api/v1/provider-models', (req, res) => {
  res.json({
    flow: [
      { id: 'imagen-3', name: 'Imagen 3', default: true },
      { id: 'imagen-3-fast', name: 'Imagen 3 Fast' },
      { id: 'veo-2', name: 'Veo 2 (Video)', type: 'video' },
    ],
    chatgpt: [
      { id: 'dall-e-3', name: 'DALL-E 3', default: true },
      { id: 'gpt-4o', name: 'GPT-4o Image' },
    ],
    grok: [
      { id: 'aurora', name: 'Aurora', default: true },
      { id: 'grok-2-aurora', name: 'Grok 2 Aurora' },
    ],
    gemini: [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', default: true },
    ],
  });
});

// ─── Execution ───────────────────────────────────────────────────────
app.post('/api/v1/execution/request', (req, res) => {
  const { action, prompt_count } = req.body;
  const token = 'exec_' + crypto.randomUUID().slice(0, 16);
  executionTokens.set(token, { action, prompt_count, created: Date.now() });

  res.json({
    allowed: true,
    token,
    remaining: 99,
    limit: 100,
    used: 1,
    global_remaining: 999,
    global_limit: 1000,
    global_used: 1,
  });
});

app.post('/api/v1/executions/:id/complete', (req, res) => {
  executionTokens.delete(req.params.id);
  res.json({ success: true });
});

// ─── Storage (Tasks/Workflows) ───────────────────────────────────────
const workflows = [];
const tasks = [];

app.get('/api/v1/workflows', (req, res) => res.json(workflows));
app.post('/api/v1/workflows', (req, res) => {
  const wf = { id: crypto.randomUUID(), ...req.body, created_at: new Date().toISOString() };
  workflows.push(wf);
  res.json(wf);
});

app.get('/api/v1/tasks', (req, res) => res.json(tasks));
app.post('/api/v1/tasks', (req, res) => {
  const task = { id: crypto.randomUUID(), ...req.body, created_at: new Date().toISOString() };
  tasks.push(task);
  res.json(task);
});

app.post('/api/v1/results/sync', (req, res) => {
  res.json({ success: true });
});

// ─── SSE ─────────────────────────────────────────────────────────────
app.get('/api/v1/sse/ticket', (req, res) => {
  res.json({ ticket: 'mock_sse_ticket_' + Date.now() });
});

app.get('/api/v1/sse/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send heartbeat every 30s
  const interval = setInterval(() => {
    res.write(`event: heartbeat\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);
  }, 30000);

  // Send initial connected event
  res.write(`event: connected\ndata: ${JSON.stringify({ mode: 'sse' })}\n\n`);

  req.on('close', () => {
    clearInterval(interval);
  });
});

app.get('/api/v1/sse/poll', (req, res) => {
  res.json({ events: [] });
});

// ─── Telegram ────────────────────────────────────────────────────────
app.get('/api/v1/telegram/config', (req, res) => {
  res.json({
    enabled: false,
    bot_name: 'TobyFlowBot',
    commands: ['/image', '/video', '/workflow', '/stop', '/describe'],
  });
});

app.post('/api/v1/telegram/result', (req, res) => {
  res.json({ success: true });
});

// ─── Validation Rules ────────────────────────────────────────────────
app.get('/api/v1/config/validation-rules', (req, res) => {
  res.json({
    prompt_min_length: 1,
    prompt_max_length: 4000,
    prompt_max_length_chatgpt: 2000,
    prompt_max_length_grok: 3000,
    file_max_size_bytes: 10485760,
    file_allowed_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    max_ref_images: 5,
    max_batch_items: 100,
    max_workflow_nodes: 20,
  });
});

// ─── Health ──────────────────────────────────────────────────────────
app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0-mock',
    uptime: process.uptime(),
    enrolled_devices: enrolledDevices.size,
    active_executions: executionTokens.size,
  });
});

// ─── Start Server ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 TobyFlow Mock Backend running at http://localhost:${PORT}`);
  console.log(`   API Base: http://localhost:${PORT}/api/v1`);
  console.log(`   Health:   http://localhost:${PORT}/api/v1/health`);
  console.log(`\n   Endpoints:`);
  console.log(`   - POST /api/v1/auth/login`);
  console.log(`   - POST /api/v1/enroll`);
  console.log(`   - GET  /api/v1/entitlements`);
  console.log(`   - GET  /api/v1/providers/dom-selectors`);
  console.log(`   - GET  /api/v1/provider-models`);
  console.log(`   - POST /api/v1/execution/request`);
  console.log(`   - GET  /api/v1/sse/stream (SSE)`);
  console.log(`   - GET  /api/v1/health\n`);
});
