/**
 * @file src/utils/page-eligibility.ts
 * @description Shared metadata predicates for semantic indexing and retrieval.
 * Directory scans and direct page resolution call the same functions so a
 * candidate cannot bypass profile validity or surface privacy gates.
 */

import { pageEmbedSurfaces } from "./embed-eligibility.js";
import { isSlugSafe } from "../profile/identity.js";
import { validateEntityFields } from "../profile/field-contract.js";
import type { EntityTypeDef } from "../profile/types.js";
import type { RetrievalSurface } from "./retrieval-surface.js";

/** True when a reserved concept/query page passes the canonical legacy gate. */
export function isReservedPageEligible(
  metadata: Record<string, unknown>,
): metadata is Record<string, unknown> & { title: string } {
  return pageEmbedSurfaces({ meta: metadata, pageKind: "concept" }).embedded;
}

/** True when a typed page has a safe, self-consistent, schema-valid identity. */
function isTypedPageProfileValid(
  pagePart: string,
  metadata: Record<string, unknown>,
  definition: EntityTypeDef,
): boolean {
  if (!isSlugSafe(pagePart)) return false;
  const declaredSlug = typeof metadata.slug === "string" ? metadata.slug : undefined;
  if (declaredSlug !== undefined && declaredSlug !== pagePart) return false;
  return validateEntityFields(metadata, definition).length === 0;
}

/** True when a typed page may be sent to any semantic indexing backend. */
export function isTypedPageIndexEligible(
  pagePart: string,
  metadata: Record<string, unknown>,
  definition: EntityTypeDef,
): boolean {
  if (!isTypedPageProfileValid(pagePart, metadata, definition)) return false;
  return typedSurfaces(metadata, definition).embedded;
}

/** True when a typed page is valid and opted into a retrieval surface. */
export function isTypedPageSurfaceEligible(
  pagePart: string,
  metadata: Record<string, unknown>,
  definition: EntityTypeDef,
  surface: RetrievalSurface,
): boolean {
  if (!isTypedPageProfileValid(pagePart, metadata, definition)) return false;
  const surfaces = typedSurfaces(metadata, definition);
  return surface === "search" ? surfaces.inSearch : surfaces.inContext;
}

/** Evaluate the canonical retrieval truth table for a valid typed page. */
function typedSurfaces(metadata: Record<string, unknown>, definition: EntityTypeDef) {
  return pageEmbedSurfaces({
    meta: metadata,
    pageKind: "typed",
    retrieval: definition.retrieval,
    isProfileInvalid: false,
  });
}
