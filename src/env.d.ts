interface ImportMetaEnv {
  readonly PUBLIC_ADSENSE_CLIENT?: string;
  readonly PUBLIC_ADSENSE_SLOT_STORY?: string;
  readonly PUBLIC_ADSENSE_SLOT_HUB?: string;
  readonly PUBLIC_CONTACT_EMAIL?: string;
  readonly INDEXNOW_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
