# LinkedIn MCP

MCP server สำหรับจัดการ LinkedIn ส่วนตัว: CRM ของ connections, ติดตามงาน และ (ในอนาคต) โพสต์และ Company Page

รันบน Cloudflare Worker และเก็บข้อมูลใน D1 จึงใช้งานได้แม้เครื่องปิด

## โครงสร้าง

```
src/
  worker.ts     เส้นทาง HTTP, ตรวจ token, ลงทะเบียน tools ของ MCP
  db.ts         ชนิดข้อมูล D1, audit log, batch
  csv.ts        อ่าน Connections.csv
  imports.ts    อ่าน Invitations.csv และ Profile.csv
  crm.ts        tools ของ connections (ค้น, tag, note, follow-up, ร่างข้อความ)
  jobs.ts       tools ของงาน (เป้าหมาย, นำเข้า, คะแนน, สถานะการสมัคร)
  intro.ts      หาคนรู้จักในบริษัทที่สนใจ (warm intro)
scripts/
  import-linkedin.mjs   ส่งไฟล์ export จากเครื่องไปยัง Worker
```

## ตั้งค่าครั้งแรก

1. ติดตั้ง dependency
   ```
   npm install
   ```
2. คัดลอก `.env.example` เป็น `.env` และใส่ `MCP_TOKEN` (ค่าเดียวกับที่ตั้งเป็น secret ใน Cloudflare)
3. deploy
   ```
   npx wrangler deploy
   ```
4. เชื่อมกับ Claude Code
   ```
   claude mcp add --transport http --scope user linkedin-mcp <URL>/mcp --header "Authorization: Bearer <MCP_TOKEN>"
   ```

## นำเข้าไฟล์ export จาก LinkedIn

ขอ export ที่ Settings → Data privacy → Get a copy of your data และเลือก Connections (แบบ Basic ไม่มี Connections)

```
npm run import -- connections  "<path>\Connections.csv"
npm run import -- invitations  "<path>\Invitations.csv"
npm run import -- profile      "<path>\Profile.csv"
```

การนำเข้าซ้ำปลอดภัย ระบบจะไม่สร้างแถวซ้ำ และจะบันทึกการเปลี่ยนบริษัทหรือตำแหน่งเป็น note อัตโนมัติ

## Tools ที่มี

| กลุ่ม | Tools |
|---|---|
| เครือข่าย | `search_connections`, `get_contact`, `tag_contact`, `add_note`, `set_followup`, `due_followups`, `complete_followup`, `draft_outreach`, `find_warm_intro`, `list_invitations` |
| งาน | `set_targets`, `get_targets`, `ingest_jobs`, `list_jobs`, `save_matches`, `track_application`, `list_applications`, `skill_gap` |
| ระบบ | `ping` |

## หลักการ

- **ไม่ส่งข้อความหรือโพสต์เอง** `draft_outreach` ได้แค่ร่างข้อความ ผู้ใช้ต้องคัดลอกไปส่งเอง
- **ทุก tool ถูกบันทึกลง `audit_log`**
- **ไม่เก็บข้อมูลที่ไม่จำเป็น** เช่น เบอร์โทรและอีเมลใน resume
- **token ไม่อยู่ในโค้ด** ตั้งเป็น secret ของ Worker และเก็บใน `.env` ซึ่งถูก ignore โดย git

## สิ่งที่ยังไม่มี

- โพสต์ไป LinkedIn (รอ LinkedIn Developer App)
- Company Page (รอ Community Management API)
- งานอัตโนมัติตามเวลา
