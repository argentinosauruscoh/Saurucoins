// saurubot.js — Bot que responde comandos en el chat de YouTube
// Responde a: !saldo, !top (y más en el futuro)
//
// Primer uso: node saurubot.js  → abre el navegador para autorizar
// Usos siguientes: el token se guarda en token.json y no pide autorización

import { google } from "googleapis";
import fs from "fs";
import path from "path";
import http from "http";
import axios from "axios";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ────────────────────────────────────────────────────
const CLIENT_SECRET_PATH = path.join(__dirname, "client_secret.json");
const TOKEN_PATH         = path.join(__dirname, "token.json");
const SERVER_URL         = "http://localhost:3000";
const SCOPES             = ["https://www.googleapis.com/auth/youtube"];
const POLL_INTERVAL_MS   = 4000;  // cada 4s lee mensajes nuevos
const COOLDOWN_SALDO_MS  = 120000; // 10s entre !saldo del mismo usuario

// ─── ESTADO ────────────────────────────────────────────────────
let liveChatId    = null;
let nextPageToken = null;
let botChannelId  = null;
const saldoCooldown = new Map(); // user → timestamp último !saldo

// ─── LOGGING ───────────────────────────────────────────────────
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// ─── AUTH ──────────────────────────────────────────────────────
async function getAuthClient() {
  const raw = fs.readFileSync(CLIENT_SECRET_PATH, "utf8");
  const { installed, web } = JSON.parse(raw);
  const creds = installed || web;

  const oAuth2Client = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    "http://localhost:3333"
  );

  // Si ya tenemos token guardado, usarlo
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oAuth2Client.setCredentials(token);
    log("✅ Token cargado desde token.json");
    return oAuth2Client;
  }

  // Primera vez: abrir navegador para autorizar
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });

  log("🔑 Abrí este enlace en tu navegador para autorizar Saurubot:");
  log(authUrl);

  // Esperar el código de autorización en un servidor local temporal
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost:3333");
      const code = url.searchParams.get("code");
      if (code) {
        res.end("<h2>✅ Saurubot autorizado. Podés cerrar esta pestaña.</h2>");
        server.close();
        resolve(code);
      } else {
        res.end("<h2>❌ No se recibió código. Intentá de nuevo.</h2>");
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
async function getLiveChatId(youtube) {
  // Obtener el canal del bot
  const meRes = await youtube.channels.list({
    part: ["id"],
    mine: true,
  });
  botChannelId = meRes.data.items?.[0]?.id;
  log("🤖 Bot channel ID:", botChannelId);

  // Buscar el stream activo del canal
  const searchRes = await youtube.search.list({
    part: ["id"],
    channelId: botChannelId,
    eventType: "live",
    type: ["video"],
    maxResults: 1,
  });

  const videoId = searchRes.data.items?.[0]?.id?.videoId;
  if (!videoId) throw new Error("No hay stream en vivo activo en este canal");

  const videoRes = await youtube.videos.list({
    part: ["liveStreamingDetails"],
    id: [videoId],
  });

  const chatId = videoRes.data.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
  if (!chatId) throw new Error("No se encontró liveChatId para el video " + videoId);

  log("✅ Live chat ID:", chatId);
  return chatId;
}

// ─── ENVIAR MENSAJE AL CHAT ────────────────────────────────────
async function sendMessage(youtube, text) {
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
    log(`📤 Enviado: ${text}`);
  } catch (err) {
    log("❌ Error enviando mensaje:", err.message);
  }
}

// ─── PROCESAR COMANDOS ─────────────────────────────────────────
async function handleCommand(youtube, author, authorId, msg) {
  const parts   = msg.trim().split(/\s+/);
  const comando = parts[0].toLowerCase();

  // ── !saldo ────────────────────────────────────────────────
  if (comando === "!saldo") {
    const ahora = Date.now();
    const ultimo = saldoCooldown.get(authorId) || 0;
    if (ahora - ultimo < COOLDOWN_SALDO_MS) {
      log(`⏳ !saldo de ${author} ignorado (cooldown)`);
      return;
    }
    saldoCooldown.set(authorId, ahora);

    try {
      const cleanAuthor = author.replace(/^[¡!@\s]+/, "").trim().toLowerCase();
      const res = await axios.get(
        `${SERVER_URL}/puntos/${encodeURIComponent(cleanAuthor)}`,
        { timeout: 2000 }
      );
      const pts = res.data.puntos || 0;
      await sendMessage(youtube, `💰 ${author} tenés ${pts} Saurucoins`);
    } catch (e) {
      log("⚠️ Error consultando saldo:", e.message);
    }
    return;
  }

  // ── !top ──────────────────────────────────────────────────
  if (comando === "!top") {
    try {
      const res = await axios.get(`${SERVER_URL}/top?n=3`, { timeout: 2000 });
      const top = res.data;
      if (top.length > 0) {
        const linea = top.map(u => `${u.rank}. ${u.user} (${u.points})`).join(" | ");
        await sendMessage(youtube, `🏆 Top Saurucoins: ${linea}`);
      }
    } catch (e) {
      log("⚠️ Error obteniendo top:", e.message);
    }
    return;
  }
}

// ─── LOOP PRINCIPAL: LEER MENSAJES ────────────────────────────
async function startPolling(youtube) {
  log("🎧 Escuchando el chat...");

  async function readMessages() {
    try {
      const params = {
        part: ["snippet", "authorDetails"],
        liveChatId,
        maxResults: 200,
      };
      if (nextPageToken) params.pageToken = nextPageToken;

      const res = await youtube.liveChatMessages.list(params);
      const items = res.data.items || [];
      nextPageToken = res.data.nextPageToken;

      for (const item of items) {
        const authorId   = item.authorDetails?.channelId;
        const author     = item.authorDetails?.displayName || "";
        const msg        = item.snippet?.textMessageDetails?.messageText || "";
        const publishedAt = item.snippet?.publishedAt;

        // Ignorar mensajes del propio bot
        if (authorId === botChannelId) continue;

        // Solo procesar comandos
        if (!msg.startsWith("!")) continue;

        log(`[CMD] ${author}: ${msg}`);
        await handleCommand(youtube, author, authorId, msg);
      }
    } catch (err) {
      log("⚠️ Error leyendo mensajes:", err.message);
    }

    setTimeout(readMessages, POLL_INTERVAL_MS);
  }

  readMessages();
}

// ─── ENTRADA PRINCIPAL ─────────────────────────────────────────
async function main() {
  log("🤖 Saurubot arrancando...");

  const auth    = await getAuthClient();
  const youtube = google.youtube({ version: "v3", auth });

  log("🔍 Buscando stream activo...");
  liveChatId = await getLiveChatId(youtube);

  await startPolling(youtube);
}

main().catch(err => {
  log("❌ Error fatal:", err.message);
  process.exit(1);
});
