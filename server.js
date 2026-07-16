const express = require("express");
const { createClient } = require("@libsql/client");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "12mb" })); // bumped for photo uploads
app.use(express.static(path.join(__dirname, "public")));

// ─── Turso Database Setup ────────────────────────────────────
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ─── Cloudflare R2 Setup ─────────────────────────────────────
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const R2_BUCKET = process.env.R2_BUCKET_NAME;

function uid() {
  return crypto.randomBytes(6).toString("hex");
}

// ─── Init tables and defaults on startup ─────────────────────
async function initDb() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS clubs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    )`,
    `CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      clubs TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS logs (
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
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  ], "write");

  // Add photo columns to logs table if they don't exist yet
  // (safe to run every startup — will silently no-op if columns exist)
  try {
    await db.execute("ALTER TABLE logs ADD COLUMN selfieKey TEXT");
  } catch (e) { /* column already exists */ }
  try {
    await db.execute("ALTER TABLE logs ADD COLUMN eventPhotoKey TEXT");
  } catch (e) { /* column already exists */ }

  // Seed default clubs if empty
  const clubCountRes = await db.execute("SELECT COUNT(*) as c FROM clubs");
  const clubCount = Number(clubCountRes.rows[0].c);
  if (clubCount === 0) {
    await db.batch([
      { sql: "INSERT INTO clubs (id, name) VALUES (?, ?)", args: [uid(), "Key Club"] },
      { sql: "INSERT INTO clubs (id, name) VALUES (?, ?)", args: [uid(), "Student Council"] },
      { sql: "INSERT INTO clubs (id, name) VALUES (?, ?)", args: [uid(), "IB Club"] },
      { sql: "INSERT INTO clubs (id, name) VALUES (?, ?)", args: [uid(), "Hope"] },
    ], "write");
  }

  // Seed default PINs if empty
  const settingsCountRes = await db.execute("SELECT COUNT(*) as c FROM settings");
  const settingsCount = Number(settingsCountRes.rows[0].c);
  if (settingsCount === 0) {
    await db.batch([
      { sql: "INSERT INTO settings (key, value) VALUES (?, ?)", args: ["adminPin", "1234"] },
      { sql: "INSERT INTO settings (key, value) VALUES (?, ?)", args: ["officerPin", "0000"] },
    ], "write");
  }
}

// ─── API Routes ──────────────────────────────────────────────

