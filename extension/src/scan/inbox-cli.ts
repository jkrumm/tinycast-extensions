// The read-only inbox queries behind `scan-cli --documents`, `--doc-thumbs`
// and `--release`: no scanner is touched. The fs is injected (defaults to the
// real one) so tests run against a temp dir.

import {
  DocThumb,
  DocThumbPorts,
  makeDocThumbs,
  nodeDocThumbPorts,
} from "./doc-thumbs";
import { nodeDocsFs } from "./docs-fs";
import {
  DocsFs,
  DocumentsResult,
  listDocuments,
  releaseReview,
  ReleaseResult,
} from "./documents";

export interface InboxQuery {
  inbox: string;
  brainDir?: string;
  dokumenteDir?: string;
}

export const documentsResult = (
  query: InboxQuery,
  fs: DocsFs = nodeDocsFs,
): DocumentsResult => listDocuments(fs, query);

// Thumbnails of the documents that are PDFs or images: waiting, review and the
// filed ones whose file exists. Each is a cache file path (Tinycast shows a
// file path as an image).
export async function docThumbsResult(
  query: InboxQuery & { stateDir: string },
  fs: DocsFs = nodeDocsFs,
  ports: DocThumbPorts = nodeDocThumbPorts,
  nowMs = Date.now(),
): Promise<{ thumbs: DocThumb[] }> {
  const docs = listDocuments(fs, query);
  if (!docs.ok) return { thumbs: [] };
  const paths = [
    ...docs.review.map((d) => d.path),
    ...docs.waiting.map((d) => d.path),
    ...docs.filed.filter((d) => d.exists).map((d) => d.path),
  ];
  return {
    thumbs: await makeDocThumbs(ports, {
      stateDir: query.stateDir,
      paths,
      nowMs,
    }),
  };
}

export const releaseResult = (
  opts: { inbox: string; name: string; as: string },
  fs: DocsFs = nodeDocsFs,
): ReleaseResult => {
  try {
    return releaseReview(fs, opts);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
