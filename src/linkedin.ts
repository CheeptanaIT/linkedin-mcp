import { Env, D1Database, audit } from "./db.js";

// ---- การเข้ารหัส token ที่เก็บใน D1 (AES-GCM, คีย์มาจาก MCP_TOKEN) ----

const enc = new TextEncoder();
const dec = new TextDecoder();

async function aesKey(env: Env): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", enc.encode(`linkedin-token:${env.MCP_TOKEN}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function encrypt(env: Env, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(text)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64(out);
}

async function decrypt(env: Env, b64: string): Promise<string> {
  const data = fromBase64(b64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, await aesKey(env), data.slice(12));
  return dec.decode(pt);
}

// ---- เก็บและอ่าน token ----

interface StoredToken {
  access_token: string;
  member_id: string;
  expires_at: string;
}

async function saveToken(env: Env, token: StoredToken) {
  const sealed = await encrypt(env, JSON.stringify(token));
  await env.DB.prepare(
    "INSERT INTO profile (key, value) VALUES ('linkedin_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  )
    .bind(sealed)
    .run();
}

async function loadToken(env: Env): Promise<StoredToken> {
  const row = await env.DB.prepare("SELECT value FROM profile WHERE key = 'linkedin_token'").first<{ value: string }>();
  if (!row) throw new Error("ยังไม่ได้เชื่อมต่อ LinkedIn ให้เรียก linkedin_connect ก่อน");
  const token = JSON.parse(await decrypt(env, row.value)) as StoredToken;
  if (new Date(token.expires_at).getTime() < Date.now()) {
    throw new Error("token ของ LinkedIn หมดอายุแล้ว ให้เรียก linkedin_connect ใหม่");
  }
  return token;
}

// ---- OAuth ----

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const SCOPES = "openid profile email w_member_social";

function requireLinkedInConfig(env: Env) {
  if (!env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET || !env.LINKEDIN_REDIRECT_URI) {
    throw new Error("ยังไม่ได้ตั้งค่า LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET / LINKEDIN_REDIRECT_URI (ขั้นที่ 0.5)");
  }
}

// สร้าง state กัน CSRF เก็บใน pending_actions อายุ 10 นาที
export async function buildAuthUrl(env: Env) {
  requireLinkedInConfig(env);
  const state = crypto.randomUUID();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO pending_actions (id, kind, payload, status, expires_at) VALUES (?, 'oauth_state', '{}', 'pending', ?)",
  )
    .bind(state, expires)
    .run();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.LINKEDIN_CLIENT_ID!,
    redirect_uri: env.LINKEDIN_REDIRECT_URI!,
    state,
    scope: SCOPES,
  });
  return { url: `${AUTH_URL}?${params}`, expires_at: expires, note: "เปิดลิงก์นี้ในเบราว์เซอร์ที่ล็อกอิน LinkedIn แล้ว" };
}

