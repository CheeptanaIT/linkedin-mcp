// ส่งไฟล์ export ของ LinkedIn จากเครื่องคุณไปยัง Worker โดยตรง (ไม่ผ่าน Claude เพื่อประหยัด context)
// วิธีใช้: npm run import -- <connections|invitations|profile> "<path to csv>"
import { readFile } from "node:fs/promises";

const KINDS = ["connections", "invitations", "profile"];
const [kind, file] = process.argv.slice(2);
if (!KINDS.includes(kind) || !file) {
  console.error(`usage: npm run import -- <${KINDS.join("|")}> "<path to csv>"`);
  process.exit(1);
}

// อ่าน MCP_TOKEN จาก .env (ไม่พิมพ์ค่า token ออกมา)
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
const body = await readFile(file);

const res = await fetch(`${baseUrl}/import/${kind}`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "text/csv",
  },
  body,
});

const data = await res.json().catch(() => null);
console.log(JSON.stringify(data ?? { status: res.status }, null, 2));
process.exit(res.ok && data?.ok ? 0 : 1);
