// แนบรูปกับร่างโพสต์ (รองรับ png, jpg, gif ขนาดไม่เกิน 1 MB)
// วิธีใช้: npm run attach-image -- <post_id> "<path to image>"
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif" };
const [postId, file] = process.argv.slice(2);
if (!postId || !file) {
  console.error('usage: npm run attach-image -- <post_id> "<path to image>"');
  process.exit(1);
}
const mime = TYPES[extname(file).toLowerCase()];
if (!mime) {
  console.error("รองรับเฉพาะ .png .jpg .jpeg .gif");
  process.exit(1);
}

async function readToken() {
  if (process.env.MCP_TOKEN) return process.env.MCP_TOKEN;
  const text = await readFile(new URL("../.env", import.meta.url), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("MCP_TOKEN="));
  return line?.slice("MCP_TOKEN=".length).trim();
}

const token = await readToken();
if (!token) {
  console.error("ไม่พบ MCP_TOKEN ใน .env");
  process.exit(1);
}

const baseUrl = process.env.LINKEDIN_MCP_URL ?? "https://linkedin-mcp.cheeptana-boy.workers.dev";
const res = await fetch(`${baseUrl}/media/${postId}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": mime },
  body: await readFile(file),
});
const data = await res.json().catch(() => null);
console.log(JSON.stringify(data ?? { status: res.status }, null, 2));
process.exit(res.ok && data?.ok ? 0 : 1);
