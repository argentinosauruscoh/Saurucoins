// server2.js — versión final producción (modo Chat Relay)
// NOTA: convertido a ESM para poder importar db.js
import express from "express";
import cors    from "cors";
import path    from "path";
import { fileURLToPath } from "url";
import {
  initDB, pagarPasivos, getPuntos, ajustarPuntos,
  getTop, getHistorial, getStats, CONFIG,
  registrarMensaje, bonusParticipar, bonusVotar,
  descontarApuesta
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const port = 3000;

// ── Iniciar DB ──────────────────────────────────────────────────
await initDB();
console.log("✅ Saurucoins DB lista");

// ── Pago pasivo automático ──────────────────────────────────────
setInterval(() => {
  pagarPasivos();
}, CONFIG.INTERVALO_PASIVO_MIN * 60 * 1000);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Ping ────────────────────────────────────────────────────────
app.get("/ping", (req, res) => {
  res.status(200).json({ ok: true, msg: "Overlay server activo" });
});

// ── Diagnóstico de nombres ───────────────────────────────────────
const diagLog = [];
function logDiag(raw, guardado) {
  diagLog.unshift({ raw, guardado, ts: new Date().toISOString() });
  if (diagLog.length > 50) diagLog.pop();
}
app.get("/diagnostico", (req, res) => {
  res.json({
    total: diagLog.length,
    nota: "raw = nombre exacto de YouTube | guardado = como se guarda en DB",
    entradas: diagLog
  });
});

// =========================================================
// === ESTADO DE APUESTAS ===
// =========================================================
let overlayState = {
  active: false, closed: false, cancelled: false, winner: null,
  option1: 0, option2: 0, recentBets: [],
  status: "💤 Esperando apuestas...", remaining: 0,
};
// Registro interno para descuentos y pagos: { nombre: { amount, option } }
let apuestasRonda = {};
let timerInterval = null;
let topState = { visible: false, list: [] };

function resetOverlay() {
  overlayState = {
    active: false, closed: false, cancelled: false, winner: null,
    option1: 0, option2: 0, recentBets: [],
    status: "💤 Esperando apuestas...", remaining: 0,
  };
  apuestasRonda = {};
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  console.log("🔁 Overlay apuestas reiniciado");
}

function startTimer(seconds = 120) {
  overlayState.remaining = seconds;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!overlayState.active || overlayState.closed) {
      clearInterval(timerInterval); timerInterval = null; return;
    }
    overlayState.remaining = Math.max(0, overlayState.remaining - 1);
    if (overlayState.remaining === 0 && !overlayState.closed) {
      overlayState.closed = true;
      overlayState.status = "¡Apuestas cerradas!";
      console.log("🔒 Tiempo agotado: apuestas cerradas automáticamente");
      clearInterval(timerInterval); timerInterval = null;
    }
  }, 1000);
}

app.get("/overlay-state",     (req, res) => res.json(overlayState));
app.get("/top-overlay-state", (req, res) => res.json(topState));

// =========================================================
// === ESTADO DE ENCUESTA (POLL) ===
// =========================================================

let pollState = {
  active:      false,
  closed:      false,
  title:       "",
  optionCount: 7,
  votes:       {},
  recentVotes: [],
  winner:      null,
  tied:        [],
  status:      "💤 Esperando encuesta...",
  liga:        "oro",
  fecha:       "1",
  llaves:      {},
  anuladas:    [],
  remaining:   0,    // segundos restantes
  duration:    120,  // duración configurada
};

let pollTimerInterval = null;

function startPollTimer(seconds = 120) {
  pollState.remaining = seconds;
  pollState.duration  = seconds;
  if (pollTimerInterval) clearInterval(pollTimerInterval);
  pollTimerInterval = setInterval(() => {
    if (!pollState.active || pollState.closed) {
      clearInterval(pollTimerInterval); pollTimerInterval = null; return;
    }
    pollState.remaining = Math.max(0, pollState.remaining - 1);
    if (pollState.remaining === 0 && !pollState.closed) {
      pollState.closed = true;
      pollState.status = "🔒 Encuesta cerrada";
      console.log("🔒 Tiempo agotado: encuesta cerrada automáticamente");
      clearInterval(pollTimerInterval); pollTimerInterval = null;
    }
  }, 1000);
}

