/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_GAMETABLE?: string;
  readonly VITE_COVENANT?: string;
  readonly VITE_AGENTREGISTRY?: string;
  readonly VITE_STUBVERIFIER?: string;
  /** 领币入口。默认 https://faucet.monad.xyz（官方水龙头，我们不自建） */
  readonly VITE_FAUCET_URL?: string;
  readonly VITE_INDEXER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
