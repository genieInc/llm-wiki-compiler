/**
 * @file src/semantic/r2r/types.ts
 * @description Private runtime state owned by the R2R adapter. Keeping these
 * types below the adapter prevents the root semantic contract from importing
 * R2R configuration, manifests, response shapes, or caches.
 */

import type { R2RSearchResult } from "./client.js";
import type { R2RConfig } from "./config.js";
import type { R2RManifest } from "./manifest-types.js";

/** Request-local remote result cache shared by chunk and page fallback passes. */
export interface R2RSearchCache {
  query?: string;
  limit?: number;
  results?: Promise<R2RSearchResult[]>;
}

/** Loaded R2R state hidden behind a backend-neutral reader. */
export interface R2RSemanticIndex {
  config: R2RConfig;
  manifest: R2RManifest;
  cache: R2RSearchCache;
}
