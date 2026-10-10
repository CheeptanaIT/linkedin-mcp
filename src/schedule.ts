import { D1Database, Env, audit } from "./db.js";
import { publishPostNow } from "./linkedin.js";

// Cron ทำงานทุก 5 นาที: โพสต์งานที่ถึงเวลาแล้ว และปิดงานที่พลาดหน้าต่างเวลา
// การยืนยันทำไปแล้วตอนตั้งเวลา (confirm_publish) จึงไม่มีการโพสต์โดยไม่มีคนอนุมัติ
export async function runScheduledPosts(env: Env) {
  const nowIso = new Date().toISOString();

  // งานที่เลยหน้าต่างเวลาแล้ว ปิดไว้ ไม่โพสต์ย้อนหลัง
  await env.DB.prepare(
    "UPDATE pending_actions SET status = 'expired' WHERE kind = 'scheduled_job' AND status = 'pending' AND expires_at < ?",
  )
    .bind(nowIso)
    .run();

  const due = (
    await env.DB.prepare(
      `SELECT id, payload FROM pending_actions
       WHERE kind = 'scheduled_job' AND status = 'pending' AND json_extract(payload, '$.run_at') <= ?`,
    )
      .bind(nowIso)
      .all<{ id: string; payload: string }>()
  ).results;

  for (const job of due) {
    const { post_id } = JSON.parse(job.payload) as { post_id: number };

    // จองงานก่อนโพสต์ เพื่อกันการโพสต์ซ้ำถ้า Cron ทำงานซ้อนกัน
    const claimed = await env.DB.prepare(
      "UPDATE pending_actions SET status = 'confirmed' WHERE id = ? AND status = 'pending' RETURNING id",
    )
      .bind(job.id)
      .first<{ id: string }>();
    if (!claimed) continue;

    try {
      const result = await publishPostNow(env, post_id);
      await env.DB.prepare("UPDATE posts SET scheduled_for = NULL WHERE id = ?").bind(post_id).run();
      await audit(env.DB, "scheduled_publish", { post_id }, result, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await audit(env.DB, "scheduled_publish", { post_id }, { error: message }, false);
    }
  }
}

export async function cancelScheduled(db: D1Database, postId: number) {
  const res = await db
    .prepare(
      "UPDATE pending_actions SET status = 'cancelled' WHERE kind = 'scheduled_job' AND status = 'pending' AND json_extract(payload, '$.post_id') = ? RETURNING id",
    )
    .bind(postId)
    .all<{ id: string }>();
  await db.prepare("UPDATE posts SET scheduled_for = NULL WHERE id = ? AND status = 'draft'").bind(postId).run();
  return { post_id: postId, cancelled: res.results.length };
}

export async function listScheduled(db: D1Database) {
  const rows = (
    await db
      .prepare(
        `SELECT p.id AS post_id, p.body, json_extract(pa.payload, '$.run_at') AS run_at
         FROM pending_actions pa JOIN posts p ON p.id = json_extract(pa.payload, '$.post_id')
         WHERE pa.kind = 'scheduled_job' AND pa.status = 'pending'
         ORDER BY run_at`,
      )
      .all()
  ).results;
  return { count: rows.length, items: rows };
}
