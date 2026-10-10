// ชนิดข้อมูลขั้นต่ำของ D1 (ไม่ต้องพึ่งแพ็กเกจ workers-types)
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1Database {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
}

export interface Env {
  DB: D1Database;
  MCP_TOKEN: string;
  OWNER_PASSWORD?: string;
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  LINKEDIN_REDIRECT_URI?: string;
  LINKEDIN_API_VERSION?: string;
}

// เขียนทีละชุดเพื่อไม่ให้ batch ใหญ่เกินขีดจำกัดของ D1
export async function runInChunks(db: D1Database, statements: D1Statement[], size = 100) {
  for (let i = 0; i < statements.length; i += size) {
    await db.batch(statements.slice(i, i + size));
  }
}

// บันทึกทุกการเรียก tool ลง audit_log (ข้อ 1.4)
export async function audit(
  db: D1Database,
  tool: string,
  args: unknown,
  result: unknown,
  ok: boolean,
) {
  await db
    .prepare("INSERT INTO audit_log (tool, args, result, ok) VALUES (?, ?, ?, ?)")
    .bind(tool, JSON.stringify(args ?? null), JSON.stringify(result ?? null).slice(0, 2000), ok ? 1 : 0)
    .run();
}

// วันที่ปัจจุบันตามเวลาไทย (UTC+7) รูปแบบ YYYY-MM-DD
export function todayBangkok(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
