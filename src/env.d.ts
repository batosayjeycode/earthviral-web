interface ImportMetaEnv {
  readonly PUBLIC_ADSENSE_CLIENT?: string;
  readonly PUBLIC_ADSENSE_SLOT_STORY?: string;
  readonly PUBLIC_ADSENSE_SLOT_HUB?: string;
  readonly PUBLIC_CONTACT_EMAIL?: string;
  readonly INDEXNOW_KEY?: string;
  /** "staging" builds the protected staging site; unset = production. */
  readonly SITE_ENV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
