import { D1Database, D1Statement, runInChunks, todayBangkok } from "./db.js";
import { ConnectionRow } from "./csv.js";

export interface ImportSummary {
  total_in_file: number;
  new_contacts: number;
  changed: { name: string; change: string }[];
  missing_from_file: number;
}

// นำเข้า Connections.csv: เพิ่มคนใหม่ และบันทึก note ถ้าบริษัทหรือตำแหน่งเปลี่ยน
// ไม่ลบข้อมูลเก่า ถ้าคนหายจากไฟล์ใหม่จะแค่นับและรายงาน (อาจเป็นการลบ connection หรือ export ไม่ครบ)
export async function importConnections(db: D1Database, rows: ConnectionRow[]): Promise<ImportSummary> {
  const existing = (
    await db
      .prepare("SELECT id, profile_url, first_name, last_name, company, position FROM contacts")
      .all<{
        id: number;
        profile_url: string;
        first_name: string;
        last_name: string;
        company: string | null;
        position: string | null;
      }>()
  ).results;
  const known = new Map(existing.map((e) => [e.profile_url, e]));
  const inFile = new Set(rows.map((r) => r.profile_url));

  const statements: D1Statement[] = [];
  const changed: ImportSummary["changed"] = [];
  let newCount = 0;

  for (const r of rows) {
    const old = known.get(r.profile_url);
    if (!old) {
      newCount++;
      statements.push(
        db
          .prepare(
            "INSERT INTO contacts (profile_url, first_name, last_name, company, position, connected_on) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(profile_url) DO NOTHING",
          )
          .bind(r.profile_url, r.first_name, r.last_name, r.company, r.position, r.connected_on),
      );
      continue;
    }

    const companyChanged = (old.company ?? "") !== (r.company ?? "");
    const positionChanged = (old.position ?? "") !== (r.position ?? "");
    if (!companyChanged && !positionChanged) continue;

    const name = `${r.first_name} ${r.last_name}`.trim();
    const change = `${old.company ?? "-"} / ${old.position ?? "-"} → ${r.company ?? "-"} / ${r.position ?? "-"}`;
    changed.push({ name, change });

    statements.push(
      db
        .prepare(
          "UPDATE contacts SET first_name = ?, last_name = ?, company = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .bind(r.first_name, r.last_name, r.company, r.position, old.id),
    );
    statements.push(
      db
        .prepare("INSERT INTO notes (contact_id, body) VALUES (?, ?)")
        .bind(old.id, `อัปเดตจาก export: ${change}`),
    );
  }

  await runInChunks(db, statements);

  return {
    total_in_file: rows.length,
    new_contacts: newCount,
    changed,
    missing_from_file: existing.filter((e) => !inFile.has(e.profile_url)).length,
  };
}

// ค้นหา connections ตามชื่อ บริษัท ตำแหน่ง หรือ tag
export async function searchConnections(
  db: D1Database,
  opts: { query?: string; company?: string; position?: string; tag?: string; limit?: number },
) {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.query) {
    where.push("(c.first_name || ' ' || c.last_name LIKE ? OR c.company LIKE ? OR c.position LIKE ?)");
    const q = `%${opts.query}%`;
    params.push(q, q, q);
  }
  if (opts.company) {
    where.push("c.company LIKE ?");
    params.push(`%${opts.company}%`);
  }
  if (opts.position) {
    where.push("c.position LIKE ?");
    params.push(`%${opts.position}%`);
  }
  if (opts.tag) {
    where.push(
      "c.id IN (SELECT ct.contact_id FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.name = ?)",
    );
    params.push(opts.tag);
  }

  const sql = `
    SELECT c.id, c.first_name, c.last_name, c.company, c.position, c.profile_url, c.connected_on,
      (SELECT group_concat(t.name, ', ') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id) AS tags
    FROM contacts c
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY c.first_name, c.last_name
    LIMIT ?`;
  params.push(Math.min(opts.limit ?? 25, 200));

  return (await db.prepare(sql).bind(...params).all()).results;
}

export async function getContact(db: D1Database, contactId: number) {
  const contact = await db
    .prepare(
      `SELECT c.*, (SELECT group_concat(t.name, ', ') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id) AS tags
       FROM contacts c WHERE c.id = ?`,
    )
    .bind(contactId)
    .first();
  if (!contact) throw new Error(`ไม่พบ contact id ${contactId}`);

  const notes = (
    await db
      .prepare("SELECT body, created_at FROM notes WHERE contact_id = ? ORDER BY created_at DESC LIMIT 20")
      .bind(contactId)
      .all()
  ).results;
  const followups = (
    await db
      .prepare("SELECT id, due_date, reason, done FROM followups WHERE contact_id = ? ORDER BY due_date DESC LIMIT 20")
      .bind(contactId)
      .all()
  ).results;

  return { contact, notes, followups };
}

