import type { APIRoute, GetStaticPaths } from 'astro';
import { getClusters } from '../../lib/data.ts';
import { defaultCard, storyCard } from '../../lib/ogImage.ts';
import type { ViralClusterStaticRecord } from '../../lib/types.ts';

/** /og/default.png and one card per story: /og/[cluster-id].png */
export const getStaticPaths = (async () => {
  const clusters = await getClusters();
  return [
    { params: { id: 'default' }, props: { cluster: null } },
    ...clusters.map((cluster) => ({ params: { id: cluster.id }, props: { cluster } })),
  ];
}) satisfies GetStaticPaths;

export const GET: APIRoute<{ cluster: ViralClusterStaticRecord | null }> = async ({ props }) => {
  const c = props.cluster;
  const png = c
    ? await storyCard({
        headline: c.headline,
        countryName: c.countryName,
        categoryName: c.categoryName,
        viralScore: c.viralScore,
        tier: c.intensityTier,
      })
    : await defaultCard();
  return new Response(png, { headers: { 'Content-Type': 'image/png' } });
};
