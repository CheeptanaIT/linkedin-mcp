import { D1Database } from "./db.js";

// ทำชื่อบริษัทให้เทียบกันได้: ตัดคำนำหน้า/คำลงท้ายทั่วไป เช่น Co., Ltd., จำกัด, มหาชน
const NOISE = [
  "บริษัท", "บจก.", "บจก", "บมจ.", "บมจ", "จำกัด", "มหาชน", "(มหาชน)",
  "co., ltd.", "co.,ltd.", "co. ltd.", "co ltd", "co.,", "co.", "ltd.", "ltd", "limited",
  "inc.", "inc", "corporation", "corp.", "corp", "company", "(thailand)", "thailand", "plc.", "plc",
];

export function normalizeCompany(name: string | null | undefined): string {
  if (!name) return "";
  let s = name.toLowerCase();
  for (const word of NOISE) s = s.split(word).join(" ");
  return s.replace(/[.,()\-_/&]/g, " ").replace(/\s+/g, " ").trim();
}

// ชื่อตรงกันทั้งหมด หรือชื่อสั้นเป็นคำแรก/คำท้ายของชื่อยาว (เช่น "scb" กับ "scb bank")
// ไม่ใช้ substring เพราะจะจับผิด เช่น "kyndry" กับ "kyndryl"
export function companiesMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && (long.startsWith(short + " ") || long.endsWith(" " + short));
}

export async function findWarmIntro(db: D1Database, jobId: number) {
  const job = await db
    .prepare("SELECT id, title, company, source_url FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ id: number; title: string; company: string | null; source_url: string | null }>();
  if (!job) throw new Error(`ไม่พบงาน id ${jobId}`);

  const target = normalizeCompany(job.company);
  if (!target) return { job, count: 0, items: [], note: "งานนี้ไม่มีชื่อบริษัท" };

  const candidates = (
    await db
      .prepare(
        `SELECT c.id, c.first_name, c.last_name, c.company, c.position, c.profile_url,
           (SELECT group_concat(t.name, ', ') FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id) AS tags
         FROM contacts c WHERE c.company IS NOT NULL`,
      )
      .all<{
        id: number; first_name: string; last_name: string; company: string; position: string | null;
        profile_url: string; tags: string | null;
      }>()
  ).results;

  const items = candidates
    .filter((c) => companiesMatch(target, normalizeCompany(c.company)))
    .map((c) => ({
      contact_id: c.id,
      name: `${c.first_name} ${c.last_name}`.trim(),
      company: c.company,
      position: c.position,
      tags: c.tags,
      profile_url: c.profile_url,
      // คนที่ติด tag ที่ช่วยได้ เช่น mentor, recruiter จะขึ้นก่อน
      priority: /mentor|recruiter|hr|referral/i.test(c.tags ?? "") ? 1 : 0,
    }))
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  return {
    job,
    count: items.length,
    items,
    instruction: items.length
      ? "ใช้ draft_outreach(purpose='ask_referral') กับคนที่เหมาะสมที่สุด แล้วให้ผู้ใช้คัดลอกไปส่งเอง"
      : "ยังไม่มี connection ในบริษัทนี้ ลองค้นจากตำแหน่งหรือกลุ่มอุตสาหกรรมแทน",
  };
}
