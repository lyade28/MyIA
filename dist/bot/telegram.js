import { Bot } from "grammy";
import { env } from "../config/env.js";
import { processUserMessage } from "../agent/loop.js";
import { transcribeAudio } from "../agent/llm.js";
import fs from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
export const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
function extractCommandArg(text, command) {
    const regex = new RegExp(`^\\/${command}(?:@\\w+)?\\s*`, "i");
    return text.replace(regex, "").trim();
}
function buildAgentTask(task) {
    return [
        "MODE AGENT AUTO ACTIVE.",
        "Traite cette demande comme une tache d'implementation complete.",
        "Avant d'executer, annonce le nombre d'etapes et le temps estime.",
        "Execute ensuite en respectant les etapes et termine avec: TACHE TERMINEE: ...",
        "",
        `Tache utilisateur: ${task}`,
    ].join("\n");
}
// Middleware strict de Whitelist
bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) {
        return;
    }
    if (!env.TELEGRAM_ALLOWED_USER_IDS.includes(userId)) {
        console.warn(`⚠️ Tentative d'accès bloquée pour l'utilisateur ID: ${userId}`);
        await ctx.reply("⛔ Vous n'êtes pas autorisé à utiliser ce bot.");
        return;
    }
    // Utilisateur autorisé, on passe au middleware suivant
    await next();
});
// Commande pour effacer la mémoire
bot.command("clear", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId)
        return;
    try {
        const { history } = await import("../memory/history.js");
        history.clearHistory(userId);
        await ctx.reply("🧹 **Mémoire effacée !** Je ne me souviens des anciennes conversations. De quoi voulez-vous parler ?", { parse_mode: "Markdown" });
    }
    catch (error) {
        console.error("Erreur clear history:", error);
        await ctx.reply("❌ Erreur lors de l'effacement de la mémoire.");
    }
});
// Commande dédiée: exécution d'une tâche "mode agent"
bot.command("run-agent", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId)
        return;
    const rawText = ctx.message?.text ?? "";
    const task = extractCommandArg(rawText, "run-agent");
    if (!task) {
        await ctx.reply("Usage: /run-agent <tache>\nExemple: /run-agent Cree un composant Angular standalone pour la page dashboard.");
        return;
    }
    await ctx.replyWithChatAction("typing");
    const framedTask = buildAgentTask(task);
    try {
        const response = await processUserMessage(userId, framedTask);
        for (let i = 0; i < response.length; i += 4000) {
            await ctx.reply(response.substring(i, i + 4000));
        }
    }
    catch (error) {
        console.error("❌ Erreur run-agent :", error);
        await ctx.reply("❌ Une erreur est survenue pendant l'execution de /run-agent.");
    }
});
// Gestion des messages texte
bot.on("message:text", async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;
    if (text.trim().startsWith("/"))
        return;
    console.log(`💬 Message de ${userId}: ${text}`);
    // Indicateur "en train de taper..."
    await ctx.replyWithChatAction("typing");
    try {
        const response = await processUserMessage(userId, buildAgentTask(text));
        // Diviser le message s'il est trop long pour Telegram (>4096)
        for (let i = 0; i < response.length; i += 4000) {
            await ctx.reply(response.substring(i, i + 4000));
        }
    }
    catch (error) {
        console.error("❌ Erreur traitement message :", error);
        await ctx.reply("❌ Une erreur est survenue lors du traitement de votre demande.");
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
        // 1. Récupérer le lien du fichier via Telegram
        const file = await ctx.getFile();
        const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        // 2. Télécharger le fichier
        const response = await fetch(fileUrl);
        if (!response.ok)
            throw new Error("Échec du téléchargement du fichier vocal");
        const fileStream = fs.createWriteStream(filePath);
        await pipeline(Readable.fromWeb(response.body), fileStream);
        // 3. Transcrire avec Whisper (Groq)
        console.log(`[Agent] Transcription audio en cours...`);
        const transcribedText = await transcribeAudio(filePath);
        console.log(`[Agent] Audio transcrit : "${transcribedText}"`);
        if (!transcribedText || transcribedText.trim().length === 0) {
            await ctx.reply("Désolé, je n'ai pas pu comprendre l'audio.");
            return;
        }
        // 4. Envoyer le texte à la boucle de l'agent
        await ctx.reply(`📝 _Transcription : ${transcribedText}_`, { parse_mode: "Markdown" });
        const responseText = await processUserMessage(userId, transcribedText);
        // 5. Répondre
        for (let i = 0; i < responseText.length; i += 4000) {
            await ctx.reply(responseText.substring(i, i + 4000));
        }
    }
    catch (error) {
        console.error("❌ Erreur traitement audio :", error);
        await ctx.reply("❌ Une erreur est survenue lors du traitement de votre note vocale.");
    }
    finally {
        // Nettoyage du fichier temporaire
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
});
export async function startBot() {
    console.log("🚀 Lancement du bot Telegram...");
    // Long polling
    bot.start({
        onStart(botInfo) {
            console.log(`✅ Bot ${botInfo.username} démarré en mode sans échec (whitelist active).`);
        },
    });
}
