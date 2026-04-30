/**
 * Build-time constants injected by esbuild's `define` (see esbuild.config.mjs).
 * Surfaced in the webview header so dogfood users can verify the loaded
 * plugin matches the latest build at a glance (Cmd+R confirmation).
 */
declare const __PLUGIN_VERSION__: string;
declare const __PLUGIN_GIT_SHORT__: string;
declare const __PLUGIN_BUILD_ISO__: string;
