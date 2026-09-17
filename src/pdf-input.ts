import { createHash } from "node:crypto";

export type PdfInputFile = { fileId: string; title: string };
export const MAX_PDF_INPUT_FILES = 8;

export function pdfInputMode(value: string | undefined): "file" | "sandbox" {
  if (value === undefined || value === "" || value === "file") return "file";
  if (value === "sandbox") return "sandbox";
  throw new Error("ARKAGENT_PDF_INPUT_MODE 仅支持 file 或 sandbox");
}

export function pdfDocumentBlocks(files: PdfInputFile[]): Array<Record<string, unknown>> {
  if (!Array.isArray(files) || files.length > MAX_PDF_INPUT_FILES) throw new Error("PDF 引用数量无效");
  const ids = new Set<string>();
  return files.map(file => {
    if (!file || typeof file !== "object" || Object.keys(file).some(key => !["fileId", "title"].includes(key)) ||
      typeof file.fileId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(file.fileId) ||
      typeof file.title !== "string" || file.title.length > 512 || !/\.pdf$/i.test(file.title) || /[\x00-\x1f\x7f]/.test(file.title) || ids.has(file.fileId)) {
      throw new Error("PDF 文件引用无效");
    }
    ids.add(file.fileId);
    return { type: "document", title: file.title, source: { type: "file", file_id: file.fileId } };
  });
}

export function runInputFingerprint(text: string, files: PdfInputFile[] = []): string {
  pdfDocumentBlocks(files);
  return createHash("sha256").update(files.length ? JSON.stringify({ text, pdfFiles: files.map(({ fileId, title }) => ({ fileId, title })) }) : text).digest("hex");
}

export function eventInputFingerprint(content: unknown): string | undefined {
  if (!Array.isArray(content) || !content.length) return undefined;
  const texts: string[] = [];
  const files: PdfInputFile[] = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block?.type === "document" && block.source?.type === "file" && !block.context) files.push({ fileId: block.source.file_id, title: block.title });
    else return undefined;
  }
  try { return runInputFingerprint(texts.join("\n"), files); } catch { return undefined; }
}