function resetPoll() {
  const { liga, fecha, llaves, anuladas } = pollState;
  if (pollTimerInterval) { clearInterval(pollTimerInterval); pollTimerInterval = null; }
  pollState = {
    active: false, closed: false, title: "",
    optionCount: 7, votes: {}, recentVotes: [],
    winner: null, tied: [], status: "💤 Esperando encuesta...",
    liga, fecha, llaves, anuladas,
    remaining: 0, duration: 120,
  };
  console.log("🔁 Poll reiniciado");
}

app.get("/poll-state", (req, res) => {
  const count = Object.keys(pollState.llaves).length;
  res.json({ ...pollState, optionCount: count > 0 ? count : pollState.optionCount });
});

app.post("/poll-sync", (req, res) => {
  const { liga, fecha, llaves, anuladas } = req.body;
  if (!llaves || typeof llaves !== "object") return res.sendStatus(400);
  pollState.liga    = liga  || pollState.liga;
  pollState.fecha   = fecha || pollState.fecha;
  pollState.llaves  = llaves;
  pollState.anuladas = Array.isArray(anuladas) ? anuladas.map(String) : [];
  console.log(`📋 Sync recibido (${liga} fecha ${fecha}): ${Object.keys(llaves).length} llaves, anuladas: [${pollState.anuladas}]`);
  res.sendStatus(200);
});

app.post("/poll-llaves", (req, res) => {
  const { liga, fecha, llaves } = req.body;
  if (!llaves || typeof llaves !== "object") return res.sendStatus(400);
  pollState.liga  = liga  || pollState.liga;
  pollState.fecha = fecha || pollState.fecha;
  Object.entries(llaves).forEach(([num, datos]) => {
    pollState.llaves[num] = { ...(pollState.llaves[num] || {}), ...datos };
  });
  res.sendStatus(200);
});

app.post("/poll-anular", (req, res) => {
  const { llave, anulada } = req.body;
  if (!llave) return res.sendStatus(400);
  const num = String(llave);
  const idx = pollState.anuladas.indexOf(num);
  if (anulada  && idx === -1) pollState.anuladas.push(num);
  if (!anulada && idx !== -1) pollState.anuladas.splice(idx, 1);
  console.log(`🔴 Llave ${num} ${anulada ? "anulada" : "restaurada"}. Anuladas:`, pollState.anuladas);
  res.sendStatus(200);
});

app.post("/poll-liga", (req, res) => {
  const { liga } = req.body;
  if (!liga) return res.sendStatus(400);
  pollState.liga = liga;
  pollState.llaves   = {};
  pollState.anuladas = [];
  console.log(`🏆 Liga del poll cambiada a: ${liga} (llaves limpiadas, esperando fixture)`);
  res.sendStatus(200);
});

