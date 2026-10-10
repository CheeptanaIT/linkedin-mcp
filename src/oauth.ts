import { Env } from "./db.js";

// OAuth 2.1 แบบขั้นต่ำสำหรับ MCP connector ของ claude.ai
// - เจ้าของคนเดียวล็อกอินด้วย OWNER_PASSWORD (ตั้งเป็น secret)
// - ใช้ PKCE (S256) และ Dynamic Client Registration (RFC 7591)
// - access token มีอายุ 30 วัน เก็บเฉพาะ hash ใน D1

const ACCESS_TOKEN_DAYS = 30;
const CODE_MINUTES = 5;
const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

async function sha256Hex(text: string): Promise<string> {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ตรวจ access token ที่ออกให้ claude.ai
export async function verifyAccessToken(env: Env, token: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT expires_at FROM oauth_tokens WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ expires_at: string }>();
  return !!row && new Date(row.expires_at).getTime() > Date.now();
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    resource_name: "LinkedIn MCP",
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

// POST /register: claude.ai ลงทะเบียน client ของตัวเองอัตโนมัติ
export async function registerClient(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { client_name?: string; redirect_uris?: string[] } | null;
  const redirects = body?.redirect_uris ?? [];
  if (redirects.length === 0 || redirects.some((u) => !/^https:\/\/|^http:\/\/localhost/.test(u))) {
    return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }
  const clientId = randomToken(16);
  await env.DB.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (?, ?, ?)")
    .bind(clientId, body?.client_name ?? "claude", JSON.stringify(redirects))
    .run();
  return Response.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body?.client_name ?? "claude",
      redirect_uris: redirects,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201 },
  );
}

async function loadClient(env: Env, clientId: string, redirectUri: string) {
  const row = await env.DB.prepare("SELECT redirect_uris FROM oauth_clients WHERE client_id = ?")
    .bind(clientId)
    .first<{ redirect_uris: string }>();
  if (!row) return false;
  return (JSON.parse(row.redirect_uris) as string[]).includes(redirectUri);
}

function loginPage(params: URLSearchParams, error?: string): Response {
  const hidden = ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "response_type"]
    .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params.get(k) ?? "")}">`)
    .join("");
  return new Response(
    `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>เข้าสู่ระบบ LinkedIn MCP</title>
<body style="font-family:sans-serif;max-width:360px;margin:3rem auto;padding:0 1rem">
<h2>LinkedIn MCP</h2>
<p>ใส่รหัสผ่านของเจ้าของระบบเพื่อให้ Claude เชื่อมต่อ</p>
${error ? `<p style="color:#b00020">${escapeHtml(error)}</p>` : ""}
<form method="POST" action="/authorize">${hidden}
<input type="password" name="password" required autofocus style="width:100%;padding:.6rem;font-size:1rem">
<button type="submit" style="margin-top:1rem;padding:.6rem 1rem;font-size:1rem;width:100%">เชื่อมต่อ</button>
</form></body></html>`,
    { status: error ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// GET /authorize: แสดงหน้าล็อกอิน
export async function authorizeGet(env: Env, url: URL): Promise<Response> {
  const p = url.searchParams;
  if (p.get("response_type") !== "code") return new Response("unsupported response_type", { status: 400 });
  if (p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) {
    return new Response("PKCE S256 is required", { status: 400 });
  }
  if (!(await loadClient(env, p.get("client_id") ?? "", p.get("redirect_uri") ?? ""))) {
    return new Response("unknown client or redirect_uri", { status: 400 });
  }
  return loginPage(p);
}

// POST /authorize: ตรวจรหัสผ่านแล้วออก authorization code อายุ 5 นาที
export async function authorizePost(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const p = new URLSearchParams();
  for (const key of ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "response_type"]) {
    p.set(key, String(form.get(key) ?? ""));
  }
  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";
  if (!(await loadClient(env, clientId, redirectUri))) {
    return new Response("unknown client or redirect_uri", { status: 400 });
  }

  const password = String(form.get("password") ?? "");
  if (!env.OWNER_PASSWORD) return loginPage(p, "ยังไม่ได้ตั้ง OWNER_PASSWORD บนเซิร์ฟเวอร์");
  if (!safeEqual(password, env.OWNER_PASSWORD)) return loginPage(p, "รหัสผ่านไม่ถูกต้อง");

  const code = randomToken(32);
  const expires = new Date(Date.now() + CODE_MINUTES * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO pending_actions (id, kind, payload, status, expires_at) VALUES (?, 'oauth_code', ?, 'pending', ?)",
  )
    .bind(
      code,
      JSON.stringify({ client_id: clientId, redirect_uri: redirectUri, code_challenge: p.get("code_challenge") }),
      expires,
    )
    .run();

  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (p.get("state")) target.searchParams.set("state", p.get("state")!);
  return Response.redirect(target.toString(), 302);
}

// POST /token: แลก code + code_verifier เป็น access token (ใช้ได้ครั้งเดียว)
export async function tokenEndpoint(env: Env, request: Request): Promise<Response> {
  const form = await request.formData();
  const fail = (error: string) => Response.json({ error }, { status: 400 });
  if (form.get("grant_type") !== "authorization_code") return fail("unsupported_grant_type");

  const code = String(form.get("code") ?? "");
  const verifier = String(form.get("code_verifier") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");

  const used = await env.DB.prepare(
    "UPDATE pending_actions SET status = 'confirmed' WHERE id = ? AND kind = 'oauth_code' AND status = 'pending' RETURNING payload, expires_at",
  )
    .bind(code)
    .first<{ payload: string; expires_at: string }>();
  if (!used) return fail("invalid_grant");
  if (new Date(used.expires_at).getTime() < Date.now()) return fail("invalid_grant");

  const saved = JSON.parse(used.payload) as { client_id: string; redirect_uri: string; code_challenge: string };
  if (saved.client_id !== clientId || saved.redirect_uri !== redirectUri) return fail("invalid_grant");

  const computed = b64url(await sha256(verifier));
  if (!safeEqual(computed, saved.code_challenge)) return fail("invalid_grant");

  const token = randomToken(32);
  const expires = new Date(Date.now() + ACCESS_TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO oauth_tokens (token_hash, client_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256Hex(token), clientId, expires)
    .run();

  return Response.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_DAYS * 24 * 60 * 60,
  });
}
