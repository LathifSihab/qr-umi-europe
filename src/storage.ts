import type { Lang } from "./config";

export function manualKey(code: string, lang: Lang): string {
  return `manuals/${code}/${lang}/${crypto.randomUUID()}.pdf`;
}

/** Stores a new PDF object under a fresh key. Never overwrites an existing object. */
export async function putManual(
  bucket: R2Bucket,
  code: string,
  lang: Lang,
  body: ReadableStream | ArrayBuffer | Uint8Array | Blob,
): Promise<{ key: string; size: number }> {
  const key = manualKey(code, lang);
  const obj = await bucket.put(key, body, {
    httpMetadata: { contentType: "application/pdf" },
  });
  return { key, size: obj.size };
}

export async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  if (keys.length > 0) await bucket.delete(keys);
}