// =========================================================
// === ENDPOINT PARA CHAT RELAY ===
// =========================================================
app.post("/chat-event", (req, res) => {
  const { type, user, option, amount, top, profileImg } = req.body;
  console.log(`💬 Chat relay → ${type}`, req.body);

  switch (type) {

    // ── PUNTOS ────────────────────────────────────────────
    case "chatMessage": {
      const BLOQUEADOS = ["botrix", "argentinosaurus_coh", "streamlabs"];
      const cleanUser = (user || "").replace(/^[¡!@\s]+/, "").trim().toLowerCase();
      if (BLOQUEADOS.includes(cleanUser)) break;
      logDiag(user, cleanUser);
      if (!cleanUser) break;
      const { sumado, puntos } = registrarMensaje(cleanUser);
      if (sumado) console.log(`💰 ${cleanUser} +${CONFIG.PUNTOS_POR_MENSAJE} pts por chatear → ${puntos} total`);
      // Guardar foto de perfil solo si viene y el usuario aún no tiene
      if (profileImg) guardarProfileImg(cleanUser, profileImg);
      break;
    }

    case "bonusParticipar": {
      const cleanUser = (user || "").replace(/^[¡!@\s]+/, "").trim().toLowerCase();
      if (!cleanUser) break;
      bonusParticipar(cleanUser);
      console.log(`🎲 ${cleanUser} +${CONFIG.BONUS_PARTICIPAR} pts por apostar`);
      break;
    }

    case "bonusVotar": {
      const cleanUser = (user || "").replace(/^[¡!@\s]+/, "").trim().toLowerCase();
      if (!cleanUser) break;
      bonusVotar(cleanUser);
      console.log(`🗳️ ${cleanUser} +${CONFIG.BONUS_PARTICIPAR} pts por votar`);
      break;
    }

    // ── APUESTAS ──────────────────────────────────────────
    case "startBet":
      resetOverlay();
      overlayState.active = true;
      overlayState.status = "¡Apuestas abiertas!";
      startTimer(120);
      break;

    case "placeBet": {
      if (!overlayState.active || overlayState.closed) break;
      const userLower = (user || "").toLowerCase();
      if (overlayState.recentBets.some(b => b.user.toLowerCase() === userLower)) {
        console.log(`⚠️ ${user} ya apostó en esta ronda. Ignorado.`);
        break;
      }
      const betAmount = parseInt(amount) || 0;
      const betOption = parseInt(option);
      if (betAmount < CONFIG.APUESTA_MIN) {
        console.log(`⚠️ ${user} apostó ${betAmount} pts (mínimo: ${CONFIG.APUESTA_MIN}). Ignorado.`);
        break;
      }
      if (betAmount > CONFIG.APUESTA_MAX) {
        console.log(`⚠️ ${user} apostó ${betAmount} pts (máximo: ${CONFIG.APUESTA_MAX}). Ignorado.`);
        break;
      }
      // Verificar y descontar saldo
      const cleanBetUser = (user || "").replace(/^[¡!@\s]+/, "").trim().toLowerCase();
      const descuento = descontarApuesta(cleanBetUser, betAmount);
      if (!descuento.ok) {
        console.log(`⚠️ ${user} no tiene suficiente saldo (tiene ${descuento.puntos}, necesita ${betAmount}). Ignorado.`);
        break;
      }
      // Registrar para pago posterior
      apuestasRonda[cleanBetUser] = { amount: betAmount, option: betOption };
      if (betOption === 1) overlayState.option1 += betAmount;
      else if (betOption === 2) overlayState.option2 += betAmount;
      overlayState.recentBets.push({
        user, option: betOption === 1 ? "ALIADOS" : "EJE", points: betAmount,
      });
      if (overlayState.recentBets.length > 15) overlayState.recentBets.shift();
      console.log(`✅ ${user} apostó ${betAmount} pts a opción ${betOption} (saldo restante: ${descuento.puntos})`);
      break;
    }

    case "closeBet":
      if (!overlayState.active) break;
      overlayState.closed = true;
      overlayState.status = "¡Apuestas cerradas!";
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      break;

    case "cancelBet":
      // Devolver puntos a todos los apostadores
      for (const [nombre, datos] of Object.entries(apuestasRonda)) {
        ajustarPuntos(nombre, datos.amount, "apuesta_devuelta");
        console.log(`↩️ Devueltos ${datos.amount} pts a ${nombre}`);
      }
      apuestasRonda = {};
      resetOverlay();
      break;

    case "declareWinner": {
      if (!overlayState.active) break;
      const winOption = parseInt(option);
      overlayState.winner = winOption;
      overlayState.status = `🏆 Ganador: opción ${winOption === 1 ? "ALIADOS" : "EJE"}`;

      // Calcular pozo total y distribuir entre ganadores
      const pozo = overlayState.option1 + overlayState.option2;
      const ganadores = Object.entries(apuestasRonda)
        .filter(([_, d]) => d.option === winOption);
      const pozoGanadores = ganadores.reduce((s, [_, d]) => s + d.amount, 0);

      if (ganadores.length > 0 && pozo > 0) {
        for (const [nombre, datos] of ganadores) {
          const proporcion = datos.amount / pozoGanadores;
          const ganancia   = Math.floor(pozo * proporcion);
          ajustarPuntos(nombre, ganancia, "apuesta_ganada");
          console.log(`🏆 ${nombre} ganó ${ganancia} pts (apostó ${datos.amount} de ${pozoGanadores})`);
        }
      } else {
        // Sin ganadores → devolver a todos
        for (const [nombre, datos] of Object.entries(apuestasRonda)) {
          ajustarPuntos(nombre, datos.amount, "apuesta_devuelta");
        }
        console.log("⚠️ Sin ganadores — puntos devueltos a todos");
      }

      apuestasRonda = {};
      setTimeout(() => resetOverlay(), 5000);
      break;
    }

    case "showTop":
      if (Array.isArray(top) && top.length > 0) {
        topState.visible = true;
        topState.list = top.slice(0, 6);
        setTimeout(() => { topState.visible = false; topState.list = []; }, 15000);
      }
      break;

    // ── ENCUESTA ──────────────────────────────────────────
    case "startPoll": {
      resetPoll();
      pollState.active      = true;
      pollState.title       = req.body.title || "¿Qué llave casteamos?";
      const llavesDisponibles = Object.keys(pollState.llaves).length;
      pollState.optionCount = llavesDisponibles > 0
        ? llavesDisponibles
        : (parseInt(req.body.optionCount) || 7);
      pollState.status = "🗳️ ¡Encuesta abierta!";
      for (let i = 1; i <= pollState.optionCount; i++) pollState.votes[String(i)] = 0;
      const duracion = parseInt(req.body.duration) || 120;
      startPollTimer(duracion);
      console.log(`🗳️ Encuesta abierta: "${pollState.title}" (${pollState.optionCount} opciones, ${duracion}s)`);
      break;
    }

    case "castVote": {
      if (!pollState.active || pollState.closed) break;
      const voteOption = String(option);
      if (!pollState.votes[voteOption]) pollState.votes[voteOption] = 0;
      pollState.votes[voteOption]++;
      if (!pollState.recentVotes.some(v => v.user === user)) {
        pollState.recentVotes.push({ user, option: voteOption });
        if (pollState.recentVotes.length > 20) pollState.recentVotes.shift();
        const cleanVoter = (user || "").replace(/^[¡!@\s]+/, "").trim().toLowerCase();
        if (cleanVoter) bonusVotar(cleanVoter);
      }
      break;
    }

    case "closePoll":
      if (!pollState.active) break;
      pollState.closed = true;
      pollState.status = "🔒 Encuesta cerrada";
      if (pollTimerInterval) { clearInterval(pollTimerInterval); pollTimerInterval = null; }
      console.log("🔒 Encuesta cerrada");
      break;

    case "pollResult": {
      if (!pollState.active) break;
      pollState.closed = true;
      if (Array.isArray(req.body.tied) && req.body.tied.length > 1) {
        pollState.tied   = req.body.tied.map(String);
        pollState.winner = null;
        pollState.status = `🤝 Empate entre llaves: ${pollState.tied.join(", ")}`;
        console.log("🤝 Empate:", pollState.tied);
      } else {
        pollState.winner = String(req.body.winner || option);
        pollState.tied   = [];
        pollState.status = `🏆 ¡Llave ${pollState.winner} ganó la encuesta!`;
        if (pollState.llaves[pollState.winner]) {
          pollState.llaves[pollState.winner].casteada = true;
        }
        console.log("🏆 Ganador encuesta: llave", pollState.winner);
      }
      setTimeout(() => resetPoll(), 8000);
      break;
    }

    case "cancelPoll":
      resetPoll();
      console.log("⛔ Encuesta cancelada");
      break;

    default:
      console.log("⚠️ Tipo de evento desconocido:", type);
  }

  res.sendStatus(200);
});

