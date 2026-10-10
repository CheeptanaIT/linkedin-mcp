import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Env, audit, todayBangkok } from "./db.js";
import { parseConnections } from "./csv.js";
import { importInvitations, importProfile, listInvitations, parseInvitations, parseProfile } from "./imports.js";
import { findWarmIntro } from "./intro.js";
import { cancelScheduled, listScheduled, runScheduledPosts } from "./schedule.js";
import {
  authorizationServerMetadata,
  authorizeGet,
  authorizePost,
  protectedResourceMetadata,
  registerClient,
  tokenEndpoint,
  verifyAccessToken,
} from "./oauth.js";
import {
  buildAuthUrl,
  confirmPublish,
  createDraftPost,
  handleOAuthCallback,
  linkedInStatus,
  listPosts,
  requestPublish,
  attachMedia,
  attachImageBase64,
  attachImageFromUrl,
} from "./linkedin.js";
import {
  JobInput,
  Targets,
  getTargets,
  ingestJobs,
  listApplications,
  listJobs,
  saveMatches,
  setTargets,
  skillGapInput,
  trackApplication,
} from "./jobs.js";
import {
  OUTREACH_PURPOSES,
  addNote,
  completeFollowup,
  draftOutreachContext,
  dueFollowups,
  getContact,
  importConnections,
  searchConnections,
  setFollowup,
  tagContact,
} from "./crm.js";

export type { Env };

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ใช้รูปแบบ YYYY-MM-DD");

// เปรียบเทียบ token แบบเวลาคงที่ เพื่อไม่ให้เดาทีละตัวจากเวลาตอบกลับ
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// รับได้ 2 แบบ: Bearer token เดิม (Claude Code) หรือ access token ที่ออกผ่าน OAuth (claude.ai)
async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  if (env.MCP_TOKEN && safeEqual(match[1], env.MCP_TOKEN)) return true;
  return verifyAccessToken(env, match[1]);
}

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

// ครอบ tool ทุกตัวด้วย audit log: บันทึกทั้งผลสำเร็จและ error
function tool<A>(
  env: Env,
  name: string,
  fn: (args: A) => Promise<unknown>,
) {
  return async (args: A) => {
    try {
      const data = await fn(args);
      await audit(env.DB, name, args, data, true);
      return json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await audit(env.DB, name, args, { error: message }, false);
      throw err;
    }
  };
}

