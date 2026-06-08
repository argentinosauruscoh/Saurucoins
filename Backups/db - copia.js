// db.js — Motor de base de datos Saurucoins
// Usa sql.js (SQLite en WebAssembly, sin compilación nativa)
// El archivo puntos.db se guarda en disco y persiste entre sesiones.

import initSqlJs from "sql.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, "puntos.db");

// ── CONFIG ──────────────────────────────────────────────────────
export const CONFIG = {
  PUNTOS_POR_MENSAJE:   1,    // por cada mensaje en el chat
  COOLDOWN_MENSAJE_SEG: 60,   // 1 minuto entre mensajes que suman puntos (anti-spam)
  PUNTOS_PASIVOS:       10,   // puntos por presencia activa
  INTERVALO_PASIVO_MIN: 30,   // cada 30 minutos
  VENTANA_ACTIVO_MIN:   30,   // debe haber chateado en los últimos 30 min para cobrar
  BONUS_PARTICIPAR:     2,    // por apostar o votar (solo participar)
  APUESTA_MIN:          10,   // mínimo de puntos para apostar
  APUESTA_MAX:          50,   // máximo de puntos para apostar
};

let SQL = null;
let db  = null;

// ── INIT ────────────────────────────────────────────────────────
export async function initDB() {
  SQL = await initSqlJs();

  // Cargar DB existente o crear nueva
  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
    console.log("📂 Base de datos cargada:", DB_PATH);
  } else {
    db = new SQL.Database();
    console.log("🆕 Base de datos nueva creada:", DB_PATH);
  }

  crearTablas();
  guardarDB(); // guardar estructura inicial si es nueva
  return db;
}

