// simular_completo.js
// Simulación completa: mensajes de chat, encuesta con votos, apuesta con resultado.
// Uso: node simular_completo.js
// El servidor debe estar corriendo. La encuesta y apuesta se abren desde el panel
// cuando el script lo indique.

import axios from "axios";

const SERVER = "http://localhost:3000";

const usuarios = ["virgolandia2", "botrix", "iganaciolbs", "palipola", "user-pervic"];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function post(payload) {
  await axios.post(`${SERVER}/chat-event`, payload);
}

async function waitForEnter(msg) {
  process.stdout.write(`\n⏸  ${msg}\n   Presioná ENTER cuando esté listo...`);
  return new Promise(resolve => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

async function simular() {
  console.log("===========================================");
  console.log("  SIMULACIÓN COMPLETA — Saurucoins");
  console.log("===========================================");
  console.log("Usuarios: " + usuarios.join(", "));
  console.log("Puntos iniciales: 100 cada uno\n");

  // ─── FASE 1: MENSAJES DE CHAT ───────────────────────────────
  console.log("── FASE 1: Mensajes de chat (+1 pt c/u) ──");
  for (const user of usuarios) {
    await post({ type: "chatMessage", user });
    console.log(`💬 ${user} mandó un mensaje`);
    await sleep(200);
  }
  console.log("→ Cada usuario debería tener 101 pts\n");

  // ─── FASE 2: ENCUESTA ───────────────────────────────────────
  await waitForEnter("Abrí la encuesta desde el panel (6 opciones, 2 min)");

  console.log("\n── FASE 2: Votos en encuesta (+2 pts c/u) ──");
  const votos = [
    { user: "virgolandia2", option: 1 },
    { user: "botrix",       option: 1 },
    { user: "iganaciolbs",  option: 2 },
    { user: "palipola",     option: 2 },
    { user: "user-pervic",  option: 1 },
  ];
  for (const v of votos) {
    await post({ type: "castVote", user: v.user, option: v.option });
    console.log(`🗳️  ${v.user} votó llave ${v.option}`);
    await sleep(200);
  }
  console.log("→ Cada usuario debería tener 103 pts\n");

  await waitForEnter("Cerrá la encuesta desde el panel y declarás ganador llave 1");

  // ─── FASE 3: APUESTA ────────────────────────────────────────
  await waitForEnter("Abrí la apuesta desde el panel");

  console.log("\n── FASE 3: Apuestas ──");
  const apuestas = [
    { user: "virgolandia2", option: 1, amount: 50 },
    { user: "botrix",       option: 2, amount: 50 },
    { user: "iganaciolbs",  option: 1, amount: 40 },
    { user: "palipola",     option: 2, amount: 40 },
    { user: "user-pervic",  option: 1, amount: 30 },
  ];
  for (const a of apuestas) {
    await post({ type: "placeBet", user: a.user, option: a.option, amount: a.amount });
    await post({ type: "bonusParticipar", user: a.user });
    console.log(`🎲 ${a.user} apostó ${a.amount} pts a opción ${a.option === 1 ? "ALIADOS" : "EJE"}`);
    await sleep(300);
  }

  console.log("\nPozo total: 210 pts");
  console.log("ALIADOS: virgolandia2 50 + iganaciolbs 40 + user-pervic 30 = 120 pts");
  console.log("EJE:     botrix 50 + palipola 40 = 90 pts\n");

  console.log("── Resultados esperados si ganan ALIADOS ──");
  console.log("virgolandia2 : 101 + 2 (voto) - 50 + 2 (bonus) + 87 (ganancia) = 142");
  console.log("iganaciolbs  : 101 + 2 (voto) - 40 + 2 (bonus) + 70 (ganancia) = 135");
  console.log("user-pervic  : 101 + 2 (voto) - 30 + 2 (bonus) + 52 (ganancia) = 127");
  console.log("botrix       : 101 + 2 (voto) - 50 + 2 (bonus)                 =  55");
  console.log("palipola     : 101 + 2 (voto) - 40 + 2 (bonus)                 =  65\n");

  await waitForEnter("Declará ganador ALIADOS desde el panel");
  console.log("✅ Simulación completa. Verificá el top en el panel.");
  process.exit(0);
}

simular();