// Get all data
app.get("/api/data", async (req, res) => {
  try {
    const [clubsRes, eventsRes, studentsRes, logsRes] = await Promise.all([
      db.execute("SELECT * FROM clubs"),
      db.execute("SELECT * FROM events"),
      db.execute("SELECT * FROM students"),
      db.execute("SELECT * FROM logs ORDER BY checkIn DESC"),
    ]);

    const clubs = clubsRes.rows.map(r => ({ id: r.id, name: r.name }));
    const events = eventsRes.rows.map(e => ({
      id: e.id,
      name: e.name,
      clubs: String(e.clubs).split(",").map(c => c.trim()),
      active: Number(e.active) === 1,
      created: e.created,
    }));
    const students = studentsRes.rows.map(r => ({ id: r.id, name: r.name }));
    const logs = logsRes.rows.map(l => ({
      id: l.id,
      studentName: l.studentName,
      studentId: l.studentId,
      club: l.club,
      eventName: l.eventName,
      eventId: l.eventId || "",
      checkIn: l.checkIn,
      checkOut: l.checkOut || "",
      bulkEntry: Number(l.bulkEntry) === 1,
      manualEdit: Number(l.manualEdit) === 1,
      hasSelfie: !!l.selfieKey,
      hasEventPhoto: !!l.eventPhotoKey,
    }));

    res.json({ clubs, events, students, logs });
  } catch (e) {
    console.error("GET /api/data error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Clubs ──
app.post("/api/clubs", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    const existing = await db.execute({
      sql: "SELECT * FROM clubs WHERE LOWER(name) = LOWER(?)",
      args: [name],
    });
    if (existing.rows.length) return res.status(400).json({ error: "Club already exists" });
    const id = uid();
    await db.execute({
      sql: "INSERT INTO clubs (id, name) VALUES (?, ?)",
      args: [id, name],
    });
    res.json({ success: true, club: { id, name } });
  } catch (e) {
    console.error("POST /api/clubs error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/clubs/:id", async (req, res) => {
  try {
    await db.execute({
      sql: "DELETE FROM clubs WHERE id = ?",
      args: [req.params.id],
    });
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/clubs error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Events ──
app.post("/api/events", async (req, res) => {
  try {
    const { name, clubs } = req.body;
    if (!name || !clubs || clubs.length === 0) {
      return res.status(400).json({ error: "Name and clubs required" });
    }
    const id = uid();
    const clubsStr = clubs.join(",");
    const now = new Date().toISOString();
    await db.execute({
      sql: "INSERT INTO events (id, name, clubs, active, created) VALUES (?, ?, ?, 1, ?)",
      args: [id, name, clubsStr, now],
    });
    res.json({ success: true, event: { id, name, clubs, active: true, created: now } });
  } catch (e) {
    console.error("POST /api/events error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/events/:id/toggle", async (req, res) => {
  try {
    const evtRes = await db.execute({
      sql: "SELECT active FROM events WHERE id = ?",
      args: [req.params.id],
    });
    if (!evtRes.rows.length) return res.status(404).json({ error: "Event not found" });
    const currentlyActive = Number(evtRes.rows[0].active) === 1;
    await db.execute({
      sql: "UPDATE events SET active = ? WHERE id = ?",
      args: [currentlyActive ? 0 : 1, req.params.id],
    });
    res.json({ success: true });
  } catch (e) {
    console.error("PUT /api/events/toggle error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/events/:id", async (req, res) => {
  try {
    await db.execute({
      sql: "DELETE FROM events WHERE id = ?",
      args: [req.params.id],
    });
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/events error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Check In ──
app.post("/api/checkin", async (req, res) => {
  try {
    const { studentName, studentId, clubs, eventName, eventId } = req.body;
    if (!studentName || !studentId || !clubs || clubs.length === 0 || !eventName) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const existingStudent = await db.execute({
      sql: "SELECT id FROM students WHERE id = ?",
      args: [studentId],
    });
    if (!existingStudent.rows.length) {
      await db.execute({
        sql: "INSERT INTO students (id, name) VALUES (?, ?)",
        args: [studentId, studentName],
      });
    }

    const newLogs = [];
    const dupes = [];
    const now = new Date().toISOString();

    for (const club of clubs) {
      const already = await db.execute({
        sql: "SELECT id FROM logs WHERE studentId = ? AND eventName = ? AND club = ? AND (checkOut IS NULL OR checkOut = '')",
        args: [studentId, eventName, club],
      });
      if (already.rows.length) {
        dupes.push(club);
        continue;
      }
      const id = uid();
      await db.execute({
        sql: "INSERT INTO logs (id, studentName, studentId, club, eventName, eventId, checkIn, checkOut, bulkEntry, manualEdit) VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, 0)",
        args: [id, studentName, studentId, club, eventName, eventId || "", now],
      });
      newLogs.push({
        id, studentName, studentId, club, eventName,
        eventId: eventId || "",
        checkIn: now, checkOut: "",
        bulkEntry: false, manualEdit: false,
        hasSelfie: false, hasEventPhoto: false,
      });
    }

    res.json({ success: true, newLogs, dupes });
  } catch (e) {
    console.error("POST /api/checkin error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Check Out ──
app.post("/api/checkout", async (req, res) => {
  try {
    const { logIds } = req.body;
    const now = new Date().toISOString();
    const results = [];
    for (const id of logIds) {
      await db.execute({
        sql: "UPDATE logs SET checkOut = ? WHERE id = ?",
        args: [now, id],
      });
      results.push({ id, checkOut: now });
    }
    res.json({ success: true, results });
  } catch (e) {
    console.error("POST /api/checkout error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/force-checkout", async (req, res) => {
  try {
    const { clubFilter } = req.body;
    const now = new Date().toISOString();
    let result;
    if (clubFilter && clubFilter !== "all") {
      result = await db.execute({
        sql: "UPDATE logs SET checkOut = ? WHERE (checkOut IS NULL OR checkOut = '') AND club = ?",
        args: [now, clubFilter],
      });
    } else {
      result = await db.execute({
        sql: "UPDATE logs SET checkOut = ? WHERE (checkOut IS NULL OR checkOut = '')",
        args: [now],
      });
    }
    res.json({ success: true, count: Number(result.rowsAffected || 0) });
  } catch (e) {
    console.error("POST /api/force-checkout error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Edit / Delete Logs ──
app.put("/api/logs/:id", async (req, res) => {
  try {
    const { hours } = req.body;
    const logRes = await db.execute({
      sql: "SELECT checkIn FROM logs WHERE id = ?",
      args: [req.params.id],
    });
    if (!logRes.rows.length) return res.status(404).json({ error: "Log not found" });
    const checkOut = new Date(new Date(logRes.rows[0].checkIn).getTime() + hours * 3600000).toISOString();
    await db.execute({
      sql: "UPDATE logs SET checkOut = ?, manualEdit = 1 WHERE id = ?",
      args: [checkOut, req.params.id],
    });
    res.json({ success: true, checkOut });
  } catch (e) {
    console.error("PUT /api/logs error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/logs/:id", async (req, res) => {
  try {
    await db.execute({
      sql: "DELETE FROM logs WHERE id = ?",
      args: [req.params.id],
    });
    res.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/logs error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Bulk Hours ──
app.post("/api/bulk", async (req, res) => {
  try {
    const { club, eventName, hours, date, students } = req.body;
    if (!club || !eventName || !hours || !students || students.length === 0) {
      return res.status(400).json({ error: "Missing fields" });
    }
    const baseTime = new Date(date + "T09:00:00");
    const endTime = new Date(baseTime.getTime() + hours * 3600000);

    const statements = [];
    for (const s of students) {
      statements.push({
        sql: "INSERT OR IGNORE INTO students (id, name) VALUES (?, ?)",
        args: [s.id, s.name],
      });
      statements.push({
        sql: "INSERT INTO logs (id, studentName, studentId, club, eventName, eventId, checkIn, checkOut, bulkEntry, manualEdit) VALUES (?, ?, ?, ?, ?, '', ?, ?, 1, 0)",
        args: [uid(), s.name, s.id, club, eventName, baseTime.toISOString(), endTime.toISOString()],
      });
    }
    await db.batch(statements, "write");

    res.json({ success: true, count: students.length });
  } catch (e) {
    console.error("POST /api/bulk error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Roster Upload ──
app.post("/api/roster", async (req, res) => {
  try {
    const { students } = req.body;
    if (!Array.isArray(students) || students.length === 0) {
      return res.status(400).json({ error: "No students provided" });
    }
    const statements = [];
    let count = 0;
    for (const s of students) {
      if (s && s.id && s.name) {
        statements.push({
          sql: "INSERT OR REPLACE INTO students (id, name) VALUES (?, ?)",
          args: [String(s.id).trim(), String(s.name).trim()],
        });
        count++;
      }
    }
    if (statements.length) await db.batch(statements, "write");
    res.json({ success: true, count });
  } catch (e) {
    console.error("POST /api/roster error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Photo Upload (called after checkout) ──
// Body: { logId, selfieBase64, eventPhotoBase64 }
// Each base64 field is a data URL like "data:image/jpeg;base64,..."
app.post("/api/photos", async (req, res) => {
  try {
    const { logId, selfieBase64, eventPhotoBase64 } = req.body;
    if (!logId) return res.status(400).json({ error: "logId required" });

    // Confirm the log exists (and belongs to the correct student in principle,
    // though we don't have auth on the check-in side, so this is best-effort)
    const logRes = await db.execute({
      sql: "SELECT studentId FROM logs WHERE id = ?",
      args: [logId],
    });
    if (!logRes.rows.length) return res.status(404).json({ error: "Log not found" });
    const studentId = logRes.rows[0].studentId;

    const uploadOne = async (dataUrl, label) => {
      if (!dataUrl) return null;
      // Parse data URL: "data:image/jpeg;base64,XXXX"
      const match = /^data:(image\/[a-z]+);base64,(.+)$/.exec(dataUrl);
      if (!match) throw new Error("Invalid image data for " + label);
      const contentType = match[1];
      const buffer = Buffer.from(match[2], "base64");

      // Reject anything absurd (should be pre-compressed to <500KB, allow up to 5MB safety)
      if (buffer.length > 5 * 1024 * 1024) {
        throw new Error(label + " image too large");
      }

      const ext = contentType.split("/")[1] || "jpg";
      const key = `${studentId}/${logId}-${label}-${uid()}.${ext}`;

      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }));

      return key;
    };

    const selfieKey = await uploadOne(selfieBase64, "selfie");
    const eventPhotoKey = await uploadOne(eventPhotoBase64, "event");

    // Update the log row with whichever keys we got
    const updates = [];
    const args = [];
    if (selfieKey) { updates.push("selfieKey = ?"); args.push(selfieKey); }
    if (eventPhotoKey) { updates.push("eventPhotoKey = ?"); args.push(eventPhotoKey); }
    if (updates.length) {
      args.push(logId);
      await db.execute({
        sql: `UPDATE logs SET ${updates.join(", ")} WHERE id = ?`,
        args,
      });
    }

    res.json({ success: true, uploaded: { selfie: !!selfieKey, eventPhoto: !!eventPhotoKey } });
  } catch (e) {
    console.error("POST /api/photos error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Get signed URL to view a photo (Officer/Admin) ──
// Body: { pin } — must match officer or admin PIN
app.post("/api/photo-url/:logId/:kind", async (req, res) => {
  try {
    const { pin } = req.body;
    const { logId, kind } = req.params; // kind = "selfie" or "event"

    // Verify pin (either officer or admin)
    const pinRes = await db.execute({
      sql: "SELECT value FROM settings WHERE key IN ('adminPin', 'officerPin')",
    });
    const validPins = pinRes.rows.map(r => r.value);
    if (!pin || !validPins.includes(pin)) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const column = kind === "selfie" ? "selfieKey" : "eventPhotoKey";
    const logRes = await db.execute({
      sql: `SELECT ${column} as k FROM logs WHERE id = ?`,
      args: [logId],
    });
    if (!logRes.rows.length || !logRes.rows[0].k) {
      return res.status(404).json({ error: "No photo" });
    }
    const key = logRes.rows[0].k;

    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
      { expiresIn: 300 } // 5 minute view window
    );
    res.json({ success: true, url });
  } catch (e) {
    console.error("POST /api/photo-url error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Settings ──
app.post("/api/verify-pin", async (req, res) => {
  try {
    const { type, pin } = req.body;
    const key = type === "admin" ? "adminPin" : "officerPin";
    const rowRes = await db.execute({
      sql: "SELECT value FROM settings WHERE key = ?",
      args: [key],
    });
    const row = rowRes.rows[0];
    res.json({ success: !!(row && row.value === pin) });
  } catch (e) {
    console.error("POST /api/verify-pin error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/change-pin", async (req, res) => {
  try {
    const { type, newPin } = req.body;
    const key = type === "admin" ? "adminPin" : "officerPin";
    await db.execute({
      sql: "UPDATE settings SET value = ? WHERE key = ?",
      args: [newPin, key],
    });
    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/change-pin error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Reset ──
app.post("/api/reset-all", async (req, res) => {
  try {
    await db.batch([
      "DELETE FROM logs",
      "DELETE FROM events",
      "DELETE FROM students",
      "DELETE FROM clubs",
      { sql: "INSERT INTO clubs (id, name) VALUES (?, ?)", args: [uid(), "Key Club"] },
      { sql: "INSERT INTO clubs (id, name) VALUES (?, ?)", args: [uid(), "Student Council"] },
      { sql: "INSERT INTO clubs (id, name) VALUES (?, ?)", args: [uid(), "IB Club"] },
      { sql: "INSERT INTO clubs (id, name) VALUES (?, ?)", args: [uid(), "Hope"] },
    ], "write");
    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/reset-all error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/clear-logs", async (req, res) => {
  try {
    await db.execute("DELETE FROM logs");
    res.json({ success: true });
  } catch (e) {
    console.error("POST /api/clear-logs error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Serve app ──
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Startup ──
const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Service Hours Tracker running on port " + PORT);
    });
  })
  .catch(err => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
