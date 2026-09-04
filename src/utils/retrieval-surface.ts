/**
 * @file src/utils/retrieval-surface.ts
 * @description Shared page-level retrieval surface gate. Local embeddings and
 * remote semantic backends must make the same includeInSearch/includeInContext
 * decision after resolving a qualified page ID against the active profile.
 */

import type { LoadedProfile } from "../profile/types.js";
import { parseQualifiedPageId, type PageId } from "./page-id.js";

/** Retrieval surfaces independently controlled by typed profile definitions. */
export type RetrievalSurface = "search" | "context";

/** Whether a live page is allowed to contribute to the requested surface. */
export function pagePassesRetrievalSurface(
  pageId: PageId,
  surface: RetrievalSurface,
  profile?: LoadedProfile,
): boolean {
  const parsed = parseQualifiedPageId(pageId);
  if (!parsed || !profile) return true;
  const definition = profile.profile.entities[parsed.namespace]?.retrieval;
  if (!definition) return true;
  const flag = surface === "search" ? definition.includeInSearch : definition.includeInContext;
  return flag !== false;
}
