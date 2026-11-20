import { hostPreviewMimeTypeFromExtension } from "./filePreview.ts";

export const SHOW_FILE_TOOL_NAME = "show_file";
export const SHOW_FILE_MAX_PATH_LENGTH = 4096;

export interface ShowFileReference {
  readonly path: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly line?: number;
}

const TEXT_MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  css: "text/css",
  csv: "text/csv",
  go: "text/x-go",
  js: "text/javascript",
  jsx: "text/jsx",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  py: "text/x-python",
  rs: "text/rust",
  sh: "text/x-shellscript",
  toml: "application/toml",
  ts: "text/typescript",
  tsx: "text/tsx",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  xml: "text/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
};

const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function mediaTypeForPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  const extension = base.slice(dot).toLowerCase();
  return (
    hostPreviewMimeTypeFromExtension(extension) ??
    TEXT_MEDIA_TYPE_BY_EXTENSION[extension.slice(1)] ??
    "application/octet-stream"
  );
}

export function readShowFileReference(value: unknown): ShowFileReference | undefined {
  if (!isRecord(value) || !isRecord(value.showFile)) return undefined;
  const source = value.showFile;
  const { path, byteSize, mediaType, line } = source;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.length > SHOW_FILE_MAX_PATH_LENGTH ||
    path.includes("\0") ||
    /[\r\n]/.test(path) ||
    typeof byteSize !== "number" ||
    !Number.isSafeInteger(byteSize) ||
    byteSize < 0 ||
    typeof mediaType !== "string" ||
    !MEDIA_TYPE.test(mediaType)
  ) {
    return undefined;
  }
  const reference: ShowFileReference = { path, byteSize, mediaType };
  return typeof line === "number" && Number.isSafeInteger(line) && line >= 1 && line <= 1_000_000
    ? { ...reference, line }
    : reference;
}
