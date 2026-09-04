/**
 * @file src/semantic/r2r/manifest-types.ts
 * @description Text-free R2R reconciliation state contracts. Separating data
 * shapes from filesystem parsing lets projection, search, and sync share the
 * schema without depending on the manifest persistence implementation.
 */

import type { PageId } from "../../utils/page-id.js";

/** Remote retrieval unit identity, without retaining its source text. */
export type R2RManifestUnit =
  | { kind: "page"; remoteTextHash: string }
  | { kind: "chunk"; chunkIndex: number; contentHash: string; remoteTextHash: string };

/** One live page's active R2R document and freshness keys. */
export interface R2RManifestPage {
  pageId: PageId;
  documentId: string;
  contentHash: string;
  pageTextHash: string;
  units: R2RManifestUnit[];
  updatedAt: string;
}

/** Non-secret identity that determines which R2R deployment owns the manifest. */
export interface R2RManifestIdentity {
  baseUrl: string;
  collectionId: string;
  namespace: string;
  projectName?: string;
}

/** Complete local state for one R2R semantic index. */
export interface R2RManifest {
  version: 1;
  identity: R2RManifestIdentity;
  pages: R2RManifestPage[];
  orphanDocumentIds: string[];
  lastFullSyncAt?: string;
}

/** Discriminated read result: absence is bootstrappable; corruption is not. */
export type R2RManifestRead =
  | { kind: "absent" }
  | { kind: "unavailable" }
  | { kind: "ok"; manifest: R2RManifest };
