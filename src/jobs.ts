import { D1Database, D1Statement, runInChunks } from "./db.js";

export interface JobInput {
  source: string;
  url?: string | null;
  title: string;
  company?: string | null;
  location?: string | null;
  salary_text?: string | null;
  description?: string | null;
  posted_at?: string | null;
}

export interface Targets {
  titles?: string[];
  locations?: string[];
  min_salary?: string;
  work_mode?: "remote" | "hybrid" | "onsite" | "any";
  skills?: string[];
  notes?: string;
  resume_text?: string;
}

const PROFILE_KEY = "job_targets";

// ตัดรายการซ้ำ: ใช้ URL ก่อน ถ้าไม่มีค่อยใช้ (บริษัท + ตำแหน่ง + เมือง)
export function dedupeKey(j: JobInput): string {
  if (j.url) {
    try {
      const u = new URL(j.url.trim());
      return `url:${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
    } catch {
      // URL ไม่ถูกรูปแบบ ใช้คีย์แบบชื่อแทน
    }
  }
  return `cj:${[j.company, j.title, j.location].map((s) => (s ?? "").trim().toLowerCase()).join("|")}`;
}

export async function getTargets(db: D1Database): Promise<Targets> {
  const row = await db
    .prepare("SELECT value FROM profile WHERE key = ?")
    .bind(PROFILE_KEY)
    .first<{ value: string }>();
  return row ? (JSON.parse(row.value) as Targets) : {};
}

// รวมค่าใหม่เข้ากับค่าเดิม ค่าที่ไม่ส่งมาจะคงไว้
export async function setTargets(db: D1Database, patch: Targets) {
  const merged = { ...(await getTargets(db)), ...stripUndefined(patch) };
  await db
    .prepare(
      "INSERT INTO profile (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(PROFILE_KEY, JSON.stringify(merged))
    .run();
  // ไม่ส่ง resume_text กลับทั้งหมดเพื่อประหยัด context
  return { ...merged, resume_text: merged.resume_text ? `(${merged.resume_text.length} ตัวอักษร)` : undefined };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ประกาศเดียวกันมักมีหลาย URL จึงตรวจซ้ำด้วย (บริษัท + ตำแหน่ง + เมือง) ด้วย
function tupleKey(company: string | null | undefined, title: string, location: string | null | undefined) {
  return [company, title, location].map((s) => (s ?? "").trim().toLowerCase()).join("|");
}

export async function ingestJobs(db: D1Database, jobs: JobInput[]) {
  const countTotal = async () =>
    (await db.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())?.n ?? 0;

  const existing = await db
    .prepare("SELECT company, title, location FROM jobs")
    .all<{ company: string | null; title: string; location: string | null }>();
  const seen = new Set(existing.results.map((r) => tupleKey(r.company, r.title, r.location)));

  const fresh: JobInput[] = [];
  for (const j of jobs) {
    const key = tupleKey(j.company, j.title, j.location);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(j);
  }

  const before = await countTotal();
  const statements: D1Statement[] = fresh.map((j) =>
    db
      .prepare(
        `INSERT INTO jobs (source, source_url, dedupe_key, title, company, location, salary_text, description, posted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .bind(
        j.source,
        j.url ?? null,
        dedupeKey(j),
        j.title,
        j.company ?? null,
        j.location ?? null,
        j.salary_text ?? null,
        j.description ?? null,
        j.posted_at ?? null,
      ),
  );
  await runInChunks(db, statements);
  const after = await countTotal();

  return {
    received: jobs.length,
    new_jobs: after - before,
    duplicates_skipped: jobs.length - (after - before),
  };
}

export async function listJobs(
  db: D1Database,
  opts: { unscored?: boolean; min_score?: number; status?: string; limit?: number; include_description?: boolean },
) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.unscored) where.push("m.job_id IS NULL");
  if (opts.min_score !== undefined) {
    where.push("m.score >= ?");
    params.push(opts.min_score);
  }
  if (opts.status) {
    where.push("a.status = ?");
    params.push(opts.status);
  }

  const sql = `
    SELECT j.id, j.title, j.company, j.location, j.salary_text, j.source, j.source_url, j.posted_at,
      m.score, m.reasons, a.status AS application_status
      ${opts.include_description ? ", j.description" : ""}
    FROM jobs j
    LEFT JOIN job_matches m ON m.job_id = j.id
    LEFT JOIN applications a ON a.id = (SELECT MAX(id) FROM applications WHERE job_id = j.id)
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY (m.score IS NULL), m.score DESC, j.ingested_at DESC
    LIMIT ?`;
  params.push(Math.min(opts.limit ?? 20, 100));

  const items = (await db.prepare(sql).bind(...params).all<Record<string, unknown>>()).results;
  return { count: items.length, items };
}

