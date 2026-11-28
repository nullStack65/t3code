// Packs qa/report/index.html into one self-contained HTML file with downscaled thumbnails, the form
// docs.closura.ai publishes (a single file under its size limit):
//   node qa/pack-report.ts [out.html]
// @effect-diagnostics nodeBuiltinImport:off - a plain Node script, outside the server's Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { chromium } from "playwright";

const REPORT = NodePath.join(import.meta.dirname, "report");
const out = process.argv[2] ?? NodePath.join(REPORT, "standalone.html");
const MAX_BYTES = 12 * 1024 * 1024;

const html = NodeFS.readFileSync(NodePath.join(REPORT, "index.html"), "utf8");
const paths = [
  ...new Set([...html.matchAll(/src="(shots\/[^"]+\.png)"/g)].map((match) => match[1]!)),
];
const unescape = (value: string) => value.replace(/&amp;/g, "&");

const browser = await chromium.launch({
  ...(process.env.T3_QA_CHROMIUM ? { executablePath: process.env.T3_QA_CHROMIUM } : {}),
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
const thumbs = new Map<string, string>();
for (const path of paths) {
  const png = NodeFS.readFileSync(NodePath.join(REPORT, unescape(path))).toString("base64");
  const url = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const width = Math.min(360, image.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round((image.naturalHeight * width) / image.naturalWidth);
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/webp", 0.6);
  }, png);
  thumbs.set(path, url);
}
await browser.close();

const packed = html
  .replace(/<a href="shots\/[^"]+">/g, "<a>")
  .replace(/src="(shots\/[^"]+\.png)"/g, (_whole, path: string) => `src="${thumbs.get(path)}"`);
NodeFS.writeFileSync(out, packed);
const size = Buffer.byteLength(packed);
console.log(`${out}: ${(size / 1024 / 1024).toFixed(1)} MiB, ${paths.length} thumbnails`);
if (size > MAX_BYTES) {
  console.error("Report is over the size budget; drop screenshots or lower the thumbnail quality.");
  process.exit(1);
}
