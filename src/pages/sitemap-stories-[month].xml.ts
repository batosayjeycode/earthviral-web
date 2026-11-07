import type { APIRoute, GetStaticPaths } from 'astro';
import { storiesByMonth } from '../lib/routes.ts';
import type { ViralClusterStaticRecord } from '../lib/types.ts';
import { urlset, xmlResponse } from '../lib/xml.ts';

/** Plan §9.4 (4): monthly partitions of every story page (keeps each file far below 50,000 URLs). */
export const getStaticPaths = (async () =>
  [...(await storiesByMonth()).entries()].map(([month, stories]) => ({
    params: { month },
    props: { stories },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ stories: ViralClusterStaticRecord[] }> = ({ props }) =>
  xmlResponse(
    urlset(
      props.stories.map((c) => ({
        path: c.canonicalPath,
        lastmod: c.lastUpdatedBatchAt,
        changefreq: 'hourly',
        priority: 0.8,
      })),
    ),
  );
