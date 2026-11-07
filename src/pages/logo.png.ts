import type { APIRoute } from 'astro';
import { logoPng } from '../lib/ogImage.ts';

export const GET: APIRoute = async () =>
  new Response(await logoPng(), { headers: { 'Content-Type': 'image/png' } });
