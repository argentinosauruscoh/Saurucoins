// chat-relay.js
// Relay de chat para detectar frases del Cloudbot (Streamlabs) y enviar eventos al server local.
// Requisitos: npm i youtube-chat axios
//
// Usa:
//   node chat-relay.js            → intenta conectar al chat real
//   node chat-relay.js --offline  → modo simulador manual (offline)

import { LiveChat } from "youtube-chat";
import axios from "axios";
import readline from "readline";

// ------------- CONFIG -------------
const CHANNEL_ID = "UCF3OZYeuRdIkfpAr7MenfwA";
const SERVER_URL = "http://localhost:3000";

// ------------- HELPERS -------------
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function sendEvent(payload) {
  try {
    await axios.post(`${SERVER_URL}/chat-event`, payload, { timeout: 3000 });
    log("=> Evento enviado:", payload);
  } catch (err) {
    console.error("! ERROR enviando evento al server:", err.message || err);
  }
}

function normalize(text) {
  if (!text) return "";
  return text.trim();
}

function isFromStreamlabs(rawText, authorName) {
  if (!rawText && !authorName) return false;
  const trimmed = (rawText || "").trim().toLowerCase();
  return (
    trimmed.startsWith("streamlabs:") ||
    (authorName && authorName.toLowerCase().includes("streamlabs"))
  );
}

// ------------- PATRONES APUESTAS -------------
const OPEN_BET_PATTERN    = /se han abierto las apuestas/i;
const CANCEL_BET_PATTERN  = /se han cancelado las apuestas/i;
const CLOSE_BET_PATTERN   = /se han cerrado las apuestas/i;
const PLACE_BET_PATTERN   = /@?(.+?)\s+apuesta\s+(\d+)\s+a\s*(?:opción\s*)?(\d+)/i;
const WINNER_BET_PATTERN  = /(\d)\s+fue\s+la\s+opción\s+ganadora/i;

// ------------- PATRONES ENCUESTA -------------
// Apertura: "Se ha abierto una encuesta para "Título". Usa !votar <1 | 2 | ... | N> para votar."
const OPEN_POLL_PATTERN   = /se ha abierto una encuesta para\s+"([^"]+)".*!votar\s+<([\d\s|]+)>/i;

// Voto: "@usuario ha votado por 3!"
const VOTE_POLL_PATTERN   = /@?(.+?)\s+ha\s+votado\s+por\s+(\d+)/i;

// Cierre: "La encuesta para "Título" ha sido cerrada."
const CLOSE_POLL_PATTERN  = /la encuesta.*ha sido cerrada/i;

// Empate: "La encuesta dio como resultado un empate entre 2 | 4 | 5."
const TIE_POLL_PATTERN    = /encuesta dio como resultado un empate entre\s+([\d\s|]+)/i;

// Ganador: "6 fue la opción más votada de la encuesta con el 50% de los votos."
// Sin ^ para tolerar prefijo "Streamlabs: ", acentos flexibles para tolerar NFD/NFC
const WINNER_POLL_PATTERN = /(\d+)\s+fue\s+la\s+opci[oó]n\s+m[aá]s\s+votada/i;

// ------------- ESTADO LOCAL -------------
let usuariosYaApostaron = new Set();
let usuariosYaVotaron   = new Set();
let pollActivo          = false;

