import type { APIRoute, GetStaticPaths } from 'astro';
import { getDigestDays } from '../../../lib/data.ts';
import { formatDayShort, type DigestDay } from '../../../lib/digest.ts';
import { digestCard } from '../../../lib/ogImage.ts';

/** /og/digest/[yyyy-mm-dd].png — social card for each daily digest page. */
export const getStaticPaths = (async () =>
  (await getDigestDays()).map((digest) => ({
    params: { day: digest.day },
    props: { digest },
  }))) satisfies GetStaticPaths;

export const GET: APIRoute<{ digest: DigestDay }> = async ({ props: { digest } }) =>
  new Response(
    await digestCard({
      dateLabel: formatDayShort(digest.day),
      headlines: digest.stories.slice(0, 3).map((c) => c.headline),
      storyCount: digest.stories.length,
      countryCount: digest.countryCount,
    }),
    { headers: { 'Content-Type': 'image/png' } },
  );