// Claude เป็นคนให้คะแนนและเหตุผล เพราะต้องอ่าน resume ประกอบ tool นี้เก็บผลลง DB
export async function saveMatches(
  db: D1Database,
  matches: { job_id: number; score: number; reasons: string }[],
) {
  const statements = matches.map((m) =>
    db
      .prepare(
        `INSERT INTO job_matches (job_id, score, reasons, scored_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(job_id) DO UPDATE SET score = excluded.score, reasons = excluded.reasons, scored_at = excluded.scored_at`,
      )
      .bind(m.job_id, m.score, m.reasons),
  );
  await runInChunks(db, statements);
  return { saved: matches.length };
}

export async function trackApplication(
  db: D1Database,
  args: { job_id: number; status: string; notes?: string | null },
) {
  const job = await db.prepare("SELECT id, title, company FROM jobs WHERE id = ?").bind(args.job_id).first();
  if (!job) throw new Error(`ไม่พบงาน id ${args.job_id}`);

  const latest = await db
    .prepare("SELECT id FROM applications WHERE job_id = ? ORDER BY id DESC LIMIT 1")
    .bind(args.job_id)
    .first<{ id: number }>();
  if (latest) {
    await db
      .prepare("UPDATE applications SET status = ?, notes = COALESCE(?, notes), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .bind(args.status, args.notes ?? null, latest.id)
      .run();
  } else {
    await db
      .prepare("INSERT INTO applications (job_id, status, notes) VALUES (?, ?, ?)")
      .bind(args.job_id, args.status, args.notes ?? null)
      .run();
  }
  return { job, status: args.status, updated: Boolean(latest) };
}

export async function listApplications(db: D1Database, status?: string) {
  const sql = `
    SELECT a.id, a.status, a.notes, a.updated_at, j.id AS job_id, j.title, j.company, j.location, j.source_url
    FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.id IN (SELECT MAX(id) FROM applications GROUP BY job_id)
      ${status ? "AND a.status = ?" : ""}
    ORDER BY a.updated_at DESC`;
  const stmt = db.prepare(sql);
  const rows = status ? await stmt.bind(status).all() : await stmt.all();
  return { count: rows.results.length, items: rows.results };
}

// ส่งข้อมูลให้ Claude วิเคราะห์ช่องว่างทักษะ (tool นี้ไม่ได้คำนวณเอง)
export async function skillGapInput(db: D1Database, minScore: number, limit: number) {
  const targets = await getTargets(db);
  const jobs = (
    await db
      .prepare(
        `SELECT j.id, j.title, j.company, m.score, substr(j.description, 1, 2000) AS description
         FROM jobs j JOIN job_matches m ON m.job_id = j.id
         WHERE m.score >= ? AND j.description IS NOT NULL
         ORDER BY m.score DESC LIMIT ?`,
      )
      .bind(minScore, Math.min(limit, 30))
      .all()
  ).results;
  return {
    your_skills: targets.skills ?? [],
    jobs_analyzed: jobs.length,
    jobs,
    instruction: "จากรายละเอียดงานเหล่านี้ ให้สรุปทักษะที่ถูกเรียกบ่อยแต่ยังไม่อยู่ใน your_skills พร้อมแนะนำวิธีเรียนรู้ที่ทำได้จริง",
  };
}
