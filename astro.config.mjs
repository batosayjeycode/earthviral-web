// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ENVIRONMENTS, resolveSiteEnvironment } from './src/lib/environment.ts';

// SITE_ENV=staging → https://staging.earthviral.com (see src/lib/environment.ts).
const environment = resolveSiteEnvironment(process.env.SITE_ENV);

/**
 * Staging only: send `X-Robots-Tag: noindex` for every response (not just HTML pages), on
 * top of the per-page robots meta. Production's public/_headers is left untouched.
 * @returns {import('astro').AstroIntegration}
 */
const stagingHeaders = () => ({
  name: 'earthviral:staging-headers',
  hooks: {
    'astro:build:done': async ({ dir }) => {
      if (environment !== 'staging') return;
      await appendFile(
        fileURLToPath(new URL('_headers', dir)),
        '\n# Added by astro.config.mjs for SITE_ENV=staging: never index the staging site.\n/*\n  X-Robots-Tag: noindex, nofollow\n',
      );
    },
  },
});

// https://docs.astro.build/en/reference/configuration-reference/
export default defineConfig({
  site: ENVIRONMENTS[environment].url,
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
  },
  integrations: [react(), stagingHeaders()],
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
