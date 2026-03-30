import { Bot, Context, NextFunction } from "grammy";
import { env } from "../config/env.js";
import { processUserMessage } from "../agent/loop.js";
import { transcribeAudio } from "../agent/llm.js";
import { formatLlmErrorForUser } from "../agent/llmPolicy.js";
import { formatStatsForTelegram } from "../memory/metrics.js";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { AgentStatusEvent } from "../agents/contracts.js";

export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

function extractCommandArg(text: string, command: string): string {
  const regex = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, "i");
  return text.replace(regex, "").trim();
}

function buildAgentTask(task: string): string {
  return [
    "MODE AGENT AUTO ACTIVE.",
    "Traite cette demande comme une tache d'implementation complete.",
    "Avant d'executer, annonce le nombre d'etapes et le temps estime.",
    "Execute ensuite en respectant les etapes et termine avec: TACHE TERMINEE: ...",
    "",
    `Tache utilisateur: ${task}`,
  ].join("\n");
}

function isStatsAdmin(userId: number): boolean {
  const admins = env.TELEGRAM_ADMIN_USER_IDS ?? env.TELEGRAM_ALLOWED_USER_IDS;
  return admins.includes(userId);
}

async function relayStatusToTelegram(
  event: AgentStatusEvent,
  reply: (text: string) => Promise<any>
) {
  const id = event.taskId ? `[${event.taskId}] ` : "";
  switch (event.type) {
    case "task_start":
      await reply(`🚀 Début de tâche ${id}\n${event.message}`);
      break;
    case "plan":
      await reply(`📋 ${id}${event.message}`);
      break;
    case "step_start":
      await reply(`⏳ ${id}${event.message}`);
      break;
    case "step_done":
      await reply(`✅ ${id}${event.message}`);
      break;
    case "done":
      await reply(
        `🏁 Fin ${id}\n${event.message}\n\nTACHE TERMINEE (orchestration).`
      );
      break;
    case "error":
      await reply(`❌ ${id}${event.message}`);
      break;
    default:
      await reply(`• ${id}${event.message}`);
  }
}

// Middleware strict de Whitelist
bot.use(async (ctx: Context, next: NextFunction) => {
  const userId = ctx.from?.id;

  if (!userId) {
    return;
  }

  if (!env.TELEGRAM_ALLOWED_USER_IDS.includes(userId)) {
    console.warn(`⚠️ Tentative d'accès bloquée pour l'utilisateur ID: ${userId}`);
    await ctx.reply("⛔ Vous n'êtes pas autorisé à utiliser ce bot.");
    return;
  }

  await next();
});

// Commande pour effacer la mémoire
bot.command("clear", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  try {
    const { history } = await import("../memory/history.js");
    history.clearHistory(userId);
    await ctx.reply("🧹 **Mémoire effacée !** Je ne me souviens des anciennes conversations. De quoi voulez-vous parler ?", { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Erreur clear history:", error);
    await ctx.reply("❌ Erreur lors de l'effacement de la mémoire.");
  }
});

bot.command("stats", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  if (!isStatsAdmin(userId)) {
    await ctx.reply("⛔ Commande réservée aux administrateurs.");
    return;
  }
  try {
    await ctx.reply(formatStatsForTelegram(), { parse_mode: "Markdown" });
  } catch (e) {
    console.error("stats:", e);
    await ctx.reply("❌ Impossible de lire les statistiques.");
  }
});

// Commande dédiée: exécution d'une tâche "mode agent"
bot.command("run-agent", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  const rawText = ctx.message?.text ?? "";
  const task = extractCommandArg(rawText, "run-agent");

  if (!task) {
    await ctx.reply(
      "Usage: /run-agent <tache>\nExemple: /run-agent Cree un composant Angular standalone pour la page dashboard."
    );
    return;
  }

  await ctx.replyWithChatAction("typing");

  const framedTask = buildAgentTask(task);

  try {
    const response = await processUserMessage(userId, framedTask, (event) =>
      relayStatusToTelegram(event, (text) => ctx.reply(text))
    );
    for (let i = 0; i < response.length; i += 4000) {
      await ctx.reply(response.substring(i, i + 4000));
    }
  } catch (error: unknown) {
    console.error("❌ Erreur run-agent :", error);
    await ctx.reply(`❌ ${formatLlmErrorForUser(error)}`);
  }
});

// Gestion des messages texte
bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  if (text.trim().startsWith("/")) return;

  console.log(`💬 Message de ${userId}: ${text}`);

  await ctx.replyWithChatAction("typing");

  try {
    const response = await processUserMessage(userId, buildAgentTask(text), (event) =>
      relayStatusToTelegram(event, (txt) => ctx.reply(txt))
    );
    for (let i = 0; i < response.length; i += 4000) {
      await ctx.reply(response.substring(i, i + 4000));
    }
  } catch (error: unknown) {
    console.error("❌ Erreur traitement message :", error);
    await ctx.reply(`❌ ${formatLlmErrorForUser(error)}`);
  }
});

// Gestion des notes vocales
bot.on("message:voice", async (ctx) => {
  const userId = ctx.from.id;
  const voice = ctx.message.voice;

  console.log(`🎤 Note vocale de ${userId} reçue (${voice.duration}s)`);
  await ctx.replyWithChatAction("typing");

  const tempDir = os.tmpdir();
  const filePath = path.join(tempDir, `voice_${Date.now()}.ogg`);

  try {
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error("Échec du téléchargement du fichier vocal");

    const fileStream = fs.createWriteStream(filePath);
    await pipeline(Readable.fromWeb(response.body as any), fileStream);

    console.log(`[Agent] Transcription audio en cours...`);
    const transcribedText = await transcribeAudio(filePath);
    console.log(`[Agent] Audio transcrit : "${transcribedText}"`);

    if (!transcribedText || transcribedText.trim().length === 0) {
      await ctx.reply("Désolé, je n'ai pas pu comprendre l'audio.");
      return;
    }

    await ctx.reply(`📝 _Transcription : ${transcribedText}_`, { parse_mode: "Markdown" });
    const responseText = await processUserMessage(userId, buildAgentTask(transcribedText), (event) =>
      relayStatusToTelegram(event, (txt) => ctx.reply(txt))
    );

    for (let i = 0; i < responseText.length; i += 4000) {
      await ctx.reply(responseText.substring(i, i + 4000));
    }
  } catch (error: unknown) {
    console.error("❌ Erreur traitement audio :", error);
    await ctx.reply(`❌ ${formatLlmErrorForUser(error)}`);
  } finally {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

export async function startBot() {
  console.log("🚀 Lancement du bot Telegram...");
  bot.start({
    onStart(botInfo) {
      console.log(`✅ Bot ${botInfo.username} démarré en mode sans échec (whitelist active).`);
    },
  });
}
