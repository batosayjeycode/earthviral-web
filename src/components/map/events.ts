/**
 * Window events connecting the map island and the Country Intelligence Drawer island.
 * Islands hydrate independently, so they share state through events rather than props.
 *
 *   map  ── earthviral:country-select ──▶ drawer   (open with this country)
 *   map  ── earthviral:country-deselect ▶ drawer   (user cleared the map selection)
 *   drawer ─ earthviral:drawer-close ───▶ map      (user closed the drawer)
 */
export const COUNTRY_SELECT_EVENT = 'earthviral:country-select';
export const COUNTRY_DESELECT_EVENT = 'earthviral:country-deselect';
export const DRAWER_CLOSE_EVENT = 'earthviral:drawer-close';

export interface CountrySelectDetail {
  code: string;
  slug: string;
  name: string;
}

/** Drawer is a right-hand side panel at and above this breakpoint, a bottom sheet below it. */
export const DESKTOP_QUERY = '(min-width: 1024px)';
export const DRAWER_WIDTH_PX = 420;