// Guardar DB en disco (llamar después de cada escritura)
export function guardarDB() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── TABLAS ──────────────────────────────────────────────────────
function crearTablas() {
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      nombre        TEXT PRIMARY KEY,
      puntos        INTEGER DEFAULT 0,
      ultimo_chat   INTEGER DEFAULT 0,   -- timestamp unix ms del último mensaje
      ultimo_pago   INTEGER DEFAULT 0,   -- timestamp unix ms del último pago pasivo
      total_apuestas INTEGER DEFAULT 0,
      total_ganadas  INTEGER DEFAULT 0,
      creado_en     INTEGER DEFAULT (strftime('%s','now') * 1000)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS historial (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre     TEXT NOT NULL,
      delta      INTEGER NOT NULL,         -- positivo = ganó, negativo = gastó
      motivo     TEXT NOT NULL,            -- 'mensaje' | 'pasivo' | 'apuesta_ganada' | 'apuesta_perdida' | 'bonus_participar' | 'ajuste_manual'
      puntos_new INTEGER NOT NULL,
      ts         INTEGER DEFAULT (strftime('%s','now') * 1000)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );
  `);

  console.log("✅ Tablas listas");
}

// ── HELPERS INTERNOS ────────────────────────────────────────────
function ahora() { return Date.now(); }

function getUsuario(nombre) {
  const rows = db.exec(
    "SELECT * FROM usuarios WHERE nombre = ?", [nombre]
  );
  if (!rows.length || !rows[0].values.length) return null;
  const cols = rows[0].columns;
  const vals = rows[0].values[0];
  return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
}

function upsertUsuario(nombre) {
  db.run(
    "INSERT OR IGNORE INTO usuarios (nombre) VALUES (?)", [nombre]
  );
  return getUsuario(nombre);
}

function agregarPuntos(nombre, delta, motivo) {
  upsertUsuario(nombre);
  db.run(
    "UPDATE usuarios SET puntos = MAX(0, puntos + ?) WHERE nombre = ?",
    [delta, nombre]
  );
  const u = getUsuario(nombre);
  db.run(
    "INSERT INTO historial (nombre, delta, motivo, puntos_new) VALUES (?,?,?,?)",
    [nombre, delta, motivo, u.puntos]
  );
  guardarDB();
  return u.puntos;
}

// ── API PÚBLICA ─────────────────────────────────────────────────

/**
 * Registrar un mensaje de chat.
 * Suma PUNTOS_POR_MENSAJE si pasó el cooldown.
 * Actualiza ultimo_chat (para presencia activa).
 * Devuelve { sumado, puntos } — sumado=true si efectivamente ganó puntos.
 */
export function registrarMensaje(nombre) {
  if (!db) return { sumado: false, puntos: 0 };
  upsertUsuario(nombre);
  const u = getUsuario(nombre);
  const ts = ahora();
  const cooldownMs = CONFIG.COOLDOWN_MENSAJE_SEG * 1000;
  const sumado = (ts - u.ultimo_chat) >= cooldownMs;

  if (sumado) {
    agregarPuntos(nombre, CONFIG.PUNTOS_POR_MENSAJE, "mensaje");
  }

  db.run("UPDATE usuarios SET ultimo_chat = ? WHERE nombre = ?", [ts, nombre]);
  guardarDB();

  const final = getUsuario(nombre);
  return { sumado, puntos: final.puntos };
}

/**
 * Pago pasivo: se llama cada INTERVALO_PASIVO_MIN minutos.
 * Paga a todos los usuarios activos (que chatearon en los últimos VENTANA_ACTIVO_MIN minutos).
 * Devuelve lista de usuarios pagados.
 */
export function pagarPasivos() {
  if (!db) return [];
  const ts      = ahora();
  const ventana = CONFIG.VENTANA_ACTIVO_MIN * 60 * 1000;
  const desde   = ts - ventana;

  const rows = db.exec(
    "SELECT nombre FROM usuarios WHERE ultimo_chat >= ?", [desde]
  );
  if (!rows.length) return [];

  const pagados = [];
  for (const [nombre] of rows[0].values) {
    agregarPuntos(nombre, CONFIG.PUNTOS_PASIVOS, "pasivo");
    db.run("UPDATE usuarios SET ultimo_pago = ? WHERE nombre = ?", [ts, nombre]);
    pagados.push(nombre);
  }
  guardarDB();
  console.log(`💰 Pago pasivo: ${pagados.length} usuarios recibieron ${CONFIG.PUNTOS_PASIVOS} pts`);
  return pagados;
}

/**
 * Consultar puntos de un usuario.
 */
export function getPuntos(nombre) {
  if (!db) return 0;
  upsertUsuario(nombre);
  return getUsuario(nombre).puntos;
}

/**
 * Descontar puntos para apostar.
 * Devuelve { ok, puntos } — ok=false si no tiene suficiente.
 */
export function descontarApuesta(nombre, monto) {
  if (!db) return { ok: false, puntos: 0 };
  upsertUsuario(nombre);
  const u = getUsuario(nombre);
  if (u.puntos < monto) return { ok: false, puntos: u.puntos };
  agregarPuntos(nombre, -monto, "apuesta_colocada");
  db.run(
    "UPDATE usuarios SET total_apuestas = total_apuestas + 1 WHERE nombre = ?",
    [nombre]
  );
  guardarDB();
  return { ok: true, puntos: getUsuario(nombre).puntos };
}

/**
 * Pagar ganadores de apuesta.
 * ganadores: [{ nombre, apostado, proporcion }]
 * pozo: total a repartir
 */
export function pagarGanadores(ganadores, pozo) {
  if (!db) return;
  for (const { nombre, proporcion } of ganadores) {
    const ganancia = Math.floor(pozo * proporcion);
    agregarPuntos(nombre, ganancia, "apuesta_ganada");
    db.run(
      "UPDATE usuarios SET total_ganadas = total_ganadas + 1 WHERE nombre = ?",
      [nombre]
    );
  }
  guardarDB();
}

/**
 * Bonus por participar en una apuesta (solo por jugar).
 */
export function bonusParticipar(nombre) {
  if (!db || CONFIG.BONUS_PARTICIPAR <= 0) return;
  agregarPuntos(nombre, CONFIG.BONUS_PARTICIPAR, "bonus_participar");
}

/**
 * Bonus por votar en una encuesta.
 */
export function bonusVotar(nombre) {
  if (!db || CONFIG.BONUS_PARTICIPAR <= 0) return;
  agregarPuntos(nombre, CONFIG.BONUS_PARTICIPAR, "bonus_votar");
}

/**
 * Top N usuarios por puntos.
 */
export function getTop(n = 10) {
  if (!db) return [];
  const rows = db.exec(
    "SELECT nombre, puntos FROM usuarios ORDER BY puntos DESC LIMIT ?", [n]
  );
  if (!rows.length) return [];
  return rows[0].values.map(([nombre, puntos], i) => ({
    rank: i + 1, user: nombre, points: puntos
  }));
}

/**
 * Ajuste manual de puntos (panel de control).
 */
export function ajustarPuntos(nombre, delta, motivo = "ajuste_manual") {
  if (!db) return 0;
  return agregarPuntos(nombre, delta, motivo);
}

/**
 * Historial de un usuario (últimas N transacciones).
 */
export function getHistorial(nombre, limite = 20) {
  if (!db) return [];
  const rows = db.exec(
    "SELECT delta, motivo, puntos_new, ts FROM historial WHERE nombre = ? ORDER BY ts DESC LIMIT ?",
    [nombre, limite]
  );
  if (!rows.length) return [];
  return rows[0].values.map(([delta, motivo, puntos_new, ts]) => ({
    delta, motivo, puntos: puntos_new, ts
  }));
}

/**
 * Stats de un usuario.
 */
export function getStats(nombre) {
  if (!db) return null;
  upsertUsuario(nombre);
  return getUsuario(nombre);
}