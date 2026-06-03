/**
 * NodeTemplates - HTML templates cho các loại node trong Drawflow
 */
const NodeTemplates = {
  // Phase WK-1.2: Typed port system — 5 port types
  // Mỗi port có color (visual), label (UI), icon (chữ ngắn hiển thị trong port circle)
  PORT_TYPES: {
    // Palette 2026-05-25: contrast cao với white inner dashes (rope-style connection).
    // text → soft violet (prompt/lavender feel); video giữ purple-500 đậm hơn để distinct.
    text:   { color: '#9177e1', label: 'Text',   icon: 'T' }, // custom violet (prompt color)
    image:  { color: '#3b82f6', label: 'Image',  icon: 'I' }, // blue-500
    video:  { color: '#a855f7', label: 'Video',  icon: 'V' }, // purple-500
    any:    { color: '#71717a', label: 'Any',    icon: '*' }, // zinc-500 (darker for white contrast)
    frame:  { color: '#14b8a6', label: 'Frame',  icon: 'F' }, // teal-500
  },

  // Phase WK-1.2: Port compatibility matrix — source type → array of acceptable target types
  // Auto-coerce: image ↔ frame, any tương thích với mọi loại
  PORT_COMPAT: {
    text:  ['text', 'any'],
    image: ['image', 'frame', 'any'],
    video: ['video', 'any'],
    frame: ['frame', 'image', 'any'],
    any:   ['text', 'image', 'video', 'frame', 'any'],
  },

  // Icon SVGs
  icons: {
    generate: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="13.5" cy="6.5" r="0.5" fill="currentColor"/><circle cx="17.5" cy="10.5" r="0.5" fill="currentColor"/><circle cx="8.5" cy="7.5" r="0.5" fill="currentColor"/><circle cx="6.5" cy="12.5" r="0.5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.555C21.965 6.012 17.461 2 12 2z"/></svg>`,
    download: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    image: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    video_camera: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2" ry="2"/></svg>`,
    delay: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    note: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    telegram: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`,
    chatgpt: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="9" cy="11" r="1" fill="currentColor"/><circle cx="13" cy="11" r="1" fill="currentColor"/><circle cx="17" cy="11" r="1" fill="currentColor"/></svg>`,
    grok: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`,
    prompt: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.39 5.26L20 10l-4.5 4.13L17 20l-5-3-5 3 1.5-5.87L4 10l5.61-1.74L12 3z"/></svg>`,
    // Phase 1 — Node Reference System: Text node icon
    text: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
    // Text Extract Node (2026-05-29): scissors-like icon cho "trích xuất"
    text_extract: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="8" width="10" height="8" rx="1"/></svg>`,
    transform: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
    condition: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>`,
    merge: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></svg>`,
    output: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
    // Provider brand logos — kích thước 16px cho floating pill ở trên node
    brandFlow: `<svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z" fill="#3186FF"/></svg>`,
    brandOpenAI: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>`,
    brandGrok: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/></svg>`,
    // Media type indicators (image / video) — hiển thị nhỏ next to title
    mediaImage: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    mediaVideo: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2" ry="2"/></svg>`
  },

  // Provider mapping cho từng node type → để render badge logo brand
  // Image source / utility nodes (delay/download/note/upscale/telegram) không thuộc provider nào → null
  getNodeProvider(type) {
    if (type === 'generate') return 'flow';
    if (type === 'chatgpt') return 'openai';
    if (type === 'grok') return 'grok';
    return null;
  },

  // Render provider badge HTML — floating pill ở phía TRÊN node (nằm ngoài card)
  // Mục đích marketing: user thấy nhiều AI provider (Flow / ChatGPT / Grok) chạy chung
  // trong 1 workflow → wow factor. Pill có logo brand + tên rõ ràng, gradient theo brand color.
  renderProviderBadge(type) {
    const provider = this.getNodeProvider(type);
    if (!provider) return '';
    const logoMap = {
      flow: this.icons.brandFlow,
      openai: this.icons.brandOpenAI,
      grok: this.icons.brandGrok,
    };
    const labelMap = { flow: 'Google Flow', openai: 'ChatGPT', grok: 'Grok' };
    const logo = logoMap[provider];
    if (!logo) return '';
    return `<div class="df-node-provider-pill df-node-provider-${provider}" title="${labelMap[provider]}" data-tooltip="${labelMap[provider]}">
      <span class="df-node-provider-pill-logo">${logo}</span>
      <span class="df-node-provider-pill-label">${labelMap[provider]}</span>
    </div>`;
  },

  // UI 2026-05-27: bỏ media badge cạnh title — node chỉ hiển thị 1 icon (df-node-icon) bên trái
  // node_name ở header. Giữ method trả '' để không phải sửa 4 call site (generate/chatgpt/grok/image).
  renderMediaTypeBadge() {
    return '';
  },

  // Node type configs - dùng getter để evaluate I18n.t() tại runtime (fix i18n loading race condition)
  get types() {
    // Helper để lấy translation với fallback
    const t = (key, fallback) => {
      const val = window.I18n?.t(key);
      // I18n.t() trả về key nếu không tìm thấy translation → fallback
      return (val && val !== key) ? val : fallback;
    };
    return {
      generate: {
        name: t('node.generateName', 'Tạo ảnh/video'), description: t('node.generateDesc', 'Tạo ảnh/video mới'),
        color: 'generate', inputs: 1, outputs: 1, portType: 'image',
        // Phase WK-1.2: Typed multi-port (additive — KHÔNG xoá fields cũ để giữ backward-compat)
        ports: {
          in: [
            { name: 'image_ref', type: 'image', required: false, multiple: true,  label: t('node.portRefImages', 'Reference images') },
            { name: 'text',      type: 'text',  required: false, multiple: false, label: t('node.portPromptText', 'Prompt text') },
            { name: 'frame_1',   type: 'frame', required: false, multiple: false, label: t('node.portFrame1', 'Frame 1 (video)'), visibleWhen: 'isVideoFrames' },
            { name: 'frame_2',   type: 'frame', required: false, multiple: false, label: t('node.portFrame2', 'Frame 2 (video)'), visibleWhen: 'isVideoFrames' },
          ],
          out: [
            { name: 'media', type: 'image', label: t('node.portResult', 'Result'), dynamicType: 'media_type' },
          ],
        },
      },
      download: {
        name: t('node.downloadName', 'Download'), description: t('node.downloadDesc', 'Auto-download results'),
        color: 'download', inputs: 1, outputs: 0, portType: 'any',
        ports: {
          in: [{ name: 'media_in', type: 'any', required: true, multiple: true, label: t('node.portFilesToDownload', 'Files to download') }],
          out: [],
        },
      },
      delay: {
        name: t('node.delayName', 'Wait'), description: t('node.delayDesc', 'Wait X seconds'),
        color: 'delay', inputs: 1, outputs: 1, portType: 'any',
        ports: {
          in: [{ name: 'any_in', type: 'any', required: false, label: t('node.portInputPassthrough', 'Input pass-through') }],
          out: [{ name: 'any_out', type: 'any', label: t('node.portOutputAfterDelay', 'Output (after delay)') }],
        },
      },
      image: {
        name: t('node.imageName', 'Image'), description: t('node.imageDesc', 'Upload or assign reference image'),
        color: 'image', inputs: 0, outputs: 1, portType: 'image',
        ports: {
          in: [],
          out: [{ name: 'media', type: 'image', label: t('node.portRefImage', 'Ref image') }],
        },
      },
      // Phase 1 — Node Reference System: Text node for prompt composition via @slug
      text: {
        name: t('node.textName', 'Text'), description: t('node.textDesc', 'Static text/prompt source for @mentions'),
        color: 'text', inputs: 0, outputs: 1, portType: 'text',
        ports: {
          in: [],
          out: [{ name: 'text', type: 'text', label: t('node.portTextOutput', 'Text output') }],
        },
      },
      telegram: {
        name: 'Telegram', description: t('node.telegramDesc', 'Send images via Telegram'),
        icon: 'telegram', color: 'telegram', inputs: 1, outputs: 1, portType: 'any',
        // Terminal sink: chỉ nhận input (gửi đi), không gợi ý làm upstream cho node khác.
        // Picker filter: ẩn khỏi danh sách khi user click empty INPUT port của node khác.
        // Bug 27 fix (2026-05-19): nest trong `ui` để khớp backend config.ui.terminal_sink
        // (admin tweak qua /admin/workflow-node-types). Trước đây ext đọc root-level
        // `terminalSink`, admin tweak backend không có hiệu lực.
        ui: { terminal_sink: true },
        ports: {
          in: [{ name: 'media_in', type: 'any', required: true, multiple: true, label: t('node.portFilesToTelegram', 'Files to Telegram') }],
          out: [{ name: 'pass', type: 'any', label: t('node.portPassthrough', 'Pass-through') }],
        },
      },
      // ChatGPT node — provider ChatGPT, hỗ trợ image (chuẩn bị mở rộng video).
      chatgpt: {
        name: t('node.chatgptName', 'ChatGPT'), description: t('node.chatgptDesc', 'Generate images via ChatGPT'),
        icon: 'chatgpt', color: 'chatgpt', inputs: 1, outputs: 1, portType: 'image',
        ports: {
          in: [
            { name: 'image_ref', type: 'image', required: false, multiple: true,  label: t('node.portRefImages', 'Reference images') },
            { name: 'text',      type: 'text',  required: false, multiple: false, label: t('node.portPromptText', 'Prompt text') },
          ],
          out: [{ name: 'media', type: 'image', label: t('node.portChatgptImages', 'ChatGPT images') }],
        },
      },
      // Phase G-6: Grok node — tạo ảnh/video qua Grok provider.
      // Cleanup (2026-05-19): Removed inline `config` (max_ref_images, supported_modes,
      // supported_ratios, supported_durations, supported_resolutions) — duplicate với
      // GrokAdapter.capabilities. Source of truth: provider adapter capabilities (Phase J
      // pending migrate sang provider_configs.api_config).
      grok: {
        name: t('node.grokName', 'Grok'),
        description: t('node.grokDesc', 'Generate image/video via Grok'),
        icon: 'grok', color: 'grok', inputs: 1, outputs: 1, portType: 'image',
        ports: {
          in: [
            { name: 'image_ref', type: 'image', required: false, multiple: true,  label: t('node.portRefImages', 'Reference images') },
            { name: 'text',      type: 'text',  required: false, multiple: false, label: t('node.portPromptText', 'Prompt text') },
          ],
          out: [
            // dynamicType='grok_mode' → resolve theo data.grok_mode (image/video) cho đúng port type.
            { name: 'media', type: 'image', label: t('node.portResult', 'Result'), dynamicType: 'grok_mode' },
          ],
        },
      },
      prompt: {
        // AI Agent rename (2026-05-30): display name "AI Agent" — server WorkflowNodeTypeSeeder
        // cũng set name="AI Agent". Local fallback dùng khi server config chưa fetch.
        name: t('node.promptName', 'AI Agent'), description: t('node.promptDesc', 'Pass-through text hoặc dùng AI (ChatGPT/Gemini) để xử lý text — enhance prompt, viết kịch bản, phân tích ảnh, summarize, translate, brainstorm.'),
        icon: 'prompt', color: 'prompt', inputs: 1, outputs: 1, portType: 'text',
        ports: {
          in: [
            { name: 'text',      type: 'text',  required: false, multiple: false, label: t('node.portPromptUpstream', 'Prompt upstream') },
            { name: 'image_ref', type: 'image', required: false, multiple: true,  label: t('node.portRefImages', 'Reference images'), visibleWhen: 'enhance' },
          ],
          out: [{ name: 'text', type: 'text', label: t('node.portResultText', 'Result text') }],
        },
      },
      note: {
        name: t('node.noteName', 'Ghi chú'), description: t('node.noteDesc', 'Ghi chú trên canvas'),
        color: 'note', inputs: 0, outputs: 0, portType: 'none',
        ports: { in: [], out: [] },
      },
      // Legacy (backward compat) — KHÔNG khai báo ports → getNodePorts trả {in:[], out:[]} → render Drawflow native ports
      transform: { name: 'Transform', description: t('node.transformDesc', 'Biến đổi ảnh/video'), color: 'transform', inputs: 1, outputs: 1, portType: 'image' },
      condition: { name: 'Condition', description: t('node.conditionDesc', 'Điều kiện rẽ nhánh'), color: 'condition', inputs: 1, outputs: 2, portType: 'any' },
      merge: { name: 'Merge', description: t('node.mergeDesc', 'Gộp nhiều inputs'), color: 'merge', inputs: 2, outputs: 1, portType: 'any' },
      output: { name: 'Output', description: t('node.outputDesc', 'Kết quả cuối'), color: 'output', inputs: 1, outputs: 0, portType: 'any' }
    };
  },

  // Port type colors for visual distinction
  // Phase CG-8: text port → amber #F59E0B (matches prompt node sparkle color)
  portColors: {
    image: '#3b82f6',
    video: '#8b5cf6',
    text: '#F59E0B',
    any: '#d4d4d8',
    none: 'transparent'
  },

  // Hook chuẩn hoá node type. Hiện tại pass-through (không có alias).
  // Thêm mapping ở đây nếu rename node type trong tương lai (vd: chatgpt → chatgpt_v2).
  _normalizeType(type) {
    return type;
  },

  // Generate node HTML for Drawflow
  createNodeHTML(type, data = {}) {
    type = this._normalizeType(type);
    // Dùng getType() để lấy config merged với server (icon, color, ports từ backend).
    // Name của node trên canvas là SNAPSHOT lúc tạo (lưu vào data.node_name) — admin đổi
    // template name KHÔNG override node đã vẽ. Picker (list thêm node) đọc config.name
    // trực tiếp nên picker tự update khi SSE push.
    const config = this.getType(type);
    // Icon lookup: server config.icon (string key) → this.icons[key], fallback type → fallback generate
    const iconKey = config.icon || type;
    const icon = this.icons[iconKey] || this.icons[type] || this.icons.generate;
    // Name resolution: snapshot — node_name lưu lúc tạo node, render từ data.
    // Fallback config.name chỉ cho edge case node thiếu node_name (legacy data).
    const name = data.node_name || config.name;
    const prompt = data.prompt || '';
    const status = data.status || 'pending';
    const mediaType = data.media_type || 'Image';
    const model = data.model || '';
    const ratio = data.ratio || '';
    const quantity = data.quantity || 1;
    const enabled = data.enabled !== false;
    const videoInputType = data.video_input_type || '';
    const isVideoFrames = mediaType === 'Video' && videoInputType === 'Frames';
    const isVideo = mediaType === 'Video';
    const videoDuration = data.video_duration || '6s';

    // Header icon dynamic theo media_type:
    // - generate Video → video-camera (camcorder)
    // - generate Image / chatgpt → photo (rect + mountain)
    // - Các type khác giữ icon mặc định
    let headerIcon = icon;
    if (type === 'generate') {
      headerIcon = mediaType === 'Video' ? this.icons.video_camera : this.icons.image;
    } else if (type === 'chatgpt') {
      headerIcon = this.icons.image;
    }

    // Phase WK-1.2 (REFACTORED — bug fix): Style Drawflow native ports trực tiếp qua data attributes
    // thay vì overlay rails. Native ports có drag/drop mechanism của Drawflow → user kéo edge được.
    // DiagramCanvas._injectPortAttributes() (post-render hook) set data-port-type/name/required.
    // KHÔNG render rails nữa — giữ biến rỗng để các render branches không break.
    const portRailIn = '';
    const portRailOut = '';
    const nodeHasPortsClass = '';
    // OLD visual overlay rails đã DELETE — Drawflow native ports được style trực tiếp qua post-render hook
    // trong DiagramCanvas._injectPortAttributes() (set data-port-type/name/required).

    // Generate node: chi tiết ratio classes (như ChatGPT)
    const genRatioClassMap = {
      '9:16': 'ratio-9-16', 'Dọc': 'ratio-9-16',
      '3:4': 'ratio-3-4',
      '1:1': '', 'Vuông': '',
      '4:3': 'ratio-4-3',
      '16:9': 'ratio-16-9', 'Ngang': 'ratio-16-9'
    };
    const ratioClass = genRatioClassMap[ratio] !== undefined ? genRatioClassMap[ratio] : '';

    // Hover toolbar HTML (shared across node types that support it)
    // Run button: chỉ hiển thị khi node có content VÀ đã được save (có node_id)
    // Bug fix: Grok/ChatGPT/Generate có thể nhận prompt qua port `text` từ upstream Prompt node
    // → cho phép hover-toolbar run-button hiện kể cả khi prompt rỗng (đã saved). Runtime
    // _checkDependencies sẽ verify có Prompt upstream, KHÔNG có thì throw error rõ ràng.
    const hasContent = type === 'delay' ? enabled
      : type === 'note' ? false
      : type === 'image' ? false
      : ['chatgpt', 'grok', 'generate', 'prompt'].includes(type) ? true
      : !!(prompt && prompt.trim());
    const isNodeSaved = !!(data.node_id);
    const canRunNode = hasContent && isNodeSaved;
    const hasResults = !!(data.result_file_ids && data.result_file_ids.trim());
    // hasResetable: dùng cho reset button — đồng bộ với WorkflowEditor._updateResetSingleNodeButton
    // + DiagramCanvas._showNodeContextMenu hasResults check. 3 chỗ giờ cùng logic:
    // result_file_ids HOẶC result_text HOẶC status !== 'pending' → cho phép reset.
    const hasResetable = hasResults
      || !!data.result_text
      || !!(data.status && data.status !== 'pending');
    const hasPrompt = !!(prompt && prompt.trim());
    const tCopyPrompt = window.I18n?.t('node.copyPrompt') || 'Copy prompt';
    const tRunNode = window.I18n?.t('node.runNode') || 'Chạy node';
    const tDownloadResults = window.I18n?.t('node.downloadResults') || 'Tải kết quả';
    const tSettings = window.I18n?.t('node.settings') || 'Cài đặt';
    const tBranch = window.I18n?.t('node.branch') || 'Tạo nhánh';
    const tDuplicate = window.I18n?.t('node.duplicate') || 'Nhân bản';
    const tDeleteNode = window.I18n?.t('node.deleteNode') || 'Xóa node';
    const tResetNode = window.I18n?.t('node.resetNode') || 'Reset node';
    const hoverToolbar = `
      <div class="df-hover-toolbar">
        ${canRunNode ? `<button class="df-hover-btn" data-action="run-node" title="${tRunNode}" data-tooltip="${tRunNode}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>` : ''}
        ${hasResetable ? `<button class="df-hover-btn" data-action="reset-node" title="${tResetNode}" data-tooltip="${tResetNode}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        </button>` : ''}
        ${hasResults ? `<button class="df-hover-btn" data-action="download-node" title="${tDownloadResults}" data-tooltip="${tDownloadResults}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>` : ''}
        <button class="df-hover-btn df-hover-btn-settings" data-action="settings-node" title="${tSettings}" data-tooltip="${tSettings}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
        <button class="df-hover-btn" data-action="branch-node" title="${tBranch}" data-tooltip="${tBranch}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 6a9 9 0 0 0 9 9"/></svg>
        </button>
        ${hasPrompt ? `<button class="df-hover-btn" data-action="copy-prompt" title="${tCopyPrompt}" data-tooltip="${tCopyPrompt}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/><path d="M9 13h8M9 17h6"/></svg>
        </button>` : ''}
        <button class="df-hover-btn" data-action="copy-node" title="${tDuplicate}" data-tooltip="${tDuplicate}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="df-hover-btn danger" data-action="delete-node" title="${tDeleteNode}" data-tooltip="${tDeleteNode}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>`;

    // Note node - special card
    if (type === 'note') {
      return `
        <div class="df-node df-node-note${nodeHasPortsClass}" data-node-type="note">
          ${portRailIn}${portRailOut}
          <div class="df-node-header">
            <div class="df-node-icon note">${this.icons.note}</div>
            <div class="df-node-title" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}</div>
          </div>
          <div class="df-node-body">
            <div class="df-node-note-text">${this.escapeHtml(data.note_text || (window.I18n?.t('node.notePlaceholder') || 'Ghi chú...'))}</div>
          </div>
          ${hoverToolbar}
        </div>`;
    }

    // Delay node - special card
    if (type === 'delay') {
      return `
        <div class="df-node ${!enabled ? 'df-node-disabled' : ''}${nodeHasPortsClass}" data-node-type="delay" data-enabled="${enabled}">
          ${portRailIn}${portRailOut}
          <div class="df-node-status ${status}"></div>
          <div class="df-node-header">
            <div class="df-node-icon delay">${this.icons.delay}</div>
            <div class="df-node-title" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}</div>
          </div>
          <div class="df-node-body">
            <div class="df-node-delay-setting">
              <span>${window.I18n?.t('node.wait') || 'Chờ'}</span>
              <input type="number" class="df-node-inline-input df-delay-seconds" value="${data.delay_seconds || 3}" min="1" max="300" style="width:50px">
              <span>${window.I18n?.t('node.seconds') || 'giây'}</span>
            </div>
          </div>
          ${hoverToolbar}
        </div>`;
    }

    // Image node - reference image upload/pick
    if (type === 'image') {
      const refFileIds = data.ref_file_ids || '';
      const refImgUrls = data.ref_img_urls || [];
      // Count from ref_file_ids (normal mode) or ref_img_urls (template mode)
      const refCount = refImgUrls.length > 0
        ? refImgUrls.length
        : (refFileIds ? refFileIds.split(',').filter(Boolean).length : 0);
      return `
        <div class="df-node ${!enabled ? 'df-node-disabled' : ''}${nodeHasPortsClass}" data-node-type="image" data-enabled="${enabled}">
          ${portRailIn}${portRailOut}
          <div class="df-node-status ${status}"></div>
          <div class="df-node-header">
            <div class="df-node-icon image">${this.icons.image}</div>
            <div class="df-node-title" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}</div>
            <button class="df-node-toggle ${enabled ? 'on' : 'off'}" title="${enabled ? (window.I18n?.t('node.disableNode') || 'Tắt node') : (window.I18n?.t('node.enableNode') || 'Bật node')}">
              <span class="df-node-toggle-track"><span class="df-node-toggle-thumb"></span></span>
            </button>
          </div>
          <div class="df-node-body">
            <div class="df-node-preview${refCount === 0 ? ' ratio-9-16' : ''}" data-node-preview>
              <div class="df-node-preview-placeholder">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              </div>
            </div>
            <div class="df-node-settings-bar">
              <span class="df-node-tag">${refCount ? refCount + ' ' + (window.I18n?.t('node.images') || 'images') : (window.I18n?.t('node.noImages') || 'No images')}</span>
            </div>
          </div>
          ${hoverToolbar}
        </div>`;
    }

    // Download node - special card
    if (type === 'download') {
      return `
        <div class="df-node ${!enabled ? 'df-node-disabled' : ''}${nodeHasPortsClass}" data-node-type="download" data-enabled="${enabled}">
          ${portRailIn}${portRailOut}
          <div class="df-node-status ${status}"></div>
          <div class="df-node-header">
            <div class="df-node-icon download">${this.icons.download}</div>
            <div class="df-node-title" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}</div>
          </div>
          <div class="df-node-body">
            <div class="df-node-download-info">${window.I18n?.t('node.downloadInfo') || 'Tự động tải kết quả từ node trước'}</div>
          </div>
          ${hoverToolbar}
        </div>`;
    }

    // Telegram node - special card
    if (type === 'telegram') {
      const chatId = data.telegram_chat_id || '';
      const sendMode = data.telegram_send_mode === 'group' ? (window.I18n?.t('node.telegramGroup') || 'Nhóm ảnh') : (window.I18n?.t('node.telegramSingle') || 'Từng ảnh');
      const statusText = chatId
        ? `<span class="df-telegram-linked"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> ${window.I18n?.t('node.telegramLinked') || 'Linked'}</span>`
        : `<span class="df-telegram-unlinked">${window.I18n?.t('node.notConfigured') || 'Chưa cấu hình'}</span>`;
      return `
        <div class="df-node ${!enabled ? 'df-node-disabled' : ''}${nodeHasPortsClass}" data-node-type="telegram" data-enabled="${enabled}">
          ${portRailIn}${portRailOut}
          <div class="df-node-status ${status}"></div>
          <div class="df-node-header">
            <div class="df-node-icon telegram">${this.icons.telegram}</div>
            <div class="df-node-title" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}</div>
          </div>
          <div class="df-node-body">
            <div class="df-node-telegram-info">
              ${statusText}
              <span class="df-telegram-mode">${sendMode}</span>
            </div>
          </div>
          ${hoverToolbar}
        </div>`;
    }

    // AI Agent node — Phase CG-8 + rename 2026-05-30: chứa text + tuỳ chọn use_ai qua LLM.
    // 2 chế độ: use_ai OFF = pass-through plain text, use_ai ON = submit qua ChatGPT/Gemini
    if (type === 'prompt') {
      const promptText = data.prompt || '';
      const enhance = !!data.use_ai;
      const provider = data.provider || 'chatgpt';
      const resultText = data.result_text || '';
      const resultSource = data.result_source || '';
      const providerLabel = provider === 'gemini' ? 'Gemini' : 'ChatGPT';
      const modeBadge = enhance
        ? `<span class="df-node-tag df-node-tag-mode-image">AI: ${this.escapeHtml(providerLabel)}</span>`
        : `<span class="df-node-tag">Plain</span>`;
      // Phase CG-8 ext: ref images count badge (chỉ khi use_ai=ON)
      const promptRefIds = data.ref_file_ids || '';
      const promptRefCount = promptRefIds ? promptRefIds.split(',').filter(Boolean).length : 0;
      const refBadge = (enhance && promptRefCount > 0)
        ? `<span class="df-node-tag">${promptRefCount} ${window.I18n?.t('node.images') || 'images'}</span>`
        : '';
      // AI Agent rename (2026-05-30): ai_delete_after_run badge — chỉ visible khi use_ai=ON.
      // SVG trash icon (server-only đa ngôn ngữ, KHÔNG emoji 🗑) + red tint background.
      const deleteAfter = !!data.ai_delete_after_run;
      const trashIconSvg = `<svg class="df-node-tag-delete-icon" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"/>
        <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/>
        <path d="M10 11v6M14 11v6"/>
        <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
      </svg>`;
      const deleteBadge = (enhance && deleteAfter)
        ? `<span class="df-node-tag df-node-tag-delete" title="${this.escapeAttr(window.I18n?.t('node.deleteAfterEnhanceTip') || 'Xoá conversation trên ' + providerLabel + ' sau khi AI run')}">${trashIconSvg}<span class="df-node-tag-delete-text">${this.escapeHtml(window.I18n?.t('node.deleteAfterEnhanceBadge') || 'Auto-delete')}</span></span>`
        : '';
      // AI Agent rename (2026-05-30) — design hiển thị 2 sections khi AI run done:
      //   Section 1: Prompt gốc (edit được qua ✏ button → textarea)
      //   Section 2: AI Output (read-only, label "AI: <provider>")
      // Khi chưa run AI hoặc Use AI OFF: chỉ hiện Section 1.
      const hasEnhancedResult = resultText && enhance && resultText.trim() !== promptText.trim();
      // Last error badge
      const lastError = data.last_error;
      const errorBadge = lastError
        ? `<span class="df-node-tag df-node-tag-error">${this.escapeHtml(lastError)}</span>`
        : '';
      return `
        <div class="df-node ${!enabled ? 'df-node-disabled' : ''}${nodeHasPortsClass}" data-node-type="prompt" data-enabled="${enabled}">
          ${portRailIn}${portRailOut}
          <div class="df-node-status ${status}"></div>
          <div class="df-node-header">
            <div class="df-node-icon prompt">${this.icons.prompt}</div>
            <div class="df-node-title" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}</div>
            <button class="df-node-toggle ${enabled ? 'on' : 'off'}" title="${enabled ? (window.I18n?.t('node.disableNode') || 'Tắt node') : (window.I18n?.t('node.enableNode') || 'Bật node')}">
              <span class="df-node-toggle-track"><span class="df-node-toggle-thumb"></span></span>
            </button>
          </div>
          <div class="df-node-body">
            <!-- Section 1: Prompt gốc (edit được). 2026-05-30: luôn show prompt gốc, KHÔNG replace với result. -->
            <div class="df-inline-prompt-container nodrag" data-mode="view">
              <div class="df-inline-prompt-view nodrag">
                ${promptText
                  ? `<span class="df-inline-prompt-text">${this.formatPromptWithMentions(promptText)}</span>`
                  : `<span class="df-inline-prompt-text df-inline-prompt-empty">${this.escapeHtml(window.I18n?.t('node.promptPlaceholder') || 'Nhập prompt...')}</span>`}
                <button type="button" class="df-inline-prompt-edit-btn nodrag" title="${this.escapeAttr(window.I18n?.t('node.editPrompt') || 'Sửa prompt')}">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
              </div>
              <textarea
                class="df-inline-prompt-edit nodrag"
                placeholder="${this.escapeAttr(window.I18n?.t('node.promptPlaceholder') || 'Nhập prompt...')}"
                rows="2"
                spellcheck="false"
              >${this.escapeHtml(promptText)}</textarea>
              <span class="df-inline-prompt-saved-badge nodrag" aria-hidden="true" data-i18n-key="common.saved">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                <span class="df-inline-prompt-saved-text"></span>
              </span>
            </div>
            <!-- Section 2: AI Output (read-only). 2026-05-30: chỉ hiện khi AI run done + result khác prompt gốc. -->
            ${hasEnhancedResult ? `
              <div class="df-ai-output-container nodrag">
                <div class="df-ai-output-label">
                  <svg class="df-ai-output-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 2l2 7h7l-5.5 4 2 7L12 16l-5.5 4 2-7L3 9h7z"/>
                  </svg>
                  <span class="df-ai-output-label-text">${this.escapeHtml(window.I18n?.t('node.aiOutputLabel') || 'AI Output')}</span>
                  <span class="df-ai-output-provider">${this.escapeHtml(providerLabel)}</span>
                </div>
                <div class="df-ai-output-text">${this.formatPromptWithMentions(resultText)}</div>
              </div>
            ` : ''}
            <div class="df-node-settings-bar">
              ${modeBadge}
              ${refBadge}
              ${deleteBadge}
              ${errorBadge}
            </div>
            ${(enhance && promptRefCount > 0) ? `<div class="df-node-ref-preview" data-ref-preview></div>` : ''}
          </div>
          ${hoverToolbar}
        </div>
      `;
    }

    // Phase 1 — Node Reference System: Text node — static text source for @mention composition
    if (type === 'text') {
      const textContent = data.prompt || data.note_text || '';
      const slug = data.slug || '';
      return `
        <div class="df-node ${!enabled ? 'df-node-disabled' : ''}${nodeHasPortsClass}" data-node-type="text" data-enabled="${enabled}">
          ${portRailIn}${portRailOut}
          <div class="df-node-status ${status}"></div>
          <div class="df-node-header">
            <div class="df-node-icon text">${this.icons.text}</div>
            <div class="df-node-title" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}</div>
            ${slug ? `<span class="df-node-slug-badge" title="@${slug}" data-tooltip="@${slug}">@${this.escapeHtml(slug)}</span>` : ''}
            <button class="df-node-toggle ${enabled ? 'on' : 'off'}" title="${enabled ? (window.I18n?.t('node.disableNode') || 'Tắt node') : (window.I18n?.t('node.enableNode') || 'Bật node')}">
              <span class="df-node-toggle-track"><span class="df-node-toggle-thumb"></span></span>
            </button>
          </div>
          <div class="df-node-body">
            ${textContent
              ? `<div class="df-node-prompt" title="${this.escapeAttr(textContent)}">${this.escapeHtml(textContent)}</div>`
              : `<div class="df-node-prompt df-node-prompt-empty">${window.I18n?.t('node.textPlaceholder') || 'Nhập text...'}</div>`}
          </div>
          ${hoverToolbar}
        </div>`;
    }

    // Text Extract Node (2026-05-29): pure regex/JSON parse, tách output text từ upstream.
    // Render: title + slug badge + small info row (mode + marker preview).
    // 2026-05-31: thêm AI Output container hiển thị result_text sau khi run (parity với prompt node).
    if (type === 'text_extract') {
      const slug = data.slug || '';
      const mode = data.extract_mode || 'marker';
      const marker = data.extract_marker || data.extract_regex || '';
      const markerLabel = marker
        ? this.escapeHtml(marker.substring(0, 40))
        : `<em>${window.I18n?.t('node.textExtractEmpty') || '(chưa set marker)'}</em>`;
      const modeIcon = mode === 'json' ? '{}' : (mode === 'regex' ? '/.../' : '[ ]');
      const extractResultText = (data.result_text || '').trim();
      const hasExtractResult = !!extractResultText;
      const extractOutputLabel = window.I18n?.t('node.extractOutputLabel') || 'Extracted';
      return `
        <div class="df-node ${!enabled ? 'df-node-disabled' : ''}${nodeHasPortsClass}" data-node-type="text_extract" data-enabled="${enabled}">
          ${portRailIn}${portRailOut}
          <div class="df-node-status ${status}"></div>
          <div class="df-node-header">
            <div class="df-node-icon text">${this.icons.text_extract}</div>
            <div class="df-node-title" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}</div>
            ${slug ? `<span class="df-node-slug-badge" title="@${slug}" data-tooltip="@${slug}">@${this.escapeHtml(slug)}</span>` : ''}
            <button class="df-node-toggle ${enabled ? 'on' : 'off'}" title="${enabled ? (window.I18n?.t('node.disableNode') || 'Tắt node') : (window.I18n?.t('node.enableNode') || 'Bật node')}">
              <span class="df-node-toggle-track"><span class="df-node-toggle-thumb"></span></span>
            </button>
          </div>
          <div class="df-node-body">
            <div class="df-node-extract-row">
              <span class="df-node-tag" title="${this.escapeAttr(mode)}">${modeIcon}</span>
              <span class="df-node-extract-marker" title="${this.escapeAttr(marker)}">${markerLabel}</span>
            </div>
            ${hasExtractResult ? `
              <div class="df-ai-output-container nodrag" data-extract-output>
                <div class="df-ai-output-label">
                  <svg class="df-ai-output-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="8" width="10" height="8" rx="1"/>
                  </svg>
                  <span class="df-ai-output-label-text">${this.escapeHtml(extractOutputLabel)}</span>
                </div>
                <div class="df-ai-output-text">${this.escapeHtml(extractResultText)}</div>
              </div>
            ` : ''}
          </div>
          ${hoverToolbar}
        </div>`;
    }

    // ChatGPT node — tương tự generate nhưng theo provider ChatGPT
    if (type === 'chatgpt') {
      // Mapping ratio key → label hiển thị (5 options) — từ PCM hoặc fallback
      const ratioUiMap = window.ProviderConfigManager?.getRatioUiMapSync?.('chatgpt')
        || { story: '9:16', portrait: '3:4', square: '1:1', landscape: '4:3', widescreen: '16:9' };
      const cgRatio = data.ratio || 'story';
      const cgRatioLabel = ratioUiMap[cgRatio] || cgRatio;
      const cgModel = data.model || 'Instant'; // Instant | Thinking (GPT-5.5)
      // Khung tỷ lệ preview — class chi tiết cho 5 options (chính xác từng ratio)
      const cgRatioClassMap = {
        story:      'ratio-9-16',
        portrait:   'ratio-3-4',
        square:     '',
        landscape:  'ratio-4-3',
        widescreen: 'ratio-16-9'
      };
      const cgRatioClass = cgRatioClassMap[cgRatio] !== undefined ? cgRatioClassMap[cgRatio] : '';

      // Mode pill: use_fallback_prefix (auto/always/never)
      const cgUseFallback = data.use_fallback_prefix || 'auto';
      const cgModeLabelMap = {
        auto: 'Auto',
        always: 'Always',
        never: 'Never',
      };
      const cgModeLabel = cgModeLabelMap[cgUseFallback] || cgUseFallback;

      // Badge error code last_error: RATE_LIMIT/CONTENT_BLOCKED/IMAGE_GEN_FAILED/NETWORK
      const lastError = data.last_error;
      const errorMap = {
        RATE_LIMIT: 'Hết lượt',
        CONTENT_BLOCKED: 'Bị chặn',
        IMAGE_GEN_FAILED: 'Lỗi gen',
        NETWORK: 'Mạng'
      };
      const errorLabel = lastError && errorMap[lastError] ? errorMap[lastError] : '';
      const errorBadge = errorLabel ? `<span class="df-node-tag df-node-tag-error">${errorLabel}</span>` : '';

      const cgRefFileIds = data.ref_file_ids || '';
      const cgRefCount = cgRefFileIds ? cgRefFileIds.split(',').filter(Boolean).length : 0;

      return `
        <div class="df-node ${!enabled ? 'df-node-disabled' : ''}${nodeHasPortsClass}" data-node-type="chatgpt" data-provider="openai" data-enabled="${enabled}">
          ${portRailIn}${portRailOut}
          ${this.renderProviderBadge('chatgpt')}
          <div class="df-node-status ${status}"></div>
          <div class="df-node-header">
            <div class="df-node-icon chatgpt">${headerIcon}</div>
            <div class="df-node-title" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}${this.renderMediaTypeBadge('Image')}</div>
            <button class="df-node-toggle ${enabled ? 'on' : 'off'}" title="${enabled ? (window.I18n?.t('node.disableNode') || 'Tắt node') : (window.I18n?.t('node.enableNode') || 'Bật node')}">
              <span class="df-node-toggle-track"><span class="df-node-toggle-thumb"></span></span>
            </button>
          </div>
          <div class="df-node-body">
            <div class="df-node-preview-wrap">
              <div class="df-node-preview ${cgRatioClass}" data-node-preview>
                <div class="df-node-preview-placeholder">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                </div>
              </div>
              ${prompt ? `<div class="df-node-prompt df-node-prompt-overlay nodrag" title="${this.escapeHtml(prompt)}">${this.escapeHtml(prompt)}</div>` : ''}
            </div>
            <div class="df-node-settings-bar">
              <button type="button" class="df-node-tag df-node-tag-editable" data-setting="chatgptModel" title="${window.I18n?.t('node.modelPill') || 'Model'}" data-tooltip="${window.I18n?.t('node.modelPill') || 'Model'}"><span>${this.escapeHtml(cgModel)}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
              <button type="button" class="df-node-tag df-node-tag-editable" data-setting="chatgptRatio" title="${window.I18n?.t('node.ratioPill') || 'Tỷ lệ'}" data-tooltip="${window.I18n?.t('node.ratioPill') || 'Tỷ lệ'}"><span>${this.escapeHtml(cgRatioLabel)}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
              <button type="button" class="df-node-tag df-node-tag-editable" data-setting="chatgptMode" title="${window.I18n?.t('workflow.chatgptMode') || 'Chế độ submit'}" data-tooltip="${window.I18n?.t('workflow.chatgptMode') || 'Chế độ submit'}"><span>${this.escapeHtml(cgModeLabel)}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
              ${errorBadge}
            </div>
            ${cgRefCount > 0 ? `<div class="df-node-ref-preview" data-ref-preview></div>` : ''}
          </div>
          ${hoverToolbar}
        </div>
      `;
    }

    // === GROK NODE === (Phase G-6.1)
    if (type === 'grok') {
      const grokRatio = data.ratio || 'widescreen';
      // Grok ratios: 2:3 / 3:2 / 1:1 / 9:16 / 16:9 (KHÔNG dùng 3:4/4:3 như ChatGPT) — từ PCM hoặc fallback
      const grokRatioUiMap = window.ProviderConfigManager?.getRatioUiMapSync?.('grok')
        || { 'story': '9:16', 'portrait': '2:3', 'square': '1:1', 'landscape': '3:2', 'widescreen': '16:9' };
      const grokRatioLabel = grokRatioUiMap[grokRatio] || grokRatio;
      // Map ratio key → preview ratio class (chi tiết cho từng tỷ lệ)
      // Grok ratios: story=9:16, portrait=2:3, square=1:1, landscape=3:2, widescreen=16:9
      const grokRatioClassMap = {
        story: 'ratio-9-16',
        portrait: 'ratio-2-3',
        square: '',
        landscape: 'ratio-3-2',
        widescreen: 'ratio-16-9'
      };
      const grokRatioClass = grokRatioClassMap[grokRatio] !== undefined ? grokRatioClassMap[grokRatio] : '';
      const grokMode = data.grok_mode || data.mode || 'image';
      const grokRefFileIds = data.ref_file_ids || '';
      const grokRefCount = grokRefFileIds ? grokRefFileIds.split(',').filter(Boolean).length : 0;
      const grokModeLabel = grokMode === 'video' ? 'Video' : 'Image';
      // Grok image quality (speed/quality) — chỉ khi mode=image
      const grokImageQuality = data.grok_image_quality || 'speed';
      const grokQualityLabel = grokImageQuality === 'quality'
        ? (window.I18n?.t('grok.imageQualityQuality') || 'Chất lượng')
        : (window.I18n?.t('grok.imageQualitySpeed') || 'Nhanh');
      // Grok video settings — chỉ khi mode=video
      const grokDuration = data.grok_duration || '6s';
      const grokResolution = data.grok_resolution || '720p';

      return `
        <div class="df-node ${!enabled ? 'df-node-disabled' : ''}${nodeHasPortsClass}" data-node-type="grok" data-provider="grok" data-media-type="${grokModeLabel}" data-enabled="${enabled}">
          ${portRailIn}${portRailOut}
          ${this.renderProviderBadge('grok')}
          <div class="df-node-status ${status}"></div>
          <div class="df-node-header">
            <div class="df-node-icon grok">${headerIcon}</div>
            <div class="df-node-title" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}${this.renderMediaTypeBadge(grokModeLabel)}</div>
            <button class="df-node-toggle ${enabled ? 'on' : 'off'}" title="${enabled ? (window.I18n?.t('node.disableNode') || 'Tắt node') : (window.I18n?.t('node.enableNode') || 'Bật node')}">
              <span class="df-node-toggle-track"><span class="df-node-toggle-thumb"></span></span>
            </button>
          </div>
          <div class="df-node-body">
            <div class="df-node-preview-wrap">
              <div class="df-node-preview ${grokRatioClass}" data-node-preview>
                <div class="df-node-preview-placeholder">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                </div>
              </div>
              ${prompt ? `<div class="df-node-prompt df-node-prompt-overlay nodrag" title="${this.escapeHtml(prompt)}">${this.escapeHtml(prompt)}</div>` : ''}
            </div>
            <div class="df-node-settings-bar">
                <button type="button" class="df-node-tag df-node-tag-editable" data-setting="grokMode" title="${window.I18n?.t('node.modeGrok') || 'Mode (Image/Video)'}" data-tooltip="${window.I18n?.t('node.modeGrok') || 'Mode (Image/Video)'}"><span>${grokModeLabel}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
              <button type="button" class="df-node-tag df-node-tag-editable" data-setting="grokRatio" title="${window.I18n?.t('node.ratioPill') || 'Tỷ lệ'}" data-tooltip="${window.I18n?.t('node.ratioPill') || 'Tỷ lệ'}"><span>${this.escapeHtml(grokRatioLabel)}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
              ${grokMode === 'image' ? `
              <button type="button" class="df-node-tag df-node-tag-editable" data-setting="grokImageQuality" title="${window.I18n?.t('workflow.grokImageQuality') || 'Chất lượng ảnh'}" data-tooltip="${window.I18n?.t('workflow.grokImageQuality') || 'Chất lượng ảnh'}"><span>${this.escapeHtml(grokQualityLabel)}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
              ` : `
              <button type="button" class="df-node-tag df-node-tag-editable" data-setting="grokDuration" title="${window.I18n?.t('workflow.grokDuration') || 'Thời lượng'}" data-tooltip="${window.I18n?.t('workflow.grokDuration') || 'Thời lượng'}"><span>${this.escapeHtml(grokDuration)}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
              <button type="button" class="df-node-tag df-node-tag-editable" data-setting="grokResolution" title="${window.I18n?.t('workflow.grokResolution') || 'Resolution'}" data-tooltip="${window.I18n?.t('workflow.grokResolution') || 'Resolution'}"><span>${this.escapeHtml(grokResolution)}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
              `}
              </div>
            ${grokRefCount > 0 ? `<div class="df-node-ref-preview" data-ref-preview></div>` : ''}
          </div>
          ${hoverToolbar}
        </div>
      `;
    }

    // Generate card (redesigned - larger with preview + inline settings)
    const refFileIds = data.ref_file_ids || '';
    const refCount = refFileIds ? refFileIds.split(',').filter(Boolean).length : 0;

    return `
      <div class="df-node ${!enabled ? 'df-node-disabled' : ''}${nodeHasPortsClass}" data-node-type="${type}" data-media-type="${mediaType}" data-provider="${this.getNodeProvider(type) || ''}" data-enabled="${enabled}">
        ${portRailIn}${portRailOut}
        ${this.renderProviderBadge(type)}
        <div class="df-node-status ${status}"></div>
        <div class="df-node-header">
          <div class="df-node-icon ${config.color}">${headerIcon}</div>
          <div class="df-node-title" title="${this.escapeAttr(name)}">${this.escapeHtml(name)}${this.renderMediaTypeBadge(mediaType, isVideoFrames)}</div>
          <button class="df-node-toggle ${enabled ? 'on' : 'off'}" title="${enabled ? (window.I18n?.t('node.disableNode') || 'Tắt node') : (window.I18n?.t('node.enableNode') || 'Bật node')}">
            <span class="df-node-toggle-track"><span class="df-node-toggle-thumb"></span></span>
          </button>
        </div>
        <div class="df-node-body">
          <div class="df-node-preview-wrap">
            <div class="df-node-preview ${ratioClass}" data-node-preview>
              <div class="df-node-preview-placeholder">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              </div>
            </div>
            ${prompt ? `<div class="df-node-prompt df-node-prompt-overlay nodrag" title="${this.escapeHtml(prompt)}">${this.escapeHtml(prompt)}</div>` : ''}
          </div>
          <div class="df-node-settings-bar">
              <button type="button" class="df-node-tag df-node-tag-editable" data-setting="quantity" data-qty-value title="${window.I18n?.t('node.quantityPill') || 'Số lượng'}" data-tooltip="${window.I18n?.t('node.quantityPill') || 'Số lượng'}"><span>${quantity}x</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
            <button type="button" class="df-node-tag df-node-tag-editable" data-setting="mediaType" title="${window.I18n?.t('node.mediaTypePill') || 'Loại media'}" data-tooltip="${window.I18n?.t('node.mediaTypePill') || 'Loại media'}"><span>${mediaType}${isVideoFrames ? ' Frames' : ''}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>
            ${model ? `<button type="button" class="df-node-tag df-node-tag-editable" data-setting="model" title="${window.I18n?.t('node.modelPill') || 'Model'}" data-tooltip="${window.I18n?.t('node.modelPill') || 'Model'}"><span>${this.escapeHtml(model)}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>` : `<button type="button" class="df-node-tag df-node-tag-editable df-node-tag-empty" data-setting="model" title="${window.I18n?.t('node.modelPill') || 'Model'}" data-tooltip="${window.I18n?.t('node.modelPill') || 'Model'}"><span>${window.I18n?.t('node.modelAuto') || 'Auto'}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>`}
            ${isVideo ? `<button type="button" class="df-node-tag df-node-tag-editable" data-setting="videoDuration" title="${window.I18n?.t('node.durationPill') || 'Thời lượng'}" data-tooltip="${window.I18n?.t('node.durationPill') || 'Thời lượng'}"><span>${videoDuration}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>` : ''}
            ${ratio ? `<button type="button" class="df-node-tag df-node-tag-editable" data-setting="ratio" title="${window.I18n?.t('node.ratioPill') || 'Tỷ lệ'}" data-tooltip="${window.I18n?.t('node.ratioPill') || 'Tỷ lệ'}"><span>${this.escapeHtml(ratio)}</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>` : `<button type="button" class="df-node-tag df-node-tag-editable df-node-tag-empty" data-setting="ratio" title="${window.I18n?.t('node.ratioPill') || 'Tỷ lệ'}" data-tooltip="${window.I18n?.t('node.ratioPill') || 'Tỷ lệ'}"><span>—</span><svg class="df-pill-arrow" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></button>`}
            </div>
          ${refCount > 0 ? `<div class="df-node-ref-preview" data-ref-preview></div>` : ''}
        </div>
        ${hoverToolbar}
      </div>
    `;
  },

  /**
   * Default data cho node MỚI tạo — đồng bộ với sidebar form defaults.
   * Tránh mismatch: pill "—" / "Auto" trong khi sidebar form có default 16:9 / Nano Banana Pro.
   * Caller (addNode) merge defaults này vào data trước khi gọi editor.addNode.
   *
   * @param {string} type - Node type
   * @param {object|null} settings - User af_settings object (nullable). Khi null/thiếu key, fallback hardcode defaults.
   */
  _mapVnRatioToNumeric(vnRatio) {
    if (!vnRatio) return null;
    const map = { 'Dọc': '9:16', 'Ngang': '16:9', 'Vuông': '1:1' };
    return map[vnRatio] || vnRatio; // pass-through nếu đã numeric
  },

  /**
   * 2026-05-25: Client-side normalize required defaults — mirror backend
   * `WorkflowDataHealer::normalizeRequiredDefaults` (5 rules).
   *
   * Mục đích: tránh bug "display drift" — vd `media_type='Video'` nhưng `video_input_type=null`
   * → diagram render Ingredients-style (2 ports) trong khi form auto-select 'Frames' (browser
   * default cho option đầu).
   *
   * Wire vào các path tạo node có nguy cơ propagate empty values:
   *  - `DiagramCanvas.duplicateNode` (spread source data)
   *  - `_copyNodeToClipboard` + `_pasteNodeFromClipboard` (deep clone source)
   *  - `DiagramCanvas.loadWorkflow` (legacy/clone data từ server)
   *
   * Mutate in-place + return cho convenience chain.
   *
   * @param {Object} data - Node data object
   * @returns {Object} same reference, mutated
   */
  normalizeNodeData(data) {
    if (!data || typeof data !== 'object') return data;
    const t = data.node_type;

    // Generate node defaults
    if (t === 'generate') {
      if (!data.media_type) data.media_type = 'Image';
      if (data.media_type === 'Video') {
        if (!data.video_input_type) {
          // 2026-05-29: đọc default từ StorageSettings (server-tuned qua /admin/default-settings)
          const settingDefault = window.storageSettings?.get?.('defaultVideoInputType');
          data.video_input_type = (settingDefault === 'Ingredients' || settingDefault === 'Frames')
            ? settingDefault : 'Frames';
        }
        if (!data.video_duration) data.video_duration = '6s';
      }
    }
    // ChatGPT node defaults
    else if (t === 'chatgpt') {
      if (!data.use_fallback_prefix) data.use_fallback_prefix = 'auto';
      // Heal model: chatgpt chỉ dùng model chatgpt (Instant/Thinking). Legacy/export cũ luôn set
      // model='Nano Banana 2' (flow default) cho mọi node → reset về chatgpt default để pill +
      // selectChatGPTModel đúng. Chỉ reset nếu model KHÔNG thuộc danh sách model chatgpt.
      const cgModels = window.ModelRegistry?.safeGetValuesList?.('chatgpt', 'image') || ['Instant', 'Thinking'];
      if (!data.model || (cgModels.length > 0 && !cgModels.includes(data.model))) {
        data.model = window.ModelRegistry?.safeGetDefault?.('chatgpt', 'image') || cgModels[0] || 'Instant';
      }
    }
    // Grok node defaults
    else if (t === 'grok') {
      if (!data.grok_mode) data.grok_mode = 'image';
    }
    // AI Agent rename (2026-05-30) — Prompt/AI Agent node: heal stale chrome.storage data.
    // - Pair 1+2 (enhance/enhance_fallback): v1.1.5 PUBLIC client có field → heal cho user
    //   update v1.1.5 → v1.1.6 (chrome.storage cache stale).
    // - Pair 3 (delete_after_enhance): v1.1.5 PUBLIC client KHÔNG có, NHƯNG v1.1.6 dev test
    //   đã ghi field này trước rename → workflow saved có delete_after_enhance=true nhưng
    //   ai_delete_after_run undefined. Heal 1-way để protect dev/test data.
    // 1-way migrate sang keys mới khi user vừa update extension. KHÔNG ghi ngược (backend Node observer lo).
    else if (t === 'prompt') {
      if (data.use_ai === undefined && data.enhance !== undefined) data.use_ai = !!data.enhance;
      if (data.ai_fallback === undefined && data.enhance_fallback !== undefined) data.ai_fallback = !!data.enhance_fallback;
      if (data.ai_delete_after_run === undefined && data.delete_after_enhance !== undefined) data.ai_delete_after_run = !!data.delete_after_enhance;
    }
    // Text Extract Node (2026-05-29): fill defaults nếu thiếu (paste/import workflow cũ)
    else if (t === 'text_extract') {
      if (!data.extract_mode) data.extract_mode = 'marker';
      if (data.extract_strict === undefined) data.extract_strict = false;
      if (!data.extract_multi_match) data.extract_multi_match = 'first';
      if (!data.extract_on_fail) data.extract_on_fail = 'skip_downstream';
    }

    return data;
  },

  getDefaults(type, settings = null) {
    type = this._normalizeType(type);
    switch (type) {
      case 'generate': {
        const mediaType = settings?.defaultGenType || 'Image';
        const isVideo = mediaType === 'Video';

        // Ưu tiên key numeric mới (Settings popup save), fallback legacy VN key
        const userRatio = isVideo
          ? (settings?.defaultVideoRatio || this._mapVnRatioToNumeric(settings?.defaultRatio))
          : (settings?.defaultImageRatio || this._mapVnRatioToNumeric(settings?.defaultRatio));

        // Video chỉ có '16:9'/'9:16' — cap fallback nếu user ratio không tương thích
        const ratio = isVideo
          ? ((userRatio === '16:9' || userRatio === '9:16') ? userRatio : '16:9')
          : (userRatio || '16:9');

        // Strict Server-Only: user pref → ModelRegistry → null (caller xử lý).
        const model = (isVideo ? settings?.defaultVideoModel : settings?.defaultImageModel)
          || window.ModelRegistry?.safeGetDefault('flow', isVideo ? 'video' : 'image')
          || null;
        if (!model) console.debug(`[Tier3] NodeTemplates: flow.${isVideo ? 'video' : 'image'} default model cache miss`);

        // 2026-05-29: video_input_type default từ settings (admin tune qua /admin/default-settings)
        const videoInputDefault = settings?.defaultVideoInputType;
        const videoInputType = (videoInputDefault === 'Ingredients' || videoInputDefault === 'Frames')
          ? videoInputDefault : 'Frames';

        return {
          quantity: 1,
          media_type: mediaType,
          ratio,
          model,
          video_input_type: isVideo ? videoInputType : undefined,
          video_duration: isVideo ? (settings?.defaultVideoDuration || '6s') : undefined,
          // Flow Voice Selector — default null (Random voice). Picker chỉ hiển thị khi model.config.supports_voice=true
          voice_slug: null,
          voice_search_value: null,
          auto_download: false,
          download_resolution: settings?.downloadResolution || '1k',
          video_download_resolution: '720p',
          enabled: true,
          status: 'pending',
        };
      }
      case 'chatgpt':
        return {
          ratio: settings?.chatgptDefaultRatio || 'story',
          use_fallback_prefix: 'auto',
          timeout_ms: 120000,
          max_ref_images: 4,
          auto_download: false,
          enabled: true,
          status: 'pending',
        };
      case 'grok':
        return {
          ratio: settings?.grokDefaultRatio || 'widescreen',
          grok_mode: settings?.grokDefaultMode || 'image',
          grok_duration: settings?.grokDefaultDuration || '6s',
          grok_resolution: settings?.grokDefaultResolution || '720p',
          grok_image_quality: settings?.grokDefaultImageQuality || 'speed',
          quantity: 1,
          timeout_ms: 180000,
          max_ref_images: 4,
          auto_download: false,
          enabled: true,
          status: 'pending',
        };
      case 'prompt':
        // AI Agent rename (2026-05-30) — extension v1.1.6+ chỉ dùng keys mới.
        // Backend Node observer mirror sang legacy enhance/enhance_fallback cho v1.1.3 client backward compat.
        // ai_delete_after_run default TRUE (2026-05-30 UX): khi user enable AI, conversation auto-cleanup
        // → tránh history rác ChatGPT/Gemini. User có thể tắt nếu muốn keep conversation.
        return {
          use_ai: false,
          ai_fallback: true,
          ai_delete_after_run: true,
          provider: 'chatgpt',
          timeout_sec: 60,
          max_ref_images: 4,
          enabled: true,
          status: 'pending',
        };
      case 'delay':
        return { delay_seconds: 3, enabled: true, status: 'pending' };
      case 'download':
        return {
          download_resolution: settings?.downloadResolution || '1k',
          download_folder: '',
          download_file_template: '',
          download_collect_all: false,
          enabled: true,
          status: 'pending',
        };
      case 'telegram':
        return { telegram_send_mode: 'group', telegram_message: '', enabled: true, status: 'pending' };
      case 'image':
        return { max_ref_images: 1, enabled: true, status: 'pending' };
      // Phase 1 — Node Reference System: Text node defaults
      case 'text':
        return { prompt: '', slug_auto: true, enabled: true, status: 'pending' };
      // Text Extract Node (2026-05-29): pure regex/JSON parse defaults
      case 'text_extract':
        return {
          extract_mode: 'marker',
          extract_marker: '',
          extract_regex: '',
          extract_strict: false,
          extract_multi_match: 'first',
          extract_on_fail: 'skip_downstream',
          slug_auto: true,
          enabled: true,
          status: 'pending',
        };
      case 'note':
        return { note_text: '', enabled: true };
      default:
        return { enabled: true, status: 'pending' };
    }
  },

  // Create palette item HTML
  createPaletteItem(type) {
    const config = this.getType(type);
    const icon = this.icons[type];
    const isComingSoon = !!config.comingSoon;
    const comingSoonLabel = window.I18n?.t('workflow.comingSoon') || 'Sắp ra mắt';
    
    const isGenerateLocked = type === 'generate' && !(window.featureGate?.canUse('gen_enabled') ?? false);
    const isTelegramLocked = type === 'telegram' && (
      !(window.featureGate?.canUse('telegram_enabled') ?? false) ||
      !(window.featureGate?.canUse('telegram_workflow') ?? false)
    );
    const isChatGPTLocked = type === 'chatgpt' && !(window.featureGate?.canUse('chatgpt_enabled') ?? false);
    const isPromptLocked = type === 'prompt' && !(window.featureGate?.canUse('prompt_node_enabled') ?? false);
    const isGrokLocked = type === 'grok' && !(window.featureGate?.canUse('grok_enabled') ?? false);
    const isLocked = isGenerateLocked || isTelegramLocked || isChatGPTLocked || isPromptLocked || isGrokLocked;
    const premiumBadge = isLocked
      ? ' <svg width="12" height="12" viewBox="0 0 24 24" fill="#eab308" style="margin-left:4px;vertical-align:middle;display:inline-block;"><path d="M5 16L3 5L8.5 10L12 4L15.5 10L21 5L19 16H5ZM19 19C19 19.6 18.6 20 18 20H6C5.4 20 5 19.6 5 19V18H19V19Z"></path></svg>'
      : '';

    return `
      <div class="node-palette-item${isComingSoon ? ' node-palette-item--coming-soon' : ''}"
           data-node-type="${type}"
           draggable="${isComingSoon ? 'false' : 'true'}"
           ${isComingSoon ? `data-disabled="true" title="${comingSoonLabel}"` : ''}>
        <div class="node-palette-item-icon df-node-icon ${config.color}">${icon}</div>
        <div class="node-palette-item-name">${config.name}${premiumBadge}</div>
        ${isComingSoon ? `<span class="node-palette-item-badge">${comingSoonLabel}</span>` : ''}
      </div>
    `;
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  },

  escapeAttr(text) {
    return String(text || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  /**
   * Render prompt với @slug mentions được highlight (label color giống .df-node-tag-mode-image).
   * Escape HTML first, sau đó replace @slug pattern → span wrap.
   * Slug pattern: lowercase + digit + underscore, 1-30 chars (match MAX_MENTIONS regex).
   */
  formatPromptWithMentions(text) {
    if (!text) return '';
    const escaped = this.escapeHtml(text);
    // @slug pattern (match WorkflowEditor _parseMentions regex)
    // Phải dùng pattern trên text đã escape — `&` đã thành `&amp;` nên @slug vẫn intact
    return escaped.replace(/@([a-z][a-z0-9_]{0,29})/gi,
      '<span class="df-prompt-mention">@$1</span>');
  },

  // Phase WK-1.2: Resolve danh sách port hiển thị cho 1 node theo data hiện tại.
  // Hỗ trợ dynamic ports qua `visibleWhen` flag (vd frame_1/frame_2 chỉ visible khi media_type=Video + Frames).
  // Hỗ trợ dynamic port type qua `dynamicType` (vd port `media` của generate đổi type theo data.media_type).
  //
  // Group D: Đọc ports từ getType() (merged local + server). Server override ports
  // nếu admin update qua admin panel. Resolver logic (visibleWhen, dynamicType) VẪN ở
  // extension — backend chỉ store string identifiers.
  // Doc: data/plans/NODE_RESOLVERS_REGISTRY.md
  getNodePorts(type, data = {}) {
    type = this._normalizeType(type);
    // Group D: dùng getType() để merged ports (server override local).
    // Fallback this.types[type] nếu getType chưa available (vd: trong test).
    const merged = this.getType ? this.getType(type) : null;
    const config = merged || this.types[type];
    if (!config?.ports) return { in: [], out: [] };

    const filterDynamic = (port) => {
      if (!port.visibleWhen) return true;
      if (port.visibleWhen === 'isVideoFrames') {
        // UI 2026-05-27: ẩn port frame nếu model set config.supports_frames=false.
        const flowAdapter = window.ProviderRegistry?.get?.('flow');
        const modelSupportsFrames = typeof flowAdapter?.supportsFrames === 'function'
          ? flowAdapter.supportsFrames(data.model) : true;
        return data.media_type === 'Video' && data.video_input_type === 'Frames' && modelSupportsFrames;
      }
      if (port.visibleWhen === 'enhance') {
        // AI Agent rename (2026-05-30): port image_ref visible khi use_ai=ON.
        // visibleWhen resolver key giữ 'enhance' để backward compat config server không cần re-seed.
        return !!data.use_ai;
      }
      return true;
    };

    // Resolve dynamicType: vd port.dynamicType='media_type' + data.media_type='Video' → type='video'
    // CRITICAL: trả về clone (spread) để KHÔNG mutate config.types[type].ports gốc.
    const resolveDynamicType = (port) => {
      if (!port.dynamicType) return port;
      if (port.dynamicType === 'media_type') {
        const mt = data.media_type || 'Image';
        return { ...port, type: mt === 'Video' ? 'video' : 'image' };
      }
      // Phase G-6: Grok output port resolve theo data.grok_mode ('image' | 'video').
      // Cần thiết để port type sync với mode → PORT_COMPAT block edges incompat
      // (vd: video result → image ref / frame port).
      if (port.dynamicType === 'grok_mode') {
        const mode = data.grok_mode || data.mode || 'image';
        return { ...port, type: mode === 'video' ? 'video' : 'image' };
      }
      return port;
    };

    return {
      in: (config.ports.in || []).filter(filterDynamic).map(resolveDynamicType),
      out: (config.ports.out || []).filter(filterDynamic).map(resolveDynamicType),
    };
  },

  // Server-fetched node types cache
  _serverTypes: null,
  _serverTypesFetching: false,
  _serverTypesPromise: null,
  _serverTypesFetchedAt: 0,
  _SERVER_TYPES_TTL: 60 * 60 * 1000, // [Phase 5 2026-05-24] 1h — ConfigVersionPoller + SSE invalidate (admin tweak rare)
  _lastVersion: null,                // [Phase 5] cached version từ response.meta.version

  /**
   * Fetch node types từ server và cache
   * @returns {Promise<Object>} Map of type -> config
   */
  async fetchFromServer() {
    // Return cached if still fresh (TTL)
    if (this._serverTypes && this._serverTypesFetchedAt &&
        (Date.now() - this._serverTypesFetchedAt < this._SERVER_TYPES_TTL)) {
      console.log('[NodeTemplates] fetchFromServer → returning cached', Object.keys(this._serverTypes).length, 'types');
      return this._serverTypes;
    }
    console.log('[NodeTemplates] fetchFromServer → fetching fresh data...');

    // Return existing promise if fetching
    if (this._serverTypesFetching && this._serverTypesPromise) {
      return this._serverTypesPromise;
    }

    this._serverTypesFetching = true;
    this._serverTypesPromise = this._doFetch();

    try {
      const result = await this._serverTypesPromise;
      this._serverTypes = result;
      this._serverTypesFetchedAt = Date.now();
      return result;
    } finally {
      this._serverTypesFetching = false;
    }
  },

  async _doFetch() {
    try {
      const baseUrl = window.ApiBaseConfig.get();
      const headers = { 'Content-Type': 'application/json' };
      // Anti-clone: X-Extension-Id để pass VerifyExtensionId middleware khi toggle ON
      try { if (chrome?.runtime?.id) headers['X-Extension-Id'] = chrome.runtime.id; } catch (_) {}
      // Sprint 3 HMAC: ký để pass VerifySignature enforce mode (đồng bộ background.js)
      try { Object.assign(headers, await (window.RequestSigner?.headers?.('GET', new URL(`${baseUrl}/workflow-node-types`).pathname, '') || {})); } catch (_) {}
      try {
        const manifestVersion = chrome?.runtime?.getManifest?.()?.version;
        if (manifestVersion) headers['X-Ext-Version'] = manifestVersion;
      } catch (e) { /* ignore — chrome.runtime not available */ }
      // Include bearer token for feature gate filtering (backend detectUser từ token)
      try {
        const token = window.authManager?.token;
        if (token) headers['Authorization'] = `Bearer ${token}`;
      } catch (e) { /* ignore — authManager not available */ }

      console.log('[NodeTemplates] Fetching from:', `${baseUrl}/workflow-node-types`, 'token:', !!headers['Authorization']);

      // Timeout 8s — tránh sidebar đứng hình trên mạng chậm.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      let resp;
      try {
        resp = await fetch(`${baseUrl}/workflow-node-types`, {
          method: 'GET',
          headers,
          // BẮT BUỘC `no-store` — chống Chrome HTTP cache stale entry sau khi admin
          // deactivate node type (vd migration deactivate angles/list/upscale).
          // Cùng pattern với background.js apiRequest cho /entitlements.
          cache: 'no-store',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!resp.ok) {
        console.warn('[NodeTemplates] Failed to fetch node types from server:', resp.status);
        return {};
      }

      const json = await resp.json();
      if (!json.success || !Array.isArray(json.data)) {
        console.warn('[NodeTemplates] Invalid response:', { success: json.success, dataType: typeof json.data, dataLength: json.data?.length });
        return {};
      }
      console.log('[NodeTemplates] Server returned', json.data.length, 'node types');
      // [Phase 5] Persist version từ meta cho ConfigVersionPoller diff
      if (json.meta && typeof json.meta.version !== 'undefined') {
        this._lastVersion = json.meta.version;
      }

      // Convert array to map. Group D: extract đầy đủ config schema:
      //   - metadata (name, description, icon, color, comingSoon, sortOrder)
      //   - ports (server override local types ports)
      //   - defaults (model, ratio, quantity, media_type)
      //   - validation (prompt_max_length per node, etc.)
      //   - ui (terminal_sink, show_model_picker, etc.)
      //   - raw_config (everything else — provider-specific configs like supported_ratios)
      const serverMap = {};
      for (const item of json.data) {
        const cfg = item.config || {};
        serverMap[item.type] = {
          // Metadata
          name: item.name,
          description: item.description,
          icon: item.icon || null,
          color: item.color || item.type,
          comingSoon: item.coming_soon === true || item.coming_soon === 1,
          sortOrder: item.sort_order ?? 999,
          // Group D: Schema từ config JSON
          ports: cfg.ports || null,           // null = giữ local ports
          defaults: cfg.defaults || {},
          validation: cfg.validation || {},
          ui: cfg.ui || {},
          // Raw config — provider-specific fields (max_ref_images, supported_modes, ratio_ui_map, etc.)
          // Vẫn giữ để code legacy đọc trực tiếp config.X (vd: chatgpt fallback_prompt_prefix)
          config: cfg,
        };
      }

      console.log('[NodeTemplates] Loaded', Object.keys(serverMap).length, 'node types from server:',
        Object.entries(serverMap).map(([k, v]) => `${k}="${v.name}"`).join(', '));
      return serverMap;
    } catch (err) {
      console.warn('[NodeTemplates] Error fetching node types:', err.message);
      return {};
    }
  },

  /**
   * Get merged config for a node type (server overrides local)
   * @param {string} type - Node type key
   * @returns {Object} Config object
   */
  getType(type) {
    type = this._normalizeType(type);
    const localConfig = this.types[type] || this.types.generate;
    const serverConfig = this._serverTypes?.[type];

    if (!serverConfig) {
      // console.debug('[NodeTemplates] getType', type, '→ local only (no server config)');
      return localConfig;
    }
    // console.debug('[NodeTemplates] getType', type, '→ merged (server name:', serverConfig.name, ')');

    // Group D: Server values override local cho TOÀN BỘ schema:
    //   - Metadata (name, description, color, icon, comingSoon, sortOrder)
    //   - Ports (server.ports override local.ports nếu có — admin có thể thêm/xoá port qua admin panel)
    //   - Defaults (model, ratio, quantity, media_type — admin tweak được)
    //   - Validation (prompt_max_length per node, etc.)
    //   - UI (terminal_sink, show_model_picker, etc.)
    //   - Raw config (provider-specific fields)
    //
    // CRITICAL: Ports server CHỈ chứa string identifiers (visibleWhen=isVideoFrames,
    // dynamicType=media_type). Resolver logic vẫn ở getNodePorts (extension) —
    // xem data/plans/NODE_RESOLVERS_REGISTRY.md.
    return {
      ...localConfig,
      // Metadata override
      name: serverConfig.name || localConfig.name,
      description: serverConfig.description || localConfig.description,
      color: serverConfig.color || localConfig.color,
      icon: serverConfig.icon || localConfig.icon,
      comingSoon: serverConfig.comingSoon ?? localConfig.comingSoon ?? false,
      sortOrder: serverConfig.sortOrder ?? localConfig.sortOrder ?? 999,
      // Schema override (Group D — NEW)
      ports: serverConfig.ports || localConfig.ports,
      defaults: { ...(localConfig.defaults || {}), ...(serverConfig.defaults || {}) },
      validation: { ...(localConfig.validation || {}), ...(serverConfig.validation || {}) },
      ui: { ...(localConfig.ui || {}), ...(serverConfig.ui || {}) },
      // Raw config merged — provider-specific fields readable trực tiếp
      config: { ...(localConfig.config || {}), ...(serverConfig.config || {}) },
    };
  },

  /**
   * Get all types merged with server data, sorted by sortOrder
   * @returns {Object} Map of type -> config (sorted by sortOrder)
   */
  getMergedTypes() {
    const local = this.types;
    const server = this._serverTypes || {};

    console.log('[NodeTemplates] getMergedTypes - local keys:', Object.keys(local).length, 'server keys:', Object.keys(server).length);

    const merged = {};

    // Merge local với server values
    for (const [key, localConfig] of Object.entries(local)) {
      const serverConfig = server[key];
      if (serverConfig) {
        merged[key] = {
          ...this.getType(key),
          sortOrder: serverConfig.sortOrder ?? 999,
        };
      } else {
        // Local-only type (không có trên server) → sortOrder cao
        merged[key] = {
          ...localConfig,
          sortOrder: 999,
        };
      }
    }

    // Thêm types chỉ có trên server (không có trong local)
    for (const [key, serverConfig] of Object.entries(server)) {
      if (!merged[key]) {
        merged[key] = {
          ...serverConfig,
          name: serverConfig.name || key,
          color: serverConfig.color || 'generate',
          sortOrder: serverConfig.sortOrder ?? 999,
        };
      }
    }

    // Sort theo sortOrder và rebuild object
    const sorted = Object.entries(merged)
      .sort((a, b) => (a[1].sortOrder ?? 999) - (b[1].sortOrder ?? 999));

    const result = {};
    for (const [key, config] of sorted) {
      result[key] = config;
    }

    return result;
  },

  /**
   * Clear server cache (call when need refresh)
   */
  clearServerCache() {
    this._serverTypes = null;
    this._serverTypesFetchedAt = 0;
  },

  /**
   * [Phase 5 2026-05-24] Called by ConfigVersionPoller khi version mismatch.
   * Invalidate cache + force fetch fresh, emit refreshed event để UI re-render.
   */
  async _updateFromVersion(remoteVersion) {
    if (this._lastVersion === remoteVersion) return; // No-op (Polish 3 defensive)
    console.log('[NodeTemplates] Version mismatch:', this._lastVersion, '→', remoteVersion);
    this._serverTypes = null;
    this._serverTypesFetchedAt = 0;
    await this.fetchFromServer();
    if (window.eventBus) {
      window.eventBus.emit('node_types:refreshed', { source: 'version_poller' });
    }
  }
};

// Export
window.NodeTemplates = NodeTemplates;
