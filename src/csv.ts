export interface ConnectionRow {
  first_name: string;
  last_name: string;
  profile_url: string;
  company: string | null;
  position: string | null;
  connected_on: string | null;
}

// parser CSV ตามมาตรฐาน RFC 4180: รองรับ field ที่มี comma, newline และเครื่องหมาย "
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// อ่าน Connections.csv ของ LinkedIn
// ไฟล์มีหมายเหตุหลายบรรทัดก่อนหัวตาราง จึงต้องหาบรรทัด "First Name," ก่อน
export function parseConnections(text: string): ConnectionRow[] {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/);
  const headerIdx = lines.findIndex((l) => l.startsWith("First Name,"));
  if (headerIdx < 0) {
    throw new Error("ไม่พบหัวตาราง 'First Name' ในไฟล์ Connections.csv");
  }

  const rows = parseCsv(lines.slice(headerIdx).join("\n"));
  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const get = (row: string[], name: string) => {
    const i = col(name);
    const v = i >= 0 ? (row[i] ?? "").trim() : "";
    return v === "" ? null : v;
  };

  // ใช้ URL เป็นคีย์ และตัดรายการซ้ำในไฟล์เดียวกันออก
  const byUrl = new Map<string, ConnectionRow>();
  for (const row of rows.slice(1)) {
    const url = get(row, "URL");
    if (!url) continue;
    byUrl.set(url, {
      first_name: get(row, "First Name") ?? "",
      last_name: get(row, "Last Name") ?? "",
      profile_url: url,
      company: get(row, "Company"),
      position: get(row, "Position"),
      connected_on: get(row, "Connected On"),
    });
  }
  return [...byUrl.values()];
}
