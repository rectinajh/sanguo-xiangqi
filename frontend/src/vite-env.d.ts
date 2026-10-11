/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_GAMETABLE?: string;
  readonly VITE_COVENANT?: string;
  readonly VITE_AGENTREGISTRY?: string;
  readonly VITE_STUBVERIFIER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
