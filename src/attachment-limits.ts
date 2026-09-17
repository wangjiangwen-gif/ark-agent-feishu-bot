export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_TURN_ATTACHMENT_BYTES = 200 * 1024 * 1024;

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Number((bytes / 1024 / 1024).toFixed(2))} MiB` : `${bytes} 字节`;
}

// 不包含文件名、下载URL或SDK错误正文，可安全用于用户提示。
export function attachmentSizeError(size: number, singleLimit: number, remaining: number, lowerBound = false): Error {
  return new Error(`文件大小${lowerBound ? "至少" : ""} ${size} 字节，超过下载限制 ${Math.min(singleLimit, remaining)} 字节（单文件上限 ${formatBytes(singleLimit)}，本轮剩余 ${formatBytes(remaining)}）；请缩小文件或分批处理`);
}

export function isAttachmentSizeMessage(message: string): boolean {
  return /^文件大小(?:至少)? \d+ 字节，超过下载限制 \d+ 字节（单文件上限 [\d.]+ (?:MiB|字节)，本轮剩余 [\d.]+ (?:MiB|字节)）；请缩小文件或分批处理$/.test(message);
}