async function assertContact(db: D1Database, contactId: number) {
  const row = await db.prepare("SELECT id FROM contacts WHERE id = ?").bind(contactId).first();
  if (!row) throw new Error(`ไม่พบ contact id ${contactId}`);
}

export async function tagContact(db: D1Database, contactId: number, add: string[], remove: string[]) {
  await assertContact(db, contactId);
  const statements: D1Statement[] = [];
  for (const name of add) {
    statements.push(db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").bind(name));
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) SELECT ?, id FROM tags WHERE name = ?")
        .bind(contactId, name),
    );
  }
  for (const name of remove) {
    statements.push(
      db
        .prepare("DELETE FROM contact_tags WHERE contact_id = ? AND tag_id IN (SELECT id FROM tags WHERE name = ?)")
        .bind(contactId, name),
    );
  }
  await runInChunks(db, statements);

  const row = await db
    .prepare(
      `SELECT group_concat(t.name, ', ') AS tags FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = ?`,
    )
    .bind(contactId)
    .first<{ tags: string | null }>();
  return { contact_id: contactId, tags: row?.tags ?? "" };
}

export async function addNote(db: D1Database, contactId: number, body: string) {
  await assertContact(db, contactId);
  await db.prepare("INSERT INTO notes (contact_id, body) VALUES (?, ?)").bind(contactId, body).run();
  return { contact_id: contactId, saved: true };
}

export async function setFollowup(db: D1Database, contactId: number, dueDate: string, reason: string | null) {
  await assertContact(db, contactId);
  await db
    .prepare("INSERT INTO followups (contact_id, due_date, reason) VALUES (?, ?, ?)")
    .bind(contactId, dueDate, reason)
    .run();
  return { contact_id: contactId, due_date: dueDate, saved: true };
}

export async function completeFollowup(db: D1Database, followupId: number) {
  const res = await db.prepare("UPDATE followups SET done = 1 WHERE id = ?").bind(followupId).run();
  return { followup_id: followupId, done: true, res };
}

export async function dueFollowups(db: D1Database, asOf?: string) {
  const date = asOf ?? todayBangkok();
  const rows = (
    await db
      .prepare(
        `SELECT f.id AS followup_id, f.due_date, f.reason,
           c.id AS contact_id, c.first_name, c.last_name, c.company, c.position, c.profile_url,
           (SELECT body FROM notes n WHERE n.contact_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_note
         FROM followups f JOIN contacts c ON c.id = f.contact_id
         WHERE f.done = 0 AND f.due_date <= ?
         ORDER BY f.due_date`,
      )
      .bind(date)
      .all()
  ).results;
  return { as_of: date, count: rows.length, items: rows };
}

// รวมข้อมูลคนคนนั้นให้ Claude เขียนร่างข้อความ โดยไม่ส่งอะไรออกไปเอง
const TEMPLATES: Record<string, string> = {
  first_contact:
    "สวัสดีครับคุณ {first_name} ผมเห็นโปรไฟล์ของคุณที่ {company} และสนใจงานด้าน {position} มาก อยากขอพูดคุยสั้นๆ เพื่อแลกเปลี่ยนประสบการณ์ครับ",
  ask_advice:
    "สวัสดีครับคุณ {first_name} ผมกำลังศึกษาเส้นทางอาชีพและอยากขอคำแนะนำจากประสบการณ์ที่ {company} ถ้าสะดวกขอคุยสัก 15 นาทีได้ไหมครับ",
  ask_referral:
    "สวัสดีครับคุณ {first_name} ผมสนใจตำแหน่งที่ {company} และเห็นว่าเรารู้จักกัน ถ้าพอมีโอกาสช่วยแนะนำหรือให้ข้อมูลเกี่ยวกับทีมได้ จะขอบคุณมากครับ",
  congratulate:
    "ยินดีด้วยนะครับคุณ {first_name} เห็นว่าเริ่มงานใหม่ที่ {company} ขอให้ก้าวหน้าและประสบความสำเร็จครับ",
  thank_you:
    "ขอบคุณมากนะครับคุณ {first_name} สำหรับเวลาและคำแนะนำ ผมได้นำไปใช้จริงแล้วและเป็นประโยชน์มากครับ",
};

export async function draftOutreachContext(db: D1Database, contactId: number, purpose: string) {
  const { contact, notes } = await getContact(db, contactId);
  const c = contact as Record<string, string | null>;
  const fill = (text: string) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => c[key] ?? "");

  return {
    contact: {
      id: contactId,
      name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(),
      company: c.company,
      position: c.position,
      tags: c.tags,
    },
    recent_notes: notes.slice(0, 5),
    template_draft: fill(TEMPLATES[purpose]),
    instruction:
      "ปรับข้อความให้เป็นธรรมชาติตามบันทึกของคนนี้ ห้ามส่งเอง ให้ผู้ใช้คัดลอกไปส่งใน LinkedIn ด้วยตัวเอง",
  };
}

export const OUTREACH_PURPOSES = Object.keys(TEMPLATES) as [string, ...string[]];
