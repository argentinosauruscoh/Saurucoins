// chat-relay.js — relay + bot fusionados (un solo proceso, un solo polling)
// Lee el chat via youtube-chat y responde via YouTube Data API (googleapis)
//
// Usa:
//   node chat-relay.js            → conecta al chat real de YouTube
//   node chat-relay.js --offline  → simulador manual

import { LiveChat } from "youtube-chat";
import { google }   from "googleapis";
import axios        from "axios";
import readline     from "readline";
import fs           from "fs";
import path         from "path";
import http         from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ────────────────────────────────────────────────────
const CHANNEL_ID         = "UCF3OZYeuRdIkfpAr7MenfwA";
const SERVER_URL         = "http://localhost:3000";
const LOG_FILE           = path.join(__dirname, "relay.log");
const CLIENT_SECRET_PATH = path.join(__dirname, "client_secret.json");
const TOKEN_PATH         = path.join(__dirname, "token.json");
const SCOPES             = ["https://www.googleapis.com/auth/youtube"];
const COOLDOWN_SALDO_MS  = 30 * 60 * 1000;  // 30 minutos entre !saldo por usuario
const STATE_INTERVAL_MS  = 4000;             // cada 4s chequea estado de eventos
const TRIVIA_PTS_ACIERTO = 10;
const TRIVIA_PTS_PARTICIPAR = 2;

// ─── ESTADO ────────────────────────────────────────────────────
let youtube       = null;   // cliente googleapis (null en offline)
let liveChatId    = null;   // ID del chat en vivo
let botChannelId  = null;   // ID del canal del bot (para ignorar sus propios mensajes)

const saldoCooldown = new Map(); // authorId → timestamp último !saldo

// Estado de eventos para detectar cambios y notificar
let lastBetState  = { active: false, closed: false, winner: null };
let lastPollState = { active: false, closed: false, winner: null };
let lastTriviaState = { active: false, closed: false, revealed: false };

// ─── CUOTA ─────────────────────────────────────────────────────
let cuotaUsada = 0;
const CUOTA_LIMITE = 9000;

function registrarCuota(tipo) {
  cuotaUsada += tipo === "insert" ? 50 : 0;
  // el list lo hace youtube-chat internamente, no lo contamos nosotros
  if (cuotaUsada >= CUOTA_LIMITE) {
    log(`🚨 CUOTA AL LÍMITE (${cuotaUsada} unidades usadas en inserts). Revisar.`);
  }
}

// ─── LOGGING ───────────────────────────────────────────────────
function log(...args) {
  const line = new Date().toISOString() + " " + args.join(" ");
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

// ─── HELPERS ───────────────────────────────────────────────────
async function sendEvent(payload) {
  try {
    await axios.post(`${SERVER_URL}/chat-event`, payload, { timeout: 3000 });
    log("=> Evento enviado:", JSON.stringify(payload));
  } catch (err) {
    log("! ERROR enviando evento:", err.message);
  }
}

function cleanName(name) {
  return (name || "").replace(/^[¡!@\s]+/, "").trim();
}

// ─── ENVIAR MENSAJE AL CHAT DE YOUTUBE ─────────────────────────
async function sendMessage(text) {
  const isOffline = process.argv.includes("--offline");

  if (isOffline) {
    console.log(`\n🤖 [Saurubot] ${text}\n`);
    return;
  }

  if (!youtube || !liveChatId) {
    log("⚠️ sendMessage: youtube o liveChatId no disponible");
    return;
  }

  if (cuotaUsada >= CUOTA_LIMITE) {
    log("⚠️ Cuota agotada, mensaje no enviado:", text);
    return;
  }

  try {
    await youtube.liveChatMessages.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          liveChatId,
          type: "textMessageEvent",
          textMessageDetails: { messageText: text },
        },
      },
    });
    registrarCuota("insert");
    log(`📤 Enviado (cuota inserts: ${cuotaUsada}): ${text}`);
  } catch (err) {
    log("❌ Error enviando mensaje al chat:", err.message);
  }
}

