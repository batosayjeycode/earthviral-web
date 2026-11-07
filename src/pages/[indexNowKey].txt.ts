import type { APIRoute, GetStaticPaths } from 'astro';
import { SITE } from '../lib/site.ts';

/** IndexNow key-verification file (plan §9.4 item 5) — only emitted when INDEXNOW_KEY is set. */
export const getStaticPaths = (() =>
  SITE.indexNowKey && /^[a-zA-Z0-9-]{8,128}$/.test(SITE.indexNowKey)
    ? [{ params: { indexNowKey: SITE.indexNowKey } }]
    : []) satisfies GetStaticPaths;

export const GET: APIRoute = () =>
  new Response(SITE.indexNowKey ?? '', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
