/**
 * Build-time social cards (plan §9.3: `/og/[cluster-id].png`), rendered with satori → resvg.
 * Fonts are embedded from Fontsource (Space Grotesk, Plus Jakarta Sans — both SIL OFL-1.1,
 * which permits embedding). Satori needs WOFF/TTF, so the static (non-variable) packages are used.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import type { IntensityTier } from './taxonomy.ts';

const require = createRequire(import.meta.url);
const fontFile = (pkg: string, file: string) => readFile(require.resolve(`${pkg}/files/${file}`));

let fontsPromise: Promise<Parameters<typeof satori>[1]['fonts']> | undefined;
function fonts() {
  fontsPromise ??= Promise.all([
    fontFile('@fontsource/space-grotesk', 'space-grotesk-latin-700-normal.woff'),
    fontFile('@fontsource/plus-jakarta-sans', 'plus-jakarta-sans-latin-400-normal.woff'),
    fontFile('@fontsource/plus-jakarta-sans', 'plus-jakarta-sans-latin-600-normal.woff'),
  ]).then(([display, body, bodySemi]) => [
    { name: 'Space Grotesk', data: display, weight: 700 as const, style: 'normal' as const },
    { name: 'Plus Jakarta Sans', data: body, weight: 400 as const, style: 'normal' as const },
    { name: 'Plus Jakarta Sans', data: bodySemi, weight: 600 as const, style: 'normal' as const },
  ]);
  return fontsPromise;
}

// Minimal hyperscript for satori's React-element-shaped input (no React needed).
type Node = { type: string; props: Record<string, unknown> };
const h = (
  type: string,
  style: Record<string, unknown>,
  ...children: Array<Node | string>
): Node => ({
  type,
  props: {
    style: { display: 'flex', ...style },
    children: children.length === 1 ? children[0] : children,
  },
});

const TIER_COLOR: Record<IntensityTier, { fg: string; bg: string; border: string }> = {
  quiet: { fg: '#94a3b8', bg: 'rgba(30,41,59,0.6)', border: '#1e293b' },
  active: { fg: '#06b6d4', bg: 'rgba(6,182,212,0.12)', border: 'rgba(6,182,212,0.5)' },
  high: { fg: '#00f0ff', bg: 'rgba(0,240,255,0.12)', border: 'rgba(0,240,255,0.55)' },
  surge: { fg: '#f5f3ff', bg: 'rgba(139,92,246,0.35)', border: 'rgba(168,85,247,0.8)' },
};

/** PNG bytes backed by a plain ArrayBuffer (accepted as a `Response` body under TS 6 DOM types). */
type Png = Uint8Array<ArrayBuffer>;

const WIDTH = 1200;
const HEIGHT = 630;
const PAD_X = 72;
const PAD_Y = 64;
/** Rows get an explicit width: satori sizes flex children to their text otherwise and overflows. */
const CONTENT_W = WIDTH - 2 * PAD_X;

function wordmark(): Node {
  return h(
    'div',
    { alignItems: 'center', gap: 14, fontFamily: 'Space Grotesk', fontSize: 34, color: '#ffffff' },
    h('div', { width: 30, height: 30, borderRadius: 999, border: '4px solid #00f0ff' }),
    h('div', {}, h('span', {}, 'Earth'), h('span', { color: '#00f0ff' }, 'Viral')),
  );
}

async function render(tree: Node): Promise<Png> {
  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: WIDTH,
    height: HEIGHT,
    fonts: await fonts(),
  });
  // Satori already converted text to paths; skipping the system-font scan cuts ~1.5 s per card.
  return new Uint8Array(
    new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH }, font: { loadSystemFonts: false } })
      .render()
      .asPng(),
  );
}

const frame = (...children: Node[]) =>
  h(
    'div',
    {
      // Satori sizes the root as content-box: width/height exclude padding, so subtract it
      // (a 1200×630 box plus padding overflowed the canvas and clipped the bottom row).
      width: CONTENT_W,
      height: HEIGHT - 2 * PAD_Y,
      flexDirection: 'column',
      justifyContent: 'space-between',
      paddingTop: PAD_Y,
      paddingBottom: PAD_Y,
      paddingLeft: PAD_X,
      paddingRight: PAD_X,
      backgroundColor: '#050811',
      backgroundImage: 'radial-gradient(circle at 85% 20%, #10305a 0%, #050811 55%)',
      color: '#e2e8f0',
      fontFamily: 'Plus Jakarta Sans',
    },
    ...children,
  );

export async function storyCard(opts: {
  headline: string;
  countryName: string;
  categoryName: string;
  viralScore: number;
  tier: IntensityTier;
}): Promise<Png> {
  const tier = TIER_COLOR[opts.tier];
  const size = opts.headline.length > 90 ? 50 : opts.headline.length > 60 ? 58 : 66;
  return render(
    frame(
      h(
        'div',
        { width: CONTENT_W, justifyContent: 'space-between', alignItems: 'center' },
        wordmark(),
        h(
          'div',
          {
            alignItems: 'center',
            gap: 10,
            padding: '10px 22px',
            borderRadius: 999,
            border: `2px solid ${tier.border}`,
            backgroundColor: tier.bg,
            color: tier.fg,
            fontFamily: 'Space Grotesk',
            fontSize: 34,
          },
          `${opts.viralScore}/100`,
        ),
      ),
      h(
        'div',
        { width: CONTENT_W, flexDirection: 'column', gap: 24 },
        h(
          'div',
          {
            fontSize: 26,
            fontWeight: 600,
            color: '#00f0ff',
            letterSpacing: 2,
            textTransform: 'uppercase',
          },
          `Viral in ${opts.countryName}`,
        ),
        h(
          'div',
          {
            width: CONTENT_W,
            fontFamily: 'Space Grotesk',
            fontSize: size,
            lineHeight: 1.12,
            color: '#ffffff',
          },
          opts.headline,
        ),
      ),
      h(
        'div',
        {
          width: CONTENT_W,
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 24,
          color: '#94a3b8',
        },
        h(
          'div',
          { padding: '6px 16px', borderRadius: 999, border: '2px solid #1e293b' },
          opts.categoryName,
        ),
        h('div', {}, 'earthviral.com'),
      ),
    ),
  );
}

export async function defaultCard(): Promise<Png> {
  return render(
    frame(
      wordmark(),
      h(
        'div',
        { width: CONTENT_W, flexDirection: 'column', gap: 20 },
        h(
          'div',
          { fontFamily: 'Space Grotesk', fontSize: 72, lineHeight: 1.08, color: '#ffffff' },
          'What the world is talking about right now',
        ),
        h(
          'div',
          { fontSize: 30, color: '#94a3b8' },
          'Viral news intensity by country, refreshed every 3 hours.',
        ),
      ),
      h('div', { fontSize: 24, color: '#64748b' }, 'earthviral.com'),
    ),
  );
}

/** 512×512 raster logo for structured data (Organization.logo requires a bitmap). */
export async function logoPng(): Promise<Png> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="512" height="512"><rect width="32" height="32" rx="8" fill="#050811"/><g fill="none" stroke="#00F0FF" stroke-width="1.8"><circle cx="16" cy="16" r="10"/><ellipse cx="16" cy="16" rx="4.5" ry="10"/><path d="M6 16h20"/></g><circle cx="22" cy="10" r="2.4" fill="#A855F7"/></svg>`;
  return new Uint8Array(
    new Resvg(svg, { fitTo: { mode: 'width', value: 512 }, font: { loadSystemFonts: false } })
      .render()
      .asPng(),
  );
}