// ─── AUTH GOOGLE ───────────────────────────────────────────────
async function getAuthClient() {
  const raw    = fs.readFileSync(CLIENT_SECRET_PATH, "utf8");
  const { installed, web } = JSON.parse(raw);
  const creds  = installed || web;

  const oAuth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    "http://localhost:3333"
  );

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oAuth2Client.setCredentials(token);
    log("✅ Token de Google cargado");
    return oAuth2Client;
  }

  // Primera vez: flujo OAuth
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: "offline", scope: SCOPES });
  log("🔑 Abrí este enlace para autorizar el bot:");
  log(authUrl);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url  = new URL(req.url, "http://localhost:3333");
      const code = url.searchParams.get("code");
      if (code) {
        res.end("<h2>✅ Autorizado. Podés cerrar esta pestaña.</h2>");
        server.close();
        resolve(code);
      } else {
        res.end("<h2>❌ Sin código. Intentá de nuevo.</h2>");
        reject(new Error("No code received"));
      }
    });
    server.listen(3333, () => log("⏳ Esperando autorización en http://localhost:3333 ..."));
  });

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  log("✅ Token guardado en token.json");
  return oAuth2Client;
}

// ─── OBTENER LIVE CHAT ID ──────────────────────────────────────
async function initYoutube() {
  const auth = await getAuthClient();
  youtube    = google.youtube({ version: "v3", auth });

  const meRes = await youtube.channels.list({ part: ["id"], mine: true });
  botChannelId = meRes.data.items?.[0]?.id;
  log("🤖 Bot channel ID:", botChannelId);

  // Buscar stream activo en el canal del streamer (CHANNEL_ID), no del bot
  const videoRes = await youtube.videos.list({
    part: ["liveStreamingDetails"],
    id: [await getLiveVideoId()],
  });

  const chatId = videoRes.data.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
  if (!chatId) throw new Error("No se encontró liveChatId");
  liveChatId = chatId;
  log("✅ Live chat ID:", liveChatId);
}

async function getLiveVideoId() {
  const searchRes = await youtube.search.list({
    part: ["id"],
    channelId: CHANNEL_ID,
    eventType: "live",
    type: ["video"],
    maxResults: 1,
  });
  const videoId = searchRes.data.items?.[0]?.id?.videoId;
  if (!videoId) throw new Error("No hay stream en vivo activo en el canal");
  return videoId;
}

// ─── ESTADO LOCAL ──────────────────────────────────────────────
let usuariosYaApostaron = new Set();
let usuariosYaVotaron   = new Set();
let usuariosYaTrivia    = new Set();
let betActivo           = false;
let pollActivo          = false;
let triviaActivo        = false;