// =========================================================
// === ENDPOINTS SAURUCOINS ===
// =========================================================

app.get("/puntos/:usuario", (req, res) => {
  const nombre = req.params.usuario.toLowerCase();
  const puntos = getPuntos(nombre);
  res.json({ nombre, puntos });
});

app.get("/top", (req, res) => {
  const n = parseInt(req.query.n) || 10;
  res.json(getTop(n));
});

app.get("/historial/:usuario", (req, res) => {
  const nombre = req.params.usuario.toLowerCase();
  const limite = parseInt(req.query.limite) || 20;
  res.json(getHistorial(nombre, limite));
});

app.get("/stats/:usuario", (req, res) => {
  const nombre = req.params.usuario.toLowerCase();
  const stats = getStats(nombre);
  if (!stats) return res.status(404).json({ error: "Usuario no encontrado" });
  res.json(stats);
});

app.post("/ajustar", (req, res) => {
  const { nombre, delta, motivo } = req.body;
  if (!nombre || delta === undefined) return res.status(400).json({ error: "Faltan parámetros" });
  const nuevos = ajustarPuntos(nombre.toLowerCase(), parseInt(delta), motivo);
  console.log(`🔧 Ajuste manual: ${nombre} ${delta > 0 ? "+" : ""}${delta} pts → ${nuevos} total`);
  res.json({ nombre, puntos: nuevos });
});

app.get("/config-puntos", (req, res) => {
  res.json(CONFIG);
});

app.listen(port, () => {
  console.log(`🌐 Servidor overlay corriendo en http://localhost:${port}`);
});