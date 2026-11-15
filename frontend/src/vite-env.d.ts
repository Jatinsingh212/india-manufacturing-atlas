/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional absolute API origin (default: same origin, relative `/api/...` URLs). */
  readonly VITE_API_BASE?: string;
  /** '1' registers the /_dev/components gallery in a production build (verification only). */
  readonly VITE_ATLAS_GALLERY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
