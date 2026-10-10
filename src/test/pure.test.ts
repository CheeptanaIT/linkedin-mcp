import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConnections, parseCsv } from "../csv.js";
import { dedupeKey } from "../jobs.js";
import { companiesMatch, normalizeCompany } from "../intro.js";
import { parseInvitations, parseProfile } from "../imports.js";

test("parseCsv handles quoted commas, escaped quotes, and CRLF", () => {
  const rows = parseCsv('a,"b, c","say ""hi"""\r\n1,2,3');
  assert.deepEqual(rows, [
    ["a", "b, c", 'say "hi"'],
    ["1", "2", "3"],
  ]);
});

test("parseConnections skips LinkedIn preamble and keeps the last duplicate", () => {
  const text = [
    "Notes:",
    '"When exporting your connection data, you may notice..."',
    "",
    "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
    'Anan,Test,https://example.test/a,,"Acme, Co.",Engineer,21 Oct 2025',
    "Anan,Test,https://example.test/a,,Globex,Lead,22 Oct 2025",
    ",,,,,,",
  ].join("\n");
  const rows = parseConnections(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company, "Globex");
  assert.equal(rows[0].position, "Lead");
});

test("parseConnections rejects a file without the header", () => {
  assert.throws(() => parseConnections("hello,world\n1,2"), /First Name/);
});

test("dedupeKey ignores www and trailing slash in URLs", () => {
  const a = dedupeKey({ source: "x", title: "T", url: "https://www.example.test/jobs/1/" });
  const b = dedupeKey({ source: "y", title: "Other", url: "https://example.test/jobs/1" });
  assert.equal(a, b);
});

test("dedupeKey falls back to company, title and location without a URL", () => {
  const a = dedupeKey({ source: "x", title: "Help Desk", company: " MFEC ", location: "Bangkok" });
  const b = dedupeKey({ source: "y", title: "help desk", company: "mfec", location: "BANGKOK" });
  assert.equal(a, b);
});

test("normalizeCompany strips legal suffixes in English and Thai", () => {
  assert.equal(normalizeCompany("Kyndryl (Thailand) Co., Ltd."), "kyndryl");
  assert.equal(normalizeCompany("บริษัท ซีพี ออลล์ จำกัด (มหาชน)").includes("จำกัด"), false);
  assert.equal(normalizeCompany(null), "");
});

test("companiesMatch accepts exact matches and whole-word prefixes only", () => {
  assert.equal(companiesMatch("kyndryl", "kyndryl"), true);
  assert.equal(companiesMatch("scb", "scb bank"), true);
  assert.equal(companiesMatch("kyndry", "kyndryl"), false);
  assert.equal(companiesMatch("it", "itd"), false);
  assert.equal(companiesMatch("", "kyndryl"), false);
});

test("parseInvitations keeps the other party's URL by direction", () => {
  const text = [
    "From,To,Sent At,Message,Direction,inviterProfileUrl,inviteeProfileUrl",
    "Me,Them,10/1/26,,OUTGOING,https://linkedin.example/me,https://linkedin.example/them",
    "Them,Me,10/2/26,hi,INCOMING,https://linkedin.example/them,https://linkedin.example/me",
  ].join("\n");
  const rows = parseInvitations(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].direction, "OUTGOING");
  assert.equal(rows[0].other_profile_url, "https://linkedin.example/them");
  assert.equal(rows[1].direction, "INCOMING");
  assert.equal(rows[1].other_profile_url, "https://linkedin.example/them");
  assert.equal(rows[1].message, "hi");
});

test("parseProfile maps the header to the first data row and turns blanks into null", () => {
  const text = "First Name,Last Name,Headline,Summary\nCheeptana,Yenlab,,Hello";
  const p = parseProfile(text);
  assert.equal(p["First Name"], "Cheeptana");
  assert.equal(p["Headline"], null);
  assert.equal(p["Summary"], "Hello");
});
