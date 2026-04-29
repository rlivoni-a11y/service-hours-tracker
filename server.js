const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Database Setup ──────────────────────────────────────────
const DB_PATH = path.join(__dirname, ".data", "hours.db");
const fs = require("fs");
if (!fs.existsSync(path.join(__dirname, ".data"))) {
  fs.mkdirSync(path.join(__dirname, ".data"));
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS clubs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    clubs TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created TEXT
  );
  CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY,
    studentName TEXT NOT NULL,
    studentId TEXT NOT NULL,
    club TEXT NOT NULL,
    eventName TEXT NOT NULL,
    eventId TEXT,
    checkIn TEXT NOT NULL,
    checkOut TEXT,
    bulkEntry INTEGER DEFAULT 0,
    manualEdit INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Seed defaults if empty
const clubCount = db.prepare("SELECT COUNT(*) as c FROM clubs").get().c;
if (clubCount === 0) {
  const insert = db.prepare("INSERT INTO clubs (id, name) VALUES (?, ?)");
  insert.run(uid(), "Key Club");
  insert.run(uid(), "Student Council");
  insert.run(uid(), "IB Club");
  insert.run(uid(), "Hope");
}

const settingsCount = db.prepare("SELECT COUNT(*) as c FROM settings").get().c;
if (settingsCount === 0) {
  const insert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
  insert.run("adminPin", "1234");
  insert.run("officerPin", "0000");
}

function uid() {
  return crypto.randomBytes(6).toString("hex");
}

// ─── API Routes ──────────────────────────────────────────────

// Get all data
app.get("/api/data", (req, res) => {
  const clubs = db.prepare("SELECT * FROM clubs").all();
  const eventsRaw = db.prepare("SELECT * FROM events").all();
  const events = eventsRaw.map(e => ({
    ...e,
    clubs: e.clubs.split(",").map(c => c.trim()),
    active: e.active === 1,
  }));
  const students = db.prepare("SELECT * FROM students").all();
  const logs = db.prepare("SELECT * FROM logs ORDER BY checkIn DESC").all().map(l => ({
    ...l,
    bulkEntry: l.bulkEntry === 1,
    manualEdit: l.manualEdit === 1,
    checkOut: l.checkOut || "",
  }));
  res.json({ clubs, events, students, logs });
});

// ── Clubs ──
app.post("/api/clubs", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });
  const existing = db.prepare("SELECT * FROM clubs WHERE LOWER(name) = LOWER(?)").get(name);
  if (existing) return res.status(400).json({ error: "Club already exists" });
  const id = uid();
  db.prepare("INSERT INTO clubs (id, name) VALUES (?, ?)").run(id, name);
  res.json({ success: true, club: { id, name } });
});