// ------------- PROCESADOR PRINCIPAL -------------
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

    const author = chatItem?.author?.name || "";
    if (!raw) return;

    log("Mensaje recibido:", author, "|", raw);

    // ── Registrar presencia/puntos por chatear (vía servidor, no DB directa) ──
    if (author && !author.toLowerCase().includes("streamlabs")) {
      sendEvent({ type: "chatMessage", user: author });
    }

    if (!isFromStreamlabs(raw, author)) return;

    const text = normalize(raw);
    const lower = text.toLowerCase();

    // ===================== APUESTAS =====================

    if (OPEN_BET_PATTERN.test(lower)) {
      usuariosYaApostaron.clear();
      log("Detectado: APERTURA APUESTA");
      await sendEvent({ type: "startBet" });
      return;
    }

    if (CANCEL_BET_PATTERN.test(lower)) {
      usuariosYaApostaron.clear();
      log("Detectado: CANCELACIÓN APUESTA");
      await sendEvent({ type: "cancelBet" });
      return;
    }

    if (CLOSE_BET_PATTERN.test(lower)) {
      log("Detectado: CIERRE APUESTA");
      await sendEvent({ type: "closeBet" });
      return;
    }

    const placeMatch = raw.match(PLACE_BET_PATTERN);
    if (placeMatch) {
      let user = placeMatch[1].replace(/^@/, "").trim();
      const amount = parseInt(placeMatch[2], 10);
      const option = parseInt(placeMatch[3], 10);
      if (usuariosYaApostaron.has(user.toLowerCase())) {
        log(`⚠️ ${user} ya había apostado. Ignorado.`);
        return;
      }
      usuariosYaApostaron.add(user.toLowerCase());
      if (!Number.isNaN(amount) && (option === 1 || option === 2)) {
        await sendEvent({ type: "placeBet", user, option, amount });
        sendEvent({ type: "bonusParticipar", user });
      }
      return;
    }

    const winBetMatch = text.match(WINNER_BET_PATTERN);
    if (winBetMatch) {
      usuariosYaApostaron.clear();
      const option = parseInt(winBetMatch[1], 10);
      if (option === 1 || option === 2) {
        await sendEvent({ type: "declareWinner", option });
      }
      return;
    }

    // ===================== TOP PUNTOS =====================

    const TOP_PATTERN = /principales por puntos:/i;
    if (TOP_PATTERN.test(lower)) {
      log("Detectado: TOP LIST");
      const regex = /(\d+)\.\s*([^()]+)\((\d+)\)/g;
      const topList = [];
      let match;
      while ((match = regex.exec(text)) !== null && topList.length < 6) {
        topList.push({ rank: parseInt(match[1]), user: match[2].trim(), points: parseInt(match[3]) });
      }
      if (topList.length > 0) await sendEvent({ type: "showTop", top: topList });
      return;
    }

    // ===================== ENCUESTA =====================
    // Normalizar a NFC para que los acentos matcheen correctamente
    // (el chat de YouTube puede enviar caracteres en NFD)
    const textNFC = text.normalize("NFC");

    // --- APERTURA ---
    const openPollMatch = textNFC.match(OPEN_POLL_PATTERN);
    if (openPollMatch) {
      const title = openPollMatch[1].trim();
      // Contar opciones desde el rango "<1 | 2 | ... | N>"
      const rangeStr = openPollMatch[2]; // "1 | 2 | 3 | 4 | 5 | 6 | 7"
      const opciones = rangeStr.split("|").map(s => s.trim()).filter(Boolean);
      const optionCount = opciones.length;

      usuariosYaVotaron.clear();
      pollActivo = true;

      log(`Detectado: APERTURA ENCUESTA → "${title}" (${optionCount} opciones)`);
      await sendEvent({ type: "startPoll", title, optionCount });
      return;
    }

    // --- VOTO ---
    if (pollActivo) {
      const voteMatch = text.match(VOTE_POLL_PATTERN);
      if (voteMatch) {
        const user = voteMatch[1].replace(/^@/, "").trim();
        const option = parseInt(voteMatch[2], 10);

        if (usuariosYaVotaron.has(user.toLowerCase())) {
          log(`⚠️ ${user} ya había votado. Ignorado.`);
          return;
        }

        if (option >= 1 && option <= 7) {
          // Verificar que la llave no esté anulada ni casteada antes de registrar
          try {
            const pollResp = await axios.get(`${SERVER_URL}/poll-state`, { timeout: 2000 });
            const pollData = pollResp.data;
            const numStr   = String(option);
            const anulada  = (pollData.anuladas || []).includes(numStr);
            const casteada = pollData.llaves?.[numStr]?.casteada || false;

            if (anulada || casteada) {
              log(`🚫 Voto de ${user} por llave ${option} rechazado (${anulada ? "anulada" : "casteada"})`);
              return;
            }
          } catch (e) {
            log(`⚠️ No se pudo verificar estado del poll, aceptando voto de ${user}`);
          }

          usuariosYaVotaron.add(user.toLowerCase());
          log(`Detectado: VOTO → ${user} votó por llave ${option}`);
          await sendEvent({ type: "castVote", user, option });
        }
        return;
      }
    }

    // --- CIERRE ---
    if (CLOSE_POLL_PATTERN.test(textNFC)) {
      log("Detectado: CIERRE ENCUESTA");
      await sendEvent({ type: "closePoll" });
      return;
    }

    // --- EMPATE ---
    const tieMatch = textNFC.match(TIE_POLL_PATTERN);
    if (tieMatch) {
      pollActivo = false;
      usuariosYaVotaron.clear();
      const tied = tieMatch[1].split("|").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      log("Detectado: EMPATE ENCUESTA →", tied);
      await sendEvent({ type: "pollResult", tied });
      return;
    }

    // --- GANADOR ---
    const winPollMatch = textNFC.match(WINNER_POLL_PATTERN);
    if (winPollMatch) {
      pollActivo = false;
      usuariosYaVotaron.clear();
      const winner = parseInt(winPollMatch[1], 10);
      log(`Detectado: GANADOR ENCUESTA → llave ${winner}`);
      await sendEvent({ type: "pollResult", winner });
      return;
    }

    log("Streamlabs mensaje no reconocido (ignorado):", raw);
  } catch (err) {
    console.error("ERROR procesando chatItem:", err);
  }
}

