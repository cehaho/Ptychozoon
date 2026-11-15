import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

// Globals defined by the classic renderer scripts (UMD) and the vendored
// libraries that index.html and admin.html load before the modules.
const rendererGlobals = Object.fromEntries(
  [
    'Admin',
    'Alerts',
    'AppDialog',
    'Discovery',
    'FitAddon',
    'Hosts',
    'KnownHostsAdmin',
    'LatencyHistory',
    'NodeSearch',
    'Probe',
    'ProbeChecks',
    'QuickActions',
    'SnmpUI',
    'Terminal',
    'Topology',
    'TopologyCanvas',
    'TopologyExport',
    'lucide'
  ].map((name) => [name, 'readonly'])
);

export default [
  { ignores: ['node_modules/', 'renderer/vendor/', 'src-tauri/', 'dist/'] },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
    }
  },
  {
    files: ['renderer/js/app/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser }
    }
  },
  {
    files: ['renderer/js/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.commonjs, ...rendererGlobals }
    }
  },
  {
    files: ['lib/**/*.js', 'scripts/**/*.js', 'test/**/*.js', '*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node }
    }
  },
  prettier
];
