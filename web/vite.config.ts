import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

/**
 * Compiles the React + Tailwind v4 app into the exact two-file static contract
 * expected by `dashboard/server.mjs` and the unmodified `dsh-plugin/lib/console.mjs`:
 *   - `dashboard/public/index.html` (contains `<meta name="wb-console-build" content="__WB_BUILD__">`,
 *     early `id="navTabs"` marker for plugin probe, `<link rel="stylesheet" href="/style.css">`,
 *     and the self-contained IIFE JS bundle inlined inside `<script>...</script>`)
 *   - `dashboard/public/style.css` (compiled Tailwind CSS v4 + design system tokens)
 *
 * Benefits:
 *   - Zero runtime npm dependencies in the shipped package
 *   - Zero changes required in `dsh-plugin/lib/` (build hash automatically tracks both HTML+JS & CSS)
 *   - 100% offline local operation on 127.0.0.1:8792
 */
function inlineBundleToTwoFiles(): Plugin {
  return {
    name: 'wb-inline-bundle-two-files',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      let jsKey = '';
      let jsCode = '';
      let cssKey = '';
      let htmlKey = '';

      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && chunk.isEntry) {
          jsKey = fileName;
          jsCode = chunk.code;
        } else if (chunk.type === 'asset' && fileName.endsWith('.css')) {
          cssKey = fileName;
        } else if (chunk.type === 'asset' && fileName === 'index.html') {
          htmlKey = fileName;
        }
      }

      if (cssKey && cssKey !== 'style.css') {
        const cssAsset = bundle[cssKey];
        if (cssAsset && cssAsset.type === 'asset') {
          cssAsset.fileName = 'style.css';
          bundle['style.css'] = cssAsset;
          delete bundle[cssKey];
        }
      }

      if (htmlKey && jsKey) {
        const htmlAsset = bundle[htmlKey];
        if (htmlAsset && htmlAsset.type === 'asset') {
          let html = typeof htmlAsset.source === 'string'
            ? htmlAsset.source
            : Buffer.from(htmlAsset.source).toString('utf8');

          // Normalize stylesheet href to `/style.css`
          html = html.replace(
            /<link[^>]*rel="stylesheet"[^>]*>/gi,
            '<link rel="stylesheet" href="/style.css">',
          );

          // Remove Vite's external script tag and inline as a classic <script> block
          // so it works with both browsers and tools/dev/check-inline-js.mjs.
          html = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/gi, '');

          // Escape closing script tags inside string literals safely.
          // IMPORTANT: Use a callback in `.replace` so `$&` inside minified JS is NOT expanded to `</body>`!
          const safeCode = jsCode.replace(/<\/script/gi, '<\\/script');
          html = html.replace('</body>', () => `<script>\n${safeCode}\n</script>\n</body>`);

          htmlAsset.source = html;
          delete bundle[jsKey];
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), inlineBundleToTwoFiles()],
  base: '/',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8792',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: resolve(__dirname, '../dashboard/public'),
    emptyOutDir: false,
    cssCodeSplit: false,
    assetsInlineLimit: 65536,
    sourcemap: false,
    minify: 'esbuild',
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) return 'style.css';
          return 'assets/[name][extname]';
        },
      },
    },
  },
});