function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "linkedin-mcp", version: "0.3.0" });
  const db = env.DB;

  server.registerTool(
    "ping",
    { description: "ตรวจสอบว่า LinkedIn MCP ทำงานและเชื่อมต่อฐานข้อมูล D1 ได้", inputSchema: {} },
    tool(env, "ping", async () => {
      const row = await db
        .prepare("SELECT COUNT(*) AS tables FROM sqlite_master WHERE type = 'table'")
        .first<{ tables: number }>();
      return { ok: true, server_time: new Date().toISOString(), db_tables: row?.tables ?? 0 };
    }),
  );

  server.registerTool(
    "search_connections",
    {
      description: "ค้นหา connections ตามชื่อ บริษัท ตำแหน่ง หรือ tag",
      inputSchema: {
        query: z.string().optional().describe("ค้นจากชื่อ บริษัท หรือตำแหน่ง"),
        company: z.string().optional(),
        position: z.string().optional(),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    tool(env, "search_connections", async (args: {
      query?: string; company?: string; position?: string; tag?: string; limit?: number;
    }) => ({ items: await searchConnections(db, args) })),
  );

  server.registerTool(
    "get_contact",
    {
      description: "ดูรายละเอียดของ connection หนึ่งคน พร้อม notes และ follow-up",
      inputSchema: { contact_id: z.number().int() },
    },
    tool(env, "get_contact", async ({ contact_id }: { contact_id: number }) => getContact(db, contact_id)),
  );

  server.registerTool(
    "tag_contact",
    {
      description: "เพิ่มหรือลบ tag ของ connection เช่น mentor, recruiter, ex-colleague",
      inputSchema: {
        contact_id: z.number().int(),
        add: z.array(z.string()).optional(),
        remove: z.array(z.string()).optional(),
      },
    },
    tool(env, "tag_contact", async (args: { contact_id: number; add?: string[]; remove?: string[] }) =>
      tagContact(db, args.contact_id, args.add ?? [], args.remove ?? []),
    ),
  );

  server.registerTool(
    "add_note",
    {
      description: "จดบันทึกเกี่ยวกับ connection เช่น ได้คุยอะไรกันไว้",
      inputSchema: { contact_id: z.number().int(), body: z.string().min(1) },
    },
    tool(env, "add_note", async ({ contact_id, body }: { contact_id: number; body: string }) =>
      addNote(db, contact_id, body),
    ),
  );

  server.registerTool(
    "set_followup",
    {
      description: "ตั้งเตือนให้ทักกลับ connection ในวันที่กำหนด",
      inputSchema: {
        contact_id: z.number().int(),
        due_date: DATE,
        reason: z.string().optional(),
      },
    },
    tool(env, "set_followup", async (args: { contact_id: number; due_date: string; reason?: string }) =>
      setFollowup(db, args.contact_id, args.due_date, args.reason ?? null),
    ),
  );

  server.registerTool(
    "due_followups",
    {
      description: "ดูรายการที่ถึงกำหนดทักกลับ (ค่าเริ่มต้นคือวันนี้ตามเวลาไทย)",
      inputSchema: { as_of: DATE.optional() },
    },
    tool(env, "due_followups", async ({ as_of }: { as_of?: string }) => dueFollowups(db, as_of)),
  );

  server.registerTool(
    "complete_followup",
    {
      description: "ทำเครื่องหมายว่าทักกลับแล้ว",
      inputSchema: { followup_id: z.number().int() },
    },
    tool(env, "complete_followup", async ({ followup_id }: { followup_id: number }) =>
      completeFollowup(db, followup_id),
    ),
  );

  server.registerTool(
    "draft_outreach",
    {
      description:
        "รวบรวมข้อมูลของคนคนหนึ่งพร้อมร่างข้อความทัก ระบบไม่ส่งข้อความเอง ผู้ใช้ต้องคัดลอกไปส่งใน LinkedIn ด้วยตัวเอง",
      inputSchema: {
        contact_id: z.number().int(),
        purpose: z.enum(OUTREACH_PURPOSES).describe(
          "first_contact | ask_advice | ask_referral | congratulate | thank_you",
        ),
      },
    },
    tool(env, "draft_outreach", async ({ contact_id, purpose }: { contact_id: number; purpose: string }) =>
      draftOutreachContext(db, contact_id, purpose),
    ),
  );

  // ---- Job engine (ขั้นที่ 3) ----

  const JOB = z.object({
    source: z.string().describe("เช่น gmail-alert, indeed, ziprecruiter"),
    url: z.string().optional(),
    title: z.string().min(1),
    company: z.string().optional(),
    location: z.string().optional(),
    salary_text: z.string().optional(),
    description: z.string().max(20000).optional(),
    posted_at: z.string().optional(),
  });

  server.registerTool(
    "set_targets",
    {
      description: "บันทึกเป้าหมายงานและ resume (ค่าที่ไม่ส่งมาจะคงค่าเดิมไว้)",
      inputSchema: {
        titles: z.array(z.string()).optional(),
        locations: z.array(z.string()).optional(),
        min_salary: z.string().optional(),
        work_mode: z.enum(["remote", "hybrid", "onsite", "any"]).optional(),
        skills: z.array(z.string()).optional(),
        notes: z.string().optional(),
        resume_text: z.string().max(50000).optional().describe("ข้อความ resume (ไม่ใช่ไฟล์ PDF)"),
      },
    },
    tool(env, "set_targets", async (args: Targets) => setTargets(db, args)),
  );

  server.registerTool(
    "get_targets",
    { description: "ดูเป้าหมายงานที่บันทึกไว้", inputSchema: {} },
    tool(env, "get_targets", async () => {
      const t = await getTargets(db);
      return { ...t, resume_text: t.resume_text ? `(${t.resume_text.length} ตัวอักษร)` : undefined };
    }),
  );

  server.registerTool(
    "ingest_jobs",
    {
      description:
        "เพิ่มประกาศงานที่ดึงมาแล้ว (จาก Gmail Job Alert, Indeed, ZipRecruiter) ระบบตัดรายการซ้ำให้อัตโนมัติ ส่งได้สูงสุด 50 รายการต่อครั้ง",
      inputSchema: { jobs: z.array(JOB).min(1).max(50) },
    },
    tool(env, "ingest_jobs", async ({ jobs }: { jobs: JobInput[] }) => ingestJobs(db, jobs)),
  );

  server.registerTool(
    "list_jobs",
    {
      description:
        "ดูรายการงาน เรียงตามคะแนนที่จับคู่ไว้ ใช้ unscored=true เพื่อดูงานที่ยังไม่ได้ให้คะแนน",
      inputSchema: {
        unscored: z.boolean().optional(),
        min_score: z.number().min(0).max(100).optional(),
        status: z.enum(["saved", "applied", "interview", "offer", "rejected"]).optional(),
        include_description: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    tool(env, "list_jobs", async (args: Parameters<typeof listJobs>[1]) => listJobs(db, args)),
  );

  server.registerTool(
    "save_matches",
    {
      description:
        "บันทึกคะแนน (0-100) และเหตุผลที่ Claude ให้กับงานแต่ละตำแหน่ง หลังจากอ่าน targets และ list_jobs(unscored=true) แล้ว",
      inputSchema: {
        matches: z
          .array(
            z.object({
              job_id: z.number().int(),
              score: z.number().min(0).max(100),
              reasons: z.string().max(1000),
            }),
          )
          .min(1)
          .max(100),
      },
    },
    tool(env, "save_matches", async ({ matches }: { matches: { job_id: number; score: number; reasons: string }[] }) =>
      saveMatches(db, matches),
    ),
  );

  server.registerTool(
    "track_application",
    {
      description: "ติดตามสถานะการสมัครงาน: saved → applied → interview → offer / rejected",
      inputSchema: {
        job_id: z.number().int(),
        status: z.enum(["saved", "applied", "interview", "offer", "rejected"]),
        notes: z.string().optional(),
      },
    },
    tool(env, "track_application", async (args: { job_id: number; status: string; notes?: string }) =>
      trackApplication(db, args),
    ),
  );

  server.registerTool(
    "list_applications",
    {
      description: "ดูรายการการสมัครงานและสถานะล่าสุด",
      inputSchema: {
        status: z.enum(["saved", "applied", "interview", "offer", "rejected"]).optional(),
      },
    },
    tool(env, "list_applications", async ({ status }: { status?: string }) => listApplications(db, status)),
  );

  server.registerTool(
    "skill_gap",
    {
      description:
        "รวบรวมรายละเอียดงานที่คะแนนสูงพร้อมทักษะปัจจุบัน แล้วให้ Claude วิเคราะห์ช่องว่างทักษะ",
      inputSchema: {
        min_score: z.number().min(0).max(100).optional(),
        limit: z.number().int().min(1).max(30).optional(),
      },
    },
    tool(env, "skill_gap", async (args: { min_score?: number; limit?: number }) =>
      skillGapInput(db, args.min_score ?? 60, args.limit ?? 15),
    ),
  );

  // ---- ไม่ต้องรอข้อมูล: invitations และ warm intro ----

  server.registerTool(
    "list_invitations",
    {
      description: "ดูคำขอ connection ที่ส่งออกไป (OUTGOING) หรือได้รับ (INCOMING) จากไฟล์ Invitations",
      inputSchema: {
        direction: z.enum(["OUTGOING", "INCOMING"]).optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    tool(env, "list_invitations", async (args: { direction?: "OUTGOING" | "INCOMING"; search?: string; limit?: number }) =>
      listInvitations(db, args),
    ),
  );

  server.registerTool(
    "find_warm_intro",
    {
      description:
        "หา connection ที่ทำงานอยู่ในบริษัทของงานที่สนใจ เพื่อขอ referral หรือคำแนะนำ (งานต้องถูกนำเข้าก่อนด้วย ingest_jobs)",
      inputSchema: { job_id: z.number().int() },
    },
    tool(env, "find_warm_intro", async ({ job_id }: { job_id: number }) => findWarmIntro(db, job_id)),
  );

  // ---- โพสต์ในนามตัวเอง (ขั้นที่ 4) ----

  server.registerTool(
    "linkedin_connect",
    {
      description: "สร้างลิงก์เชื่อมต่อ LinkedIn ให้ผู้ใช้เปิดในเบราว์เซอร์ (ต้องมี LinkedIn Developer App แล้ว)",
      inputSchema: {},
    },
    tool(env, "linkedin_connect", async () => buildAuthUrl(env)),
  );

  server.registerTool(
    "linkedin_status",
    { description: "ดูว่าเชื่อมต่อ LinkedIn แล้วหรือยัง และ token หมดอายุเมื่อไร", inputSchema: {} },
    tool(env, "linkedin_status", async () => linkedInStatus(env)),
  );

  server.registerTool(
    "draft_post",
    {
      description: "ร่างโพสต์ LinkedIn เก็บไว้ยังไม่เผยแพร่ (สูงสุด 3000 ตัวอักษร)",
      inputSchema: { body: z.string().min(1).max(3000) },
    },
    tool(env, "draft_post", async ({ body }: { body: string }) => createDraftPost(db, body)),
  );

  server.registerTool(
    "request_publish",
    {
      description:
        "ขอเผยแพร่โพสต์ที่ร่างไว้ ระบบจะคืนตัวอย่างและรหัสยืนยัน 6 หลัก ต้องแสดงให้ผู้ใช้ดูก่อนเสมอ",
      inputSchema: {
        post_id: z.number().int(),
        scheduled_for: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, "ใช้ ISO 8601 พร้อม offset เช่น 2026-10-14T09:00:00+07:00")
          .optional()
          .describe("เวลาที่ต้องการให้โพสต์ ถ้าไม่ระบุจะโพสต์ทันทีที่ยืนยัน"),
      },
    },
    tool(env, "request_publish", async ({ post_id, scheduled_for }: { post_id: number; scheduled_for?: string }) =>
      requestPublish(db, post_id, scheduled_for),
    ),
  );

  server.registerTool(
    "confirm_publish",
    {
      description:
        "เผยแพร่โพสต์จริงบน LinkedIn ใช้เฉพาะเมื่อผู้ใช้ตอบรับตัวอย่างจาก request_publish แล้วเท่านั้น",
      inputSchema: { confirmation_code: z.string().regex(/^\d{6}$/) },
    },
    tool(env, "confirm_publish", async ({ confirmation_code }: { confirmation_code: string }) =>
      confirmPublish(env, confirmation_code),
    ),
  );

  // รูปจากแชต (base64) ไม่บันทึกเนื้อรูปลง audit log เพราะจะใหญ่เกินไป
  server.registerTool(
    "attach_image",
    {
      description:
        "แนบรูปกับร่างโพสต์ โดยส่งเนื้อรูปแบบ base64 (ไม่เกิน 1 MB) ใช้เมื่อผู้ใช้อัปโหลดรูปในแชต",
      inputSchema: {
        post_id: z.number().int(),
        mime_type: z.enum(["image/png", "image/jpeg", "image/gif"]),
        data_base64: z.string().min(4).max(1_400_000),
      },
    },
    async (args: { post_id: number; mime_type: string; data_base64: string }) => {
      try {
        const result = await attachImageBase64(env, args.post_id, args.mime_type, args.data_base64);
        await audit(db, "attach_image", { post_id: args.post_id, mime_type: args.mime_type, chars: args.data_base64.length }, result, true);
        return json(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await audit(db, "attach_image", { post_id: args.post_id, mime_type: args.mime_type, chars: args.data_base64.length }, { error: message }, false);
        throw err;
      }
    },
  );

  // รูปที่สร้างด้วยเครื่องมืออื่น เช่น Canva ส่งเป็นลิงก์ https แล้วเซิร์ฟเวอร์ดาวน์โหลดเอง
  server.registerTool(
    "attach_image_from_url",
    {
      description:
        "แนบรูปกับร่างโพสต์จากลิงก์ https ที่เป็นรูปโดยตรง เช่น ลิงก์ส่งออกจาก Canva (ไม่เกิน 1 MB)",
      inputSchema: {
        post_id: z.number().int(),
        url: z.string().url().max(2000),
      },
    },
    tool(env, "attach_image_from_url", async (args: { post_id: number; url: string }) =>
      attachImageFromUrl(env, args.post_id, args.url),
    ),
  );

  server.registerTool(
    "list_posts",
    {
      description: "ดูรายการโพสต์ที่ร่างไว้และที่เผยแพร่แล้ว",
      inputSchema: { status: z.enum(["draft", "published", "deleted"]).optional() },
    },
    tool(env, "list_posts", async ({ status }: { status?: string }) => listPosts(db, status)),
  );

  server.registerTool(
    "cancel_scheduled",
    {
      description: "ยกเลิกการโพสต์ที่ตั้งเวลาไว้ โพสต์จะกลับเป็นร่าง",
      inputSchema: { post_id: z.number().int() },
    },
    tool(env, "cancel_scheduled", async ({ post_id }: { post_id: number }) => cancelScheduled(db, post_id)),
  );

  server.registerTool(
    "list_scheduled",
    { description: "ดูรายการโพสต์ที่ตั้งเวลาไว้และยังไม่ถูกโพสต์", inputSchema: {} },
    tool(env, "list_scheduled", async () => listScheduled(db)),
  );

  return server;
}

// นำเข้าไฟล์ export ของ LinkedIn ผ่านสคริปต์ scripts/import-linkedin.mjs (ไม่ผ่าน Claude เพื่อประหยัด context)
const IMPORTERS: Record<string, (db: Env["DB"], text: string) => Promise<unknown>> = {
  connections: async (db, text) => importConnections(db, parseConnections(text)),
  invitations: async (db, text) => importInvitations(db, parseInvitations(text)),
  profile: async (db, text) => importProfile(db, parseProfile(text)),
};

async function handleImport(kind: string, request: Request, env: Env): Promise<Response> {
  const importer = IMPORTERS[kind];
  if (!importer) return Response.json({ ok: false, error: `ไม่รู้จักประเภท '${kind}'` }, { status: 404 });

  const text = await request.text();
  const tool = `import_${kind}`;
  try {
    const summary = await importer(env.DB, text);
    await audit(env.DB, tool, { bytes: text.length }, summary, true);
    return Response.json({ ok: true, date: todayBangkok(), kind, ...(summary as object) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit(env.DB, tool, { bytes: text.length }, { error: message }, false);
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}

// ส่งออกทุกตารางเป็น JSON เพื่อสำรองข้อมูล (ต้องมี Bearer token เท่านั้น)
const EXPORT_TABLES = [
  "contacts", "tags", "contact_tags", "notes", "followups", "invitations",
  "jobs", "job_matches", "applications", "profile", "posts", "pending_actions", "audit_log",
];

async function exportAll(env: Env): Promise<Response> {
  const data: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    data[table] = (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results;
  }
  return Response.json({ exported_at: new Date().toISOString(), tables: data }, {
    headers: { "Content-Disposition": "attachment; filename=linkedin-mcp-backup.json" },
  });
}

export default {
  // Cron ทุก 5 นาที: โพสต์งานที่ตั้งเวลาไว้เมื่อถึงเวลา
  async scheduled(_event: unknown, env: Env) {
    await runScheduledPosts(env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("linkedin-mcp ok", { status: 200 });
    }

    // OAuth สำหรับ claude.ai
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return Response.json(protectedResourceMetadata(url.origin));
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json(authorizationServerMetadata(url.origin));
    }
    if (url.pathname === "/register" && request.method === "POST") {
      return registerClient(env, request);
    }
    if (url.pathname === "/authorize") {
      if (request.method === "GET") return authorizeGet(env, url);
      if (request.method === "POST") return authorizePost(env, request);
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/token" && request.method === "POST") {
      return tokenEndpoint(env, request);
    }

    // หน้านโยบายความเป็นส่วนตัว (LinkedIn ต้องการ URL นี้ตอนสร้าง Developer App)
    if (url.pathname === "/privacy") {
      return new Response(
        `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>นโยบายความเป็นส่วนตัว - LinkedIn MCP</title>
<body style="font-family:sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.6">
<h1>นโยบายความเป็นส่วนตัว: LinkedIn MCP</h1>
<p>ระบบนี้เป็นเครื่องมือส่วนตัวของเจ้าของบัญชี LinkedIn ใช้จัดการเครือข่ายอาชีพ ติดตามงาน และโพสต์ข้อความในนามเจ้าของบัญชีเท่านั้น</p>
<h2>ข้อมูลที่เก็บ</h2>
<ul>
<li>รายชื่อ connections จากไฟล์ export ของ LinkedIn (ชื่อ บริษัท ตำแหน่ง ลิงก์โปรไฟล์)</li>
<li>คำขอ connection และข้อมูลโปรไฟล์ของเจ้าของบัญชี</li>
<li>ประกาศงานที่ผู้ใช้สนใจ และบันทึกการสมัครงาน</li>
<li>access token ของ LinkedIn ซึ่งเก็บในรูปแบบเข้ารหัส</li>
</ul>
<h2>การใช้ข้อมูล</h2>
<p>ใช้เพื่อการจัดการความสัมพันธ์ทางอาชีพและการค้นหางานของเจ้าของบัญชีเท่านั้น ระบบไม่ส่งข้อความหรือโพสต์โดยอัตโนมัติ การโพสต์ทุกครั้งต้องได้รับการยืนยันจากเจ้าของบัญชีก่อน</p>
<h2>การเก็บรักษาและการแบ่งปัน</h2>
<p>ข้อมูลเก็บในฐานข้อมูล Cloudflare D1 และไม่ถูกแบ่งปันให้บุคคลหรือบริษัทอื่น</p>
<h2>การลบข้อมูล</h2>
<p>เจ้าของบัญชีสามารถขอให้ลบข้อมูลทั้งหมดได้ทุกเมื่อ และสามารถยกเลิกการเชื่อมต่อ LinkedIn ได้โดยลบ token ออกจากระบบ</p>
<h2>ติดต่อ</h2>
<p>ติดต่อเจ้าของระบบผ่านข้อมูลติดต่อในโปรไฟล์ LinkedIn ของเจ้าของบัญชี</p>
<p><small>ปรับปรุงล่าสุด: 2026-10-10</small></p>
</body></html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    // LinkedIn redirect กลับมาที่นี่ ตรวจด้วย state แทน Bearer token
    if (url.pathname === "/oauth/callback") {
      return handleOAuthCallback(env, url);
    }

    const isImport = url.pathname.startsWith("/import/");
    const isMedia = url.pathname.startsWith("/media/");
    if (url.pathname !== "/mcp" && url.pathname !== "/export" && !isImport && !isMedia) {
      return new Response("Not found", { status: 404 });
    }

    if (!(await isAuthorized(request, env))) {
      return new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
        },
      });
    }

    if (isMedia) {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const postId = Number(url.pathname.slice("/media/".length));
      if (!Number.isInteger(postId) || postId <= 0) return Response.json({ ok: false, error: "post id ไม่ถูกต้อง" }, { status: 400 });
      return attachMedia(env, postId, request);
    }

    if (url.pathname === "/export") {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return exportAll(env);
    }

    if (isImport) {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      return handleImport(url.pathname.slice("/import/".length), request, env);
    }

    // stateless: สร้าง server ใหม่ทุก request เหมาะกับ Worker
    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
