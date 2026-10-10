// สำรองฐานข้อมูลทั้งหมดของ MCP เป็นไฟล์ JSON ในโฟลเดอร์ backups/
// วิธีใช้: npm run backup
import { readFile, mkdir, writeFile } from "node:fs/promises";

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
const res = await fetch(`${baseUrl}/export`, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) {
  console.error(`สำรองข้อมูลไม่สำเร็จ (${res.status})`);
  process.exit(1);
}

const data = await res.json();
const dir = new URL("../backups/", import.meta.url);
await mkdir(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = new URL(`linkedin-mcp-${stamp}.json`, dir);
await writeFile(file, JSON.stringify(data, null, 2), "utf8");

const counts = Object.entries(data.tables).map(([name, rows]) => `${name}=${rows.length}`).join(", ");
console.log(`สำรองแล้ว: ${file.pathname}`);
console.log(counts);
