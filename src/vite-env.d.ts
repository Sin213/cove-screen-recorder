/// <reference types="vite/client" />

import type { CoveApi } from "../electron/types";

declare global {
  const __APP_VERSION__: string;
  interface Window {
    cove: CoveApi;
  }
}

export {};