// LinkedIn redirect กลับมาที่นี่ ไม่มี Bearer token จึงใช้ state เป็นตัวตรวจสอบแทน
export async function handleOAuthCallback(env: Env, url: URL): Promise<Response> {
  const page = (title: string, body: string, status = 200) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;padding:2rem"><h2>${title}</h2><p>${body}</p></body>`,
      { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );

  const error = url.searchParams.get("error");
  if (error) return page("เชื่อมต่อไม่สำเร็จ", `LinkedIn ส่งข้อผิดพลาด: ${error}`, 400);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return page("เชื่อมต่อไม่สำเร็จ", "ไม่พบ code หรือ state", 400);

  const pending = await env.DB.prepare(
    "SELECT id, expires_at FROM pending_actions WHERE id = ? AND kind = 'oauth_state' AND status = 'pending'",
  )
    .bind(state)
    .first<{ id: string; expires_at: string }>();
  if (!pending || new Date(pending.expires_at).getTime() < Date.now()) {
    return page("เชื่อมต่อไม่สำเร็จ", "state หมดอายุหรือไม่ถูกต้อง ให้เริ่มใหม่จาก linkedin_connect", 400);
  }
  // ใช้ state ได้ครั้งเดียว
  await env.DB.prepare("UPDATE pending_actions SET status = 'confirmed' WHERE id = ?").bind(state).run();

  requireLinkedInConfig(env);
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: env.LINKEDIN_REDIRECT_URI!,
      client_id: env.LINKEDIN_CLIENT_ID!,
      client_secret: env.LINKEDIN_CLIENT_SECRET!,
    }),
  });
  if (!tokenRes.ok) {
    await audit(env.DB, "linkedin_oauth", {}, { status: tokenRes.status }, false);
    return page("เชื่อมต่อไม่สำเร็จ", `แลก token ไม่ได้ (${tokenRes.status})`, 502);
  }
  const tokenJson = (await tokenRes.json()) as { access_token: string; expires_in: number };

  const userRes = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${tokenJson.access_token}` } });
  if (!userRes.ok) return page("เชื่อมต่อไม่สำเร็จ", `อ่านข้อมูลสมาชิกไม่ได้ (${userRes.status})`, 502);
  const user = (await userRes.json()) as { sub: string; name?: string };

  await saveToken(env, {
    access_token: tokenJson.access_token,
    member_id: user.sub,
    expires_at: new Date(Date.now() + tokenJson.expires_in * 1000).toISOString(),
  });
  await audit(env.DB, "linkedin_oauth", {}, { member: user.name ?? user.sub }, true);
  return page("เชื่อมต่อ LinkedIn สำเร็จ", "ปิดหน้านี้และกลับไปที่ Claude ได้เลย");
}

export async function linkedInStatus(env: Env) {
  try {
    const t = await loadToken(env);
    const daysLeft = Math.floor((new Date(t.expires_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    return {
      connected: true,
      expires_at: t.expires_at,
      days_left: daysLeft,
      warning: daysLeft <= 7 ? "token ใกล้หมดอายุ ควรเชื่อมต่อใหม่ด้วย linkedin_connect" : null,
    };
  } catch (err) {
    return { connected: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

// ---- โพสต์ ----

const POST_LIMIT = 3000; // ขีดจำกัดของ commentary บน LinkedIn

export async function createDraftPost(db: D1Database, body: string) {
  if (body.length > POST_LIMIT) throw new Error(`ข้อความยาวเกิน ${POST_LIMIT} ตัวอักษร (${body.length})`);
  const res = await db
    .prepare("INSERT INTO posts (platform, body, status) VALUES ('linkedin', ?, 'draft') RETURNING id")
    .bind(body)
    .first<{ id: number }>();
  return { post_id: res?.id, status: "draft", length: body.length };
}

// ขั้นที่ 1 ของการโพสต์: สร้างรหัสยืนยัน 6 หลัก แล้วแสดงตัวอย่างให้ผู้ใช้ดู
export async function requestPublish(db: D1Database, postId: number, scheduledFor?: string) {
  const post = await db.prepare("SELECT id, body, status FROM posts WHERE id = ?").bind(postId).first<{
    id: number; body: string; status: string;
  }>();
  if (!post) throw new Error(`ไม่พบโพสต์ id ${postId}`);
  if (post.status !== "draft") throw new Error(`โพสต์นี้อยู่สถานะ ${post.status} โพสต์ซ้ำไม่ได้`);

  if (scheduledFor) {
    const at = Date.parse(scheduledFor);
    if (Number.isNaN(at)) throw new Error("รูปแบบเวลาไม่ถูกต้อง ใช้ ISO 8601 พร้อม offset เช่น 2026-10-14T09:00:00+07:00");
    if (at < Date.now() + 60 * 1000) throw new Error("เวลาที่ตั้งต้องอยู่หลังจากนี้อย่างน้อย 1 นาที");
    if (at > Date.now() + 30 * 24 * 60 * 60 * 1000) throw new Error("ตั้งเวลาล่วงหน้าได้ไม่เกิน 30 วัน");
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await db
    .prepare("INSERT INTO pending_actions (id, kind, payload, status, expires_at) VALUES (?, 'publish_post', ?, 'pending', ?)")
    .bind(code, JSON.stringify({ post_id: postId, scheduled_for: scheduledFor ?? null }), expires)
    .run();

  return {
    confirmation_code: code,
    expires_at: expires,
    preview: post.body,
    publish_at: scheduledFor ?? "ทันทีที่ยืนยัน",
    instruction:
      "แสดงข้อความนี้ให้ผู้ใช้ดูและให้ผู้ใช้ยืนยันเอง เรียก confirm_publish ด้วยรหัสนี้ก็ต่อเมื่อผู้ใช้ตอบรับเท่านั้น",
  };
}

// ขั้นที่ 2: โพสต์จริง ต้องมีรหัสที่ยังไม่หมดอายุ และใช้ได้ครั้งเดียว
export async function confirmPublish(env: Env, code: string) {
  const pending = await env.DB.prepare(
    "SELECT payload, expires_at FROM pending_actions WHERE id = ? AND kind = 'publish_post' AND status = 'pending'",
  )
    .bind(code)
    .first<{ payload: string; expires_at: string }>();
  if (!pending) throw new Error("ไม่พบรหัสยืนยันนี้ หรือถูกใช้ไปแล้ว");
  if (new Date(pending.expires_at).getTime() < Date.now()) {
    await env.DB.prepare("UPDATE pending_actions SET status = 'expired' WHERE id = ?").bind(code).run();
    throw new Error("รหัสยืนยันหมดอายุ ให้เรียก request_publish ใหม่");
  }
  await env.DB.prepare("UPDATE pending_actions SET status = 'confirmed' WHERE id = ?").bind(code).run();

  const { post_id, scheduled_for } = JSON.parse(pending.payload) as { post_id: number; scheduled_for?: string };

  // ตั้งเวลา: บันทึกงานรอเวลา แล้ว Cron จะโพสต์เมื่อถึงเวลา (หน้าต่างรอ 2 ชั่วโมงหลังเวลาที่ตั้งไว้)
  if (scheduled_for) {
    const windowEnd = new Date(Date.parse(scheduled_for) + 2 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      "INSERT INTO pending_actions (id, kind, payload, status, expires_at) VALUES (?, 'scheduled_job', ?, 'pending', ?)",
    )
      .bind(crypto.randomUUID(), JSON.stringify({ post_id, run_at: new Date(Date.parse(scheduled_for)).toISOString() }), windowEnd)
      .run();
    await env.DB.prepare("UPDATE posts SET scheduled_for = ? WHERE id = ?").bind(scheduled_for, post_id).run();
    return { post_id, scheduled: true, run_at: scheduled_for };
  }

  return publishPostNow(env, post_id);
}

// โพสต์จริงทันที ใช้ทั้งจาก confirm_publish และจาก Cron ตอนถึงเวลาที่ตั้งไว้
export async function publishPostNow(env: Env, post_id: number) {
  const post = await env.DB.prepare("SELECT body FROM posts WHERE id = ?").bind(post_id).first<{ body: string }>();
  if (!post) throw new Error(`ไม่พบโพสต์ id ${post_id}`);

  const token = await loadToken(env);
  const res = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      "Content-Type": "application/json",
      "LinkedIn-Version": env.LINKEDIN_API_VERSION ?? "202601",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: `urn:li:person:${token.member_id}`,
      commentary: post.body,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    await env.DB.prepare("UPDATE posts SET status = 'draft' WHERE id = ?").bind(post_id).run();
    throw new Error(`LinkedIn ตอบกลับ ${res.status}: ${detail.slice(0, 300)}`);
  }

  const urn = res.headers.get("x-restli-id") ?? "";
  await env.DB.prepare(
    "UPDATE posts SET status = 'published', external_id = ?, published_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(urn, post_id)
    .run();
  return { post_id, published: true, urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}` : null };
}

export async function listPosts(db: D1Database, status?: string) {
  const sql = `SELECT id, body, status, external_id, created_at, published_at FROM posts ${status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT 50`;
  const stmt = db.prepare(sql);
  const rows = status ? await stmt.bind(status).all() : await stmt.all();
  return { count: rows.results.length, items: rows.results };
}
