import type { APIRoute } from 'astro';
import { coreEntries } from '../lib/routes.ts';
import { urlset, xmlResponse } from '../lib/xml.ts';

/** Plan §9.4 (2): homepage, regional, category, country and topic hubs. */
export const GET: APIRoute = async () => xmlResponse(urlset(await coreEntries()));