// ─── PROCESADOR DE MENSAJES ────────────────────────────────────
async function handleMessage(chatItem) {
  try {
    let raw = "";
    if (typeof chatItem?.message === "string") {
      raw = chatItem.message;
    } else if (Array.isArray(chatItem?.message)) {
      raw = chatItem.message.map(m => m.text || "").join(" ");
    } else if (typeof chatItem?.message === "object" && chatItem?.message?.runs) {
      raw = chatItem.message.runs.map(r => r.text || "").join(" ");
    } else {
      raw = String(chatItem?.message || "");
    }

    const author      = chatItem?.author?.name || "";
    const authorId    = chatItem?.author?.channelId || author; // offline usa nombre como ID
    const authorClean = cleanName(author);
    const msg         = raw.trim();

    if (!msg || !author) return;

    // Ignorar mensajes del propio bot
    if (authorId && authorId === botChannelId) return;

    log(`[CHAT] ${author} | ${msg}`);

    // Puntos por chatear + foto de perfil (se guarda solo una vez por usuario nuevo)
    const profileImg = chatItem?.author?.thumbnail?.url
      || chatItem?.author?.profileImageUrl
      || null;
    if (authorClean) sendEvent({ type: "chatMessage", user: authorClean, profileImg });

    if (!msg.startsWith("!")) return;

    const parts   = msg.trim().split(/\s+/);
    const comando = parts[0].toLowerCase();

    // ── !apostar ──────────────────────────────────────────────
    if (comando === "!apostar") {
      if (!betActivo) { log(`⚠️ ${author} intentó apostar pero no hay apuesta activa`); return; }
      if (usuariosYaApostaron.has(authorClean.toLowerCase())) { log(`⚠️ ${author} ya apostó`); return; }

      const amount = parseInt(parts[1]);
      const option = parseInt(parts[2]);
      if (isNaN(amount) || isNaN(option) || ![1,2].includes(option)) {
        log(`⚠️ Formato incorrecto de ${author}: ${msg}`);
        return;
      }

      usuariosYaApostaron.add(authorClean.toLowerCase());
      log(`✅ APUESTA: ${author} → ${amount} pts a opción ${option}`);
      await sendEvent({ type: "placeBet", user: authorClean, option, amount });
      sendEvent({ type: "bonusParticipar", user: authorClean });
      return;
    }

    // ── !votar ────────────────────────────────────────────────
    if (comando === "!votar") {
      if (!pollActivo) { log(`⚠️ ${author} intentó votar pero no hay encuesta activa`); return; }
      if (usuariosYaVotaron.has(authorClean.toLowerCase())) { log(`⚠️ ${author} ya votó`); return; }

      const option = parseInt(parts[1]);
      if (isNaN(option) || option < 1 || option > 7) { log(`⚠️ Opción inválida: ${parts[1]}`); return; }

      try {
        const pollResp = await axios.get(`${SERVER_URL}/poll-state`, { timeout: 2000 });
        const pollData = pollResp.data;
        const numStr   = String(option);
        const anulada  = (pollData.anuladas || []).includes(numStr);
        const casteada = pollData.llaves?.[numStr]?.casteada || false;
        if (anulada || casteada) {
          log(`🚫 Voto de ${author} por llave ${option} rechazado (${anulada ? "anulada" : "casteada"})`);
          return;
        }
      } catch (e) {
        log(`⚠️ No se pudo verificar estado del poll, aceptando voto de ${author}`);
      }

      usuariosYaVotaron.add(authorClean.toLowerCase());
      log(`✅ VOTO: ${author} → llave ${option}`);
      await sendEvent({ type: "castVote", user: authorClean, option });
      return;
    }

    // ── !trivia ───────────────────────────────────────────────
    if (comando === "!trivia") {
      if (!triviaActivo) { log(`⚠️ ${author} intentó responder trivia pero no hay trivia activa`); return; }
      if (usuariosYaTrivia.has(authorClean.toLowerCase())) { log(`⚠️ ${author} ya respondió esta trivia`); return; }

      const letra = (parts[1] || "").toUpperCase();
      if (!["A","B","C","D"].includes(letra)) {
        log(`⚠️ Opción de trivia inválida de ${author}: ${parts[1]}`);
        return;
      }

      usuariosYaTrivia.add(authorClean.toLowerCase());
      log(`✅ TRIVIA: ${author} → ${letra}`);
      await sendEvent({ type: "castTriviaVote", user: authorClean, option: letra });
      return;
    }

    // ── !saldo ────────────────────────────────────────────────
    if (comando === "!saldo") {
      const ahora  = Date.now();
      const ultimo = saldoCooldown.get(authorId) || 0;
      if (ahora - ultimo < COOLDOWN_SALDO_MS) {
        const restanMin = Math.ceil((COOLDOWN_SALDO_MS - (ahora - ultimo)) / 60000);
        log(`⏳ !saldo de ${author} ignorado (cooldown, faltan ${restanMin} min)`);
        return;
      }
      saldoCooldown.set(authorId, ahora);

      try {
        const res = await axios.get(
          `${SERVER_URL}/puntos/${encodeURIComponent(authorClean.toLowerCase())}`,
          { timeout: 2000 }
        );
        const pts = res.data.puntos || 0;
        log(`💰 SALDO: ${author} tiene ${pts} Saurucoins`);
        await sendMessage(`💰 ${author} tenés ${pts} Saurucoins`);
      } catch (e) {
        log(`⚠️ Error consultando saldo de ${author}`);
      }
      return;
    }

    // ── !top ──────────────────────────────────────────────────
    if (comando === "!top") {
      try {
        const res = await axios.get(`${SERVER_URL}/top?n=6`, { timeout: 2000 });
        const top = res.data;
        if (top.length > 0) {
          await sendEvent({ type: "showTop", top });
          log(`📊 TOP activado por ${author}`);
        }
      } catch (e) {
        log(`⚠️ Error obteniendo top`);
      }
      return;
    }

    // ── !faccion ──────────────────────────────────────────────
    if (comando === "!faccion") {
      try {
        const res = await axios.get(
          `${SERVER_URL}/faccion/${encodeURIComponent(authorClean.toLowerCase())}`,
          { timeout: 2000 }
        );
        const faccionActual = res.data.faccion;
        if (faccionActual) {
          const nombres = { us: "Estados Unidos 🇺🇸", cw: "Commonwealth 🇬🇧", pe: "Panzer Elite ⚙️", wm: "Wehrmacht 🎖️" };
          await sendMessage(`🎖️ ${author} ya pertenecés a ${nombres[faccionActual] || faccionActual}. ¡No podés cambiar de bando!`);
        } else {
          await sendMessage(`⚔️ ${author} ¡Elegí tu bando! Escribí: !unirme us | !unirme cw | !unirme pe | !unirme wm`);
        }
      } catch (e) {
        log(`⚠️ Error consultando facción de ${author}`);
      }
      return;
    }

    // ── !unirme ───────────────────────────────────────────────
    if (comando === "!unirme") {
      const faccionElegida = (parts[1] || "").toLowerCase();
      const FACCIONES_VALIDAS = ["us", "cw", "pe", "wm"];
      if (!FACCIONES_VALIDAS.includes(faccionElegida)) {
        await sendMessage(`⚠️ ${author} facción inválida. Opciones: !unirme us | !unirme cw | !unirme pe | !unirme wm`);
        return;
      }
      try {
        const res = await axios.post(
          `${SERVER_URL}/faccion`,
          { nombre: authorClean.toLowerCase(), faccion: faccionElegida },
          { timeout: 2000 }
        );
        if (res.data.ok) {
          const nombres = { us: "Estados Unidos 🇺🇸", cw: "Commonwealth 🇬🇧", pe: "Panzer Elite ⚙️", wm: "Wehrmacht 🎖️" };
          await sendMessage(`✅ ${author} ¡Bienvenido a ${nombres[faccionElegida]}! Tu bando quedó registrado para siempre.`);
          log(`🎖️ ${authorClean} se unió a facción: ${faccionElegida}`);
        } else {
          const nombres = { us: "Estados Unidos 🇺🇸", cw: "Commonwealth 🇬🇧", pe: "Panzer Elite ⚙️", wm: "Wehrmacht 🎖️" };
          await sendMessage(`❌ ${author} ya pertenecés a ${nombres[res.data.faccion] || res.data.faccion}. ¡No podés cambiar de bando!`);
        }
      } catch (e) {
        log(`⚠️ Error guardando facción de ${author}`);
      }
      return;
    }

    log(`[IGNORADO] Comando desconocido de ${author}: ${comando}`);

  } catch (err) {
    log("ERROR procesando mensaje:", err.message);
  }
}

