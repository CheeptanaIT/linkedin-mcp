-- 003: รูปประกอบโพสต์ (ลบทิ้งหลังเผยแพร่แล้ว)
CREATE TABLE IF NOT EXISTS post_media (post_id INTEGER PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE, mime TEXT NOT NULL, size INTEGER NOT NULL, data_b64 TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