app.delete("/api/clubs/:id", (req, res) => {
  db.prepare("DELETE FROM clubs WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ── Events ──
app.post("/api/events", (req, res) => {
  const { name, clubs } = req.body;
  if (!name || !clubs || clubs.length === 0) return res.status(400).json({ error: "Name and clubs required" });
  const id = uid();
  const clubsStr = clubs.join(",");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO events (id, name, clubs, active, created) VALUES (?, ?, ?, 1, ?)").run(id, name, clubsStr, now);
  res.json({ success: true, event: { id, name, clubs, active: true, created: now } });
});

app.put("/api/events/:id/toggle", (req, res) => {
  const evt = db.prepare("SELECT active FROM events WHERE id = ?").get(req.params.id);
  if (!evt) return res.status(404).json({ error: "Event not found" });
  db.prepare("UPDATE events SET active = ? WHERE id = ?").run(evt.active ? 0 : 1, req.params.id);
  res.json({ success: true });
});

app.delete("/api/events/:id", (req, res) => {
  db.prepare("DELETE FROM events WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ── Check In ──
app.post("/api/checkin", (req, res) => {
  const { studentName, studentId, clubs, eventName, eventId } = req.body;
  if (!studentName || !studentId || !clubs || clubs.length === 0 || !eventName) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Register student if new
  const existing = db.prepare("SELECT * FROM students WHERE id = ?").get(studentId);
  if (!existing) {
    db.prepare("INSERT INTO students (id, name) VALUES (?, ?)").run(studentId, studentName);
  }

  const newLogs = [];
  const dupes = [];
  const now = new Date().toISOString();

  clubs.forEach(club => {
    const already = db.prepare(
      "SELECT * FROM logs WHERE studentId = ? AND eventName = ? AND club = ? AND (checkOut IS NULL OR checkOut = '')"
    ).get(studentId, eventName, club);
    if (already) { dupes.push(club); return; }

    const id = uid();
    db.prepare(
      "INSERT INTO logs (id, studentName, studentId, club, eventName, eventId, checkIn, checkOut, bulkEntry, manualEdit) VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, 0)"
    ).run(id, studentName, studentId, club, eventName, eventId || "", now);
    newLogs.push({ id, studentName, studentId, club, eventName, eventId: eventId || "", checkIn: now, checkOut: "", bulkEntry: false, manualEdit: false });
  });

  res.json({ success: true, newLogs, dupes });
});

// ── Check Out ──
app.post("/api/checkout", (req, res) => {
  const { logIds } = req.body;
  const now = new Date().toISOString();
  const results = [];
  const stmt = db.prepare("UPDATE logs SET checkOut = ? WHERE id = ?");
  logIds.forEach(id => {
    stmt.run(now, id);
    results.push({ id, checkOut: now });
  });
  res.json({ success: true, results });
});

app.post("/api/force-checkout", (req, res) => {
  const { clubFilter } = req.body;
  const now = new Date().toISOString();
  let result;
  if (clubFilter && clubFilter !== "all") {
    result = db.prepare("UPDATE logs SET checkOut = ? WHERE (checkOut IS NULL OR checkOut = '') AND club = ?").run(now, clubFilter);
  } else {
    result = db.prepare("UPDATE logs SET checkOut = ? WHERE (checkOut IS NULL OR checkOut = '')").run(now);
  }
  res.json({ success: true, count: result.changes });
});

// ── Edit / Delete Logs ──
app.put("/api/logs/:id", (req, res) => {
  const { hours } = req.body;
  const log = db.prepare("SELECT checkIn FROM logs WHERE id = ?").get(req.params.id);
  if (!log) return res.status(404).json({ error: "Log not found" });
  const checkOut = new Date(new Date(log.checkIn).getTime() + hours * 3600000).toISOString();
  db.prepare("UPDATE logs SET checkOut = ?, manualEdit = 1 WHERE id = ?").run(checkOut, req.params.id);
  res.json({ success: true, checkOut });
});

app.delete("/api/logs/:id", (req, res) => {
  db.prepare("DELETE FROM logs WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// ── Bulk Hours ──
app.post("/api/bulk", (req, res) => {
  const { club, eventName, hours, date, students } = req.body;
  if (!club || !eventName || !hours || !students || students.length === 0) {
    return res.status(400).json({ error: "Missing fields" });
  }
  const baseTime = new Date(date + "T09:00:00");
  const endTime = new Date(baseTime.getTime() + hours * 3600000);
  const insertLog = db.prepare(
    "INSERT INTO logs (id, studentName, studentId, club, eventName, eventId, checkIn, checkOut, bulkEntry, manualEdit) VALUES (?, ?, ?, ?, ?, '', ?, ?, 1, 0)"
  );
  const insertStudent = db.prepare("INSERT OR IGNORE INTO students (id, name) VALUES (?, ?)");

  const transaction = db.transaction(() => {
    students.forEach(s => {
      insertStudent.run(s.id, s.name);
      insertLog.run(uid(), s.name, s.id, club, eventName, baseTime.toISOString(), endTime.toISOString());
    });
  });
  transaction();

  res.json({ success: true, count: students.length });
});
// ── Roster Upload ──
app.post("/api/roster", (req, res) => {
  const { students } = req.body;
  if (!Array.isArray(students) || students.length === 0) {
    return res.status(400).json({ error: "No students provided" });
  }
  const insertStudent = db.prepare("INSERT OR REPLACE INTO students (id, name) VALUES (?, ?)");
  let count = 0;
  const transaction = db.transaction(() => {
    students.forEach(s => {
      if (s && s.id && s.name) {
        insertStudent.run(String(s.id).trim(), String(s.name).trim());
        count++;
      }
    });
  });
  transaction();
  res.json({ success: true, count });
});
// ── Settings ──
app.post("/api/verify-pin", (req, res) => {
  const { type, pin } = req.body;
  const key = type === "admin" ? "adminPin" : "officerPin";
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  res.json({ success: row && row.value === pin });
});

app.post("/api/change-pin", (req, res) => {
  const { type, newPin } = req.body;
  const key = type === "admin" ? "adminPin" : "officerPin";
  db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(newPin, key);
  res.json({ success: true });
});

// ── Reset ──
app.post("/api/reset-all", (req, res) => {
  db.exec("DELETE FROM logs");
  db.exec("DELETE FROM events");
  db.exec("DELETE FROM students");
  db.exec("DELETE FROM clubs");
  const insert = db.prepare("INSERT INTO clubs (id, name) VALUES (?, ?)");
  insert.run(uid(), "Key Club");
  insert.run(uid(), "Student Council");
  insert.run(uid(), "IB Club");
  insert.run(uid(), "Hope");
  res.json({ success: true });
});

app.post("/api/clear-logs", (req, res) => {
  db.exec("DELETE FROM logs");
  res.json({ success: true });
});

// ── Serve app ──
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Service Hours Tracker running on port " + PORT);
});