// ------------- MODO OFFLINE -------------
function simulateOfflineMode() {
  console.log("\n=== 🧪 MODO DEMO OFFLINE ACTIVADO ===");
  console.log("Formatos disponibles:");
  console.log("  → Viewer (suma puntos):   lean: hola como andan");
  console.log("  → Streamlabs (apuestas):  Streamlabs: Se han abierto las apuestas");
  console.log("  → Sin prefijo:            Se han abierto las apuestas  (se trata como Streamlabs)");
  console.log("=====================================\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("💬 Mensaje simulado> ");
  rl.prompt();
  rl.on("line", async (line) => {
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx > 0) {
      const author  = trimmed.slice(0, colonIdx).trim();
      const message = trimmed.slice(colonIdx + 1).trim();
      await handleMessage({ author: { name: author }, message });
    } else {
      // Sin prefijo → tratar como Streamlabs
      await handleMessage({ author: { name: "Streamlabs" }, message: trimmed });
    }
    rl.prompt();
  });
}

// ------------- CONEXIÓN AL CHAT REAL -------------
async function startLiveMode() {
  const chat = new LiveChat({ channelId: CHANNEL_ID });
  chat.on("chat", handleMessage);
  chat.on("start", () => log("✅ Conectado al chat de YouTube"));
  chat.on("end",   () => log("❌ Conexión al chat finalizada"));
  chat.on("error", (err) => {
    console.error("❌ Error en chat listener:", err.message);
    if (err.message.includes("Live Stream was not found")) simulateOfflineMode();
  });
  try {
    await chat.start();
  } catch (err) {
    if (err.message.includes("Live Stream was not found")) simulateOfflineMode();
    else { console.error("❌ Error iniciando chat:", err.message); simulateOfflineMode(); }
  }
}

process.on("unhandledRejection", (err) => {
  if (err?.message?.includes("Live Stream was not found")) simulateOfflineMode();
  else console.error("❌ Error no manejado:", err);
});

if (process.argv.includes("--offline")) simulateOfflineMode();
else startLiveMode();