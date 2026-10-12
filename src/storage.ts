export function documentKey(code: string): string {
  return `manuals/${code}/${crypto.randomUUID()}.pdf`;
}

/** Stores a new PDF object under a fresh key. Never overwrites an existing object. */
export async function putDocument(
  bucket: R2Bucket,
  code: string,
  body: ReadableStream | ArrayBuffer | Uint8Array | Blob,
): Promise<{ key: string; size: number }> {
  const key = documentKey(code);
  const obj = await bucket.put(key, body, {
    httpMetadata: { contentType: "application/pdf" },
  });
  return { key, size: obj.size };
}

export async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  if (keys.length > 0) await bucket.delete(keys);
}
