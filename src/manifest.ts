import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'TobyFlow — AI Workflow Automation',
  description: 'Auto Flow, Auto ChatGPT, Auto Grok & AI Workflow Automation',
  version: '2.0.0',
  
  permissions: [
    'storage',
    'sidePanel',
    'activeTab',
    'tabs',
    'notifications',
    'contextMenus',
    'downloads',
  ],
  
  host_permissions: [
    'https://labs.google/*',
    'https://aitestkitchen.withgoogle.com/*',
    'https://chatgpt.com/*',
    'https://chat.openai.com/*',
    'https://grok.com/*',
    'https://x.ai/*',
    'https://gemini.google.com/*',
    'https://labs.toby.vn/*',
  ],

  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },

  side_panel: {
    default_path: 'src/sidepanel/index.html',
  },

  content_scripts: [
    {
      matches: ['https://labs.google/*', 'https://aitestkitchen.withgoogle.com/*'],
      js: ['src/content-scripts/flow/index.ts'],
      run_at: 'document_idle',
    },
  ],

  action: {
    default_title: 'TobyFlow',
    default_icon: {
      16: 'src/assets/icons/icon-16.png',
      32: 'src/assets/icons/icon-32.png',
      48: 'src/assets/icons/icon-48.png',
      128: 'src/assets/icons/icon-128.png',
    },
  },

  icons: {
    16: 'src/assets/icons/icon-16.png',
    32: 'src/assets/icons/icon-32.png',
    48: 'src/assets/icons/icon-48.png',
    128: 'src/assets/icons/icon-128.png',
  },

  web_accessible_resources: [
    {
      resources: ['src/content-scripts/chatgpt/index.ts', 'src/content-scripts/grok/index.ts'],
      matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*', 'https://grok.com/*', 'https://x.ai/*'],
    },
  ],
});