// ─── MONITOR DE EVENTOS (notificaciones en el chat) ────────────
async function checkEventState() {
  try {
    const [betRes, pollRes, triviaRes] = await Promise.all([
      axios.get(`${SERVER_URL}/overlay-state`, { timeout: 2000 }),
      axios.get(`${SERVER_URL}/poll-state`,    { timeout: 2000 }),
      axios.get(`${SERVER_URL}/trivia-state`,  { timeout: 2000 }),
    ]);

    const bet    = betRes.data;
    const poll   = pollRes.data;
    const trivia = triviaRes.data;

    const prevBet    = betActivo;
    const prevPoll   = pollActivo;
    const prevTrivia = triviaActivo;

    betActivo    = bet.active  && !bet.closed;
    pollActivo   = poll.active && !poll.closed;
    triviaActivo = trivia.active && !trivia.closed;

    // Limpiar sets al terminar ronda
    if (prevBet    && !betActivo)    { usuariosYaApostaron.clear(); log("🔁 Set de apostadores reiniciado"); }
    if (prevPoll   && !pollActivo)   { usuariosYaVotaron.clear();   log("🔁 Set de votantes reiniciado"); }
    if (prevTrivia && !triviaActivo) { usuariosYaTrivia.clear();    log("🔁 Set de trivia reiniciado"); }

    // ── Notificaciones de apuestas ────────────────────────────
    if (bet.active && !bet.closed && !lastBetState.active) {
      await sendMessage("🎲 ¡Apuestas abiertas! Usá !apostar <cantidad> <1|2> — 1=ALIADOS / 2=EJE");
    }
    if (bet.closed && !lastBetState.closed && lastBetState.active) {
      await sendMessage("🔒 ¡Apuestas cerradas! Esperando resultado...");
    }
    if (bet.winner && bet.winner !== lastBetState.winner) {
      const ganador = bet.winner === 1 ? "ALIADOS 🔵" : "EJE 🔴";
      await sendMessage(`🏆 ¡Ganaron los ${ganador}! Los apostadores cobran sus Saurucoins.`);
    }

    // ── Notificaciones de encuesta ────────────────────────────
    if (poll.active && !poll.closed && !lastPollState.active) {
      await sendMessage("🗳️ ¡Encuesta abierta! Votá con !votar <número de llave>");
    }
    if (poll.closed && !lastPollState.closed && lastPollState.active) {
      await sendMessage("🔒 ¡Encuesta cerrada! Calculando resultado...");
    }
    if (poll.winner && poll.winner !== lastPollState.winner) {
      await sendMessage(`🏆 ¡La llave ${poll.winner} ganó la encuesta!`);
    }

    // ── Notificaciones de trivia ──────────────────────────────
    if (trivia.active && !trivia.closed && !lastTriviaState.active) {
      await sendMessage(`🧠 ¡Trivia! ${trivia.pregunta} — Respondé con !trivia A/B/C/D (tenés ${trivia.duration}s)`);
    }
    if (trivia.closed && !lastTriviaState.closed && lastTriviaState.active) {
      await sendMessage("⏳ ¡Tiempo! Calculando respuesta correcta...");
    }
    if (trivia.revealed && !lastTriviaState.revealed) {
      await sendMessage(`✅ ¡La correcta era ${trivia.correcta}! Los que acertaron ganan +${TRIVIA_PTS_ACIERTO} pts, el resto +${TRIVIA_PTS_PARTICIPAR} pts por participar.`);
    }

    lastBetState  = { active: bet.active,  closed: bet.closed,  winner: bet.winner  };
    lastPollState = { active: poll.active, closed: poll.closed, winner: poll.winner };
    lastTriviaState = { active: trivia.active, closed: trivia.closed, revealed: trivia.revealed };

  } catch { /* servidor no disponible aún */ }
}

