import { D1Database, D1Statement, runInChunks } from "./db.js";
import { parseCsv } from "./csv.js";

export interface InvitationRow {
  direction: "OUTGOING" | "INCOMING";
  other_name: string | null;
  other_profile_url: string;
  sent_at: string | null;
  message: string | null;
}

// อ่านหัวตารางแล้วคืนฟังก์ชันดึงค่าตามชื่อคอลัมน์
function columnReader(header: string[]) {
  const index = new Map(header.map((h, i) => [h.trim(), i]));
  return (row: string[], name: string): string | null => {
    const i = index.get(name);
    const v = i === undefined ? "" : (row[i] ?? "").trim();
    return v === "" ? null : v;
  };
}

// Invitations.csv: คำขอ connection ที่ส่งออกไปและที่ได้รับ
export function parseInvitations(text: string): InvitationRow[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const get = columnReader(rows[0] ?? []);
  const byKey = new Map<string, InvitationRow>();

  for (const row of rows.slice(1)) {
    const direction = get(row, "Direction");
    if (direction !== "OUTGOING" && direction !== "INCOMING") continue;

    // ฝั่งอีกคนคือผู้รับเมื่อเราส่งออก และคือผู้ส่งเมื่อเราได้รับ
    const outgoing = direction === "OUTGOING";
    const url = get(row, outgoing ? "inviteeProfileUrl" : "inviterProfileUrl");
    if (!url) continue;

    byKey.set(`${direction}|${url}`, {
      direction,
      other_name: get(row, outgoing ? "To" : "From"),
      other_profile_url: url,
      sent_at: get(row, "Sent At"),
      message: get(row, "Message"),
    });
  }
  return [...byKey.values()];
}

export async function importInvitations(db: D1Database, rows: InvitationRow[]) {
  const before = await db.prepare("SELECT COUNT(*) AS n FROM invitations").first<{ n: number }>();
  const statements: D1Statement[] = rows.map((r) =>
    db
      .prepare(
        `INSERT INTO invitations (direction, other_name, other_profile_url, sent_at, message)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(direction, other_profile_url) DO UPDATE SET
           other_name = excluded.other_name, sent_at = excluded.sent_at, message = excluded.message`,
      )
      .bind(r.direction, r.other_name, r.other_profile_url, r.sent_at, r.message),
  );
  await runInChunks(db, statements);
  const after = await db.prepare("SELECT COUNT(*) AS n FROM invitations").first<{ n: number }>();

  const counts = await db
    .prepare("SELECT direction, COUNT(*) AS n FROM invitations GROUP BY direction")
    .all<{ direction: string; n: number }>();
  return {
    rows_in_file: rows.length,
    new_rows: (after?.n ?? 0) - (before?.n ?? 0),
    totals: Object.fromEntries(counts.results.map((c) => [c.direction, c.n])),
  };
}

// Profile.csv: เก็บทั้งแถวเป็น JSON ไว้ที่ key "linkedin_profile"
// ข้อมูลส่วนตัวของคุณเอง ไม่แตะ connections หรือ contacts
export function parseProfile(text: string): Record<string, string | null> {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const header = (rows[0] ?? []).map((h) => h.trim());
  const row = rows[1];
  if (!row) throw new Error("Profile.csv ไม่มีข้อมูลแถวที่ 1");
  const profile: Record<string, string | null> = {};
  header.forEach((h, i) => {
    const v = (row[i] ?? "").trim();
    profile[h] = v === "" ? null : v;
  });
  return profile;
}

export async function listInvitations(
  db: D1Database,
  opts: { direction?: "OUTGOING" | "INCOMING"; search?: string; limit?: number },
) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.direction) {
    where.push("direction = ?");
    params.push(opts.direction);
  }
  if (opts.search) {
    where.push("(other_name LIKE ? OR message LIKE ?)");
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }
  const sql = `SELECT id, direction, other_name, other_profile_url, sent_at, message FROM invitations
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY id DESC LIMIT ?`;
  params.push(Math.min(opts.limit ?? 50, 200));
  const items = (await db.prepare(sql).bind(...params).all()).results;
  return { count: items.length, items };
}

export async function importProfile(db: D1Database, profile: Record<string, string | null>) {
  await db
    .prepare(
      "INSERT INTO profile (key, value) VALUES ('linkedin_profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(JSON.stringify(profile))
    .run();
  return {
    fields: Object.keys(profile).length,
    headline: profile["Headline"] ?? null,
    name: [profile["First Name"], profile["Last Name"]].filter(Boolean).join(" ") || null,
  };
}
