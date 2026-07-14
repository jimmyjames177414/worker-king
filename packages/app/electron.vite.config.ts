import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

/**
 * electron-vite config: three build targets.
 *  - main:    the Electron main process (window/tray/daemon supervision)
 *  - preload: two context-isolated preload scripts (overlay + chat)
 *  - renderer: two HTML entries (the avatar overlay and the chat window)
 */
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
      rollupOptions: {
        external: ['bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          chat: resolve(__dirname, 'src/preload/chat.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    server: {
      watch: {
        // Workspace package build outputs change during preLaunchTask builds.
        // Ignore them so Vite HMR doesn't storm-reload the renderer on every build.
        ignored: [/packages[\\/]\w+[\\/]dist[\\/]/, /packages[\\/]\w+[\\/]out[\\/]/],
      },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          chat: resolve(__dirname, 'src/renderer/chat/index.html'),
        },
      },
    },
  },
});
