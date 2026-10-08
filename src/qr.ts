import { encode } from "uqr";

export function shortUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/m/${code}`;
}

/**
 * Print-ready QR code: error correction M, 4-module quiet zone, pure black on white.
 * One <path> in module units so it scales to any size without blurring.
 */
export function qrSvg(text: string): string {
  const qr = encode(text, { ecc: "M", border: 4 });
  let d = "";
  qr.data.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
    }
  });
  const n = qr.size;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * 10}" height="${n * 10}" shape-rendering="crispEdges">` +
    `<rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`
  );
}
