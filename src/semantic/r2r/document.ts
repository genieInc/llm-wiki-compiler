/**
 * @file src/semantic/r2r/document.ts
 * @description Deterministic projection of one eligible llmwiki page into an
 * R2R document. Existing llmwiki body chunks receive bounded title/summary
 * context; a page-level unit is used only when a page has no body chunks. The
 * local manifest stores hashes and identities only, never page text or vectors.
 */

import { createHash } from "node:crypto";
import type { SemanticSourcePage } from "../source-pages.js";
import type { R2RConfig } from "./config.js";
import type { R2RManifestPage, R2RManifestUnit } from "./manifest-types.js";

/** Bound repeated page context so a very long summary cannot inflate every chunk. */
const PAGE_CONTEXT_MAX_CHARS = 2_000;
const REMOTE_TEXT_SEPARATOR = "\n\n---\n\n";

/** R2R ingestion payload and the corresponding text-free manifest entry. */
export interface R2RProjectedDocument {
  documentId: string;
  chunks: string[];
  metadata: Record<string, string | number>;
  manifestPage: R2RManifestPage;
}

/** Project one collected page into deterministic R2R chunks and identities. */
export function projectPageForR2R(
  page: SemanticSourcePage,
  config: R2RConfig,
  updatedAt = new Date().toISOString(),
): R2RProjectedDocument {
  const pageContext = page.embeddingText.slice(0, PAGE_CONTEXT_MAX_CHARS);
  const pageTextHash = remoteTextHash(page.embeddingText);
  const chunkTextHashes = page.chunkTexts.map(remoteTextHash);
  const bodyUnits = page.chunkTexts.map((text, index) =>
    toChunkUnit(pageContext, text, index, chunkTextHashes[index]),
  );
  const remoteUnits = bodyUnits.length > 0 ? bodyUnits : [toPageUnit(pageContext)];
  const units = remoteUnits.map((unit) => unit.manifest);
  const chunks = remoteUnits.map((unit) => unit.text);
  const contentHash = contentFingerprint(pageTextHash, chunkTextHashes);
  const documentId = deterministicUuid(
    `${config.collectionId}\0${config.namespace}\0${page.pageId}\0${contentHash}`,
  );
  return {
    documentId,
    chunks,
    metadata: buildMetadata(page, contentHash, config.namespace),
    manifestPage: {
      pageId: page.pageId,
      documentId,
      contentHash,
      pageTextHash,
      units,
      updatedAt,
    },
  };
}

/** Page-level R2R unit used when a title/summary is more relevant than body text. */
function toPageUnit(text: string): { text: string; manifest: R2RManifestUnit } {
  return { text, manifest: { kind: "page", remoteTextHash: remoteTextHash(text) } };
}

/** Body R2R unit with enough page context for useful standalone retrieval. */
function toChunkUnit(
  pageContext: string,
  body: string,
  chunkIndex: number,
  contentHash: string,
): { text: string; manifest: R2RManifestUnit } {
  const text = `${pageContext}${REMOTE_TEXT_SEPARATOR}${body}`;
  return {
    text,
    manifest: { kind: "chunk", chunkIndex, contentHash, remoteTextHash: remoteTextHash(text) },
  };
}

/** Non-secret document metadata for R2R diagnostics and future migrations. */
function buildMetadata(
  page: SemanticSourcePage,
  contentHash: string,
  namespace: string,
): Record<string, string | number> {
  return {
    title: page.title,
    page_id: page.pageId,
    llmwiki_namespace: namespace,
    llmwiki_content_hash: contentHash,
    llmwiki_schema_version: 1,
  };
}

/** Hash all retrieval-relevant live hashes into one page reconciliation key. */
function contentFingerprint(pageTextHash: string, chunkHashes: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([pageTextHash, ...chunkHashes]), "utf8")
    .digest("hex");
}

/** Hash exact remote text so search hits can be mapped without trusting metadata. */
export function remoteTextHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Derive an RFC-4122-shaped UUID from stable content without an SDK dependency. */
function deterministicUuid(seed: string): string {
  const bytes = createHash("sha256").update(seed, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