// ─── MODO OFFLINE ──────────────────────────────────────────────
function simulateOfflineMode() {
  console.log("\n=== 🧪 MODO DEMO OFFLINE ===");
  console.log("Formatos:");
  console.log("  lean: !saldo");
  console.log("  lean: !votar 3");
  console.log("  lean: !apostar 30 1");
  console.log("  lean: !top");
  console.log("  lean: hola  (suma puntos)");
  console.log("============================\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("💬 > ");
  rl.prompt();
  rl.on("line", async (line) => {
    const trimmed  = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const author  = trimmed.slice(0, colonIdx).trim();
      const message = trimmed.slice(colonIdx + 1).trim();
      await handleMessage({ author: { name: author }, message });
    } else {
      log("Formato: usuario: mensaje");
    }
    rl.prompt();
  });
}

// ─── MODO LIVE ─────────────────────────────────────────────────
let reconnectDelay = 5000;
const MAX_DELAY    = 120000;
let chatInstance   = null;

async function startLiveMode() {
  log("🔌 Conectando al chat de YouTube...");

  async function connect() {
    try {
      if (chatInstance) { try { chatInstance.stop(); } catch {} chatInstance = null; }

      chatInstance = new LiveChat({ channelId: CHANNEL_ID });

      chatInstance.on("chat", (item) => {
        reconnectDelay = 5000;
        handleMessage(item);
      });

      chatInstance.on("start", () => {
        reconnectDelay = 5000;
        log("✅ Conectado al chat de YouTube — escuchando comandos");
      });

      chatInstance.on("end", () => {
        log(`⚠️ Chat desconectado. Reconectando en ${reconnectDelay/1000}s...`);
        scheduleReconnect();
      });

      chatInstance.on("error", (err) => {
        if (err.message.includes("Live Stream was not found")) {
          log("⚠️ No hay stream activo todavía. Reintentando en 30s...");
          reconnectDelay = 30000;
        } else {
          log(`❌ Error en chat: ${err.message}. Reconectando en ${reconnectDelay/1000}s...`);
        }
        scheduleReconnect();
      });

      await chatInstance.start();

    } catch (err) {
      if (err.message?.includes("Live Stream was not found")) {
        log(`⚠️ Stream no encontrado. Reintentando en 30s...`);
        reconnectDelay = 30000;
      } else {
        log(`❌ Error iniciando chat: ${err.message}. Reintentando en ${reconnectDelay/1000}s...`);
      }
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    setTimeout(() => {
      log("🔄 Intentando reconectar...");
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
      connect();
    }, reconnectDelay);
  }

  connect();
}

// ─── ENTRADA PRINCIPAL ─────────────────────────────────────────
process.on("unhandledRejection", (err) => {
  log("❌ Error no manejado:", err?.message || err);
});

const isOffline = process.argv.includes("--offline");

log("🚀 Saurubot relay arrancando...");

// Monitor de eventos en ambos modos
setInterval(checkEventState, STATE_INTERVAL_MS);
checkEventState();

if (isOffline) {
  simulateOfflineMode();
} else {
  // En modo live: inicializar auth de Google primero, luego conectar al chat
  log("🔑 Inicializando auth de Google...");
  initYoutube()
    .then(() => startLiveMode())
    .catch(err => {
      log("❌ Error fatal en init:", err.message);
      process.exit(1);
    });
}