// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// https://docs.astro.build/en/reference/configuration-reference/
export default defineConfig({
  site: 'https://earthviral.com',
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
    ssr: {
      // Native module + its renderer are used only by build-time OG image endpoints.
      external: ['@resvg/resvg-js'],
    },
    build: {
      // MapLibre (~1.1 MB) is a lazily imported chunk loaded only after the map island hydrates.
      chunkSizeWarningLimit: 1200,
    },
  },
});
