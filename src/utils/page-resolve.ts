/**
 * @file src/utils/page-resolve.ts
 * @description Direct, confined resolution of a qualified page id. It provides
 * candidate-proportional reads for remote semantic retrieval while sharing the
 * exact metadata eligibility gates used by full directory scans.
 */

import path from "node:path";
import { readConfinedPage } from "./confined-read.js";
import { parseFrontmatter } from "./markdown.js";
import {
  isReservedPageEligible,
  isTypedPageIndexEligible,
  isTypedPageSurfaceEligible,
} from "./page-eligibility.js";
import { parseQualifiedPageId, type PageId } from "./page-id.js";
import { isInsideDir, safeRealpath } from "./path-confine.js";
import type { RetrievalSurface } from "./retrieval-surface.js";
import type { LoadedProfile } from "../profile/types.js";
import type { PageRecord } from "../pages/read.js";

const RESERVED_NAMESPACES = new Set(["concepts", "queries"]);

/** Parsed confined page plus identity and path anchors. */
export interface ResolvedPage {
  namespace: string;
  pagePart: string;
  metadata: Record<string, unknown>;
  record: PageRecord;
  capturedRealpath: string;
  expectedCanonicalDir: string;
}

/** Resolve one page id and read it only after realpath confinement succeeds. */
export async function resolveConfinedPage(
  root: string,
  pageId: PageId,
  namespaceDirs: Map<string, string>,
): Promise<ResolvedPage | null> {
  const parsed = parseQualifiedPageId(pageId);
  if (!parsed) return null;
  const relativeDirectory = namespaceDirs.get(parsed.namespace);
  if (!relativeDirectory) return null;
  const paths = await resolvePaths(root, relativeDirectory, parsed.pagePart);
  if (!paths) return null;
  const content = await readConfinedPage(paths.capturedRealpath, paths.expectedCanonicalDir);
  if (content === null) return null;
  return parseResolvedPage(parsed.namespace, parsed.pagePart, content, paths);
}

/** Resolve one candidate and apply index or surface eligibility to live metadata. */
export async function resolveEligiblePage(
  root: string,
  pageId: PageId,
  namespaceDirs: Map<string, string>,
  profile: LoadedProfile,
  surface?: RetrievalSurface,
): Promise<ResolvedPage | null> {
  const resolved = await resolveConfinedPage(root, pageId, namespaceDirs);
  if (!resolved) return null;
  if (RESERVED_NAMESPACES.has(resolved.namespace)) {
    return isReservedPageEligible(resolved.metadata) ? resolved : null;
  }
  const definition = profile.profile.entities[resolved.namespace];
  if (!definition) return null;
  const eligible = surface
    ? isTypedPageSurfaceEligible(resolved.pagePart, resolved.metadata, definition, surface)
    : isTypedPageIndexEligible(resolved.pagePart, resolved.metadata, definition);
  if (!eligible) return null;
  return {
    ...resolved,
    record: {
      ...resolved.record,
      title:
        typeof resolved.metadata.title === "string"
          ? resolved.metadata.title
          : resolved.pagePart,
    },
  };
}

/** Resolve the canonical root, directory, and candidate file without following escapes. */
async function resolvePaths(root: string, relativeDirectory: string, pagePart: string) {
  const canonicalRoot = await safeRealpath(root);
  if (!canonicalRoot) return null;
  const expectedCanonicalDir = path.join(canonicalRoot, relativeDirectory);
  const candidate = path.join(expectedCanonicalDir, `${pagePart}.md`);
  const capturedRealpath = await safeRealpath(candidate);
  if (!capturedRealpath || !isInsideDir(capturedRealpath, expectedCanonicalDir)) return null;
  return { capturedRealpath, expectedCanonicalDir };
}

/** Parse a confined document into the shared page record and retained metadata. */
function parseResolvedPage(
  namespace: string,
  pagePart: string,
  content: string,
  paths: { capturedRealpath: string; expectedCanonicalDir: string },
): ResolvedPage {
  const { meta, body } = parseFrontmatter(content);
  const record = {
    slug: pagePart,
    title: typeof meta.title === "string" ? meta.title : pagePart,
    summary: typeof meta.summary === "string" ? meta.summary : "",
    body: body.trim(),
  };
  return { namespace, pagePart, metadata: meta, record, ...paths };
}
