import { initDb } from "./memory/db.js";
import { registry } from "./tools/registry.js";
import { getCurrentTimeTool } from "./tools/get_current_time.js";
import { googleWorkspaceTool } from "./tools/google_workspace.js";
import { executeCommandTool, readFileTool, writeFileTool, listFilesTool } from "./tools/developer.js";
import { startBot } from "./bot/telegram.js";
import { initFirebase } from "./memory/firebase.js";
import { env } from "./config/env.js";

async function main() {
  console.log("=== Démarrage d'OpenGravity ===");
  
  // 1. Initialiser la base de données locale & Cloud
  initDb();
  initFirebase();

  // 2. Enregistrer les outils
  registry.register(getCurrentTimeTool);
  registry.register(googleWorkspaceTool);
  registry.register(executeCommandTool);
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(listFilesTool);
  console.log(`✅ Outils enregistrés: ${registry.getAllTools().map(t => t.name).join(", ")}`);

  // 3. Infos sur LLM
  if (env.GEMINI_API_KEY) {
    console.log(`✅ Modèle prêt: Gemini (${env.GEMINI_MODEL})`);
  } else if (env.OLLAMA_MODEL) {
    console.log(`✅ Modèle prêt: Ollama (${env.OLLAMA_MODEL})`);
  } else {
    console.log(`✅ Modèle prêt: ${env.GROQ_API_KEY ? "Groq" : "OpenRouter Fallback"}`);
  }

  // 4. Démarrer le bot
  await startBot();
}

main().catch((err) => {
    console.error("❌ Erreur fatale au démarrage:", err);
    process.exit(1);
});

// Gestion arrêt gracieux
process.once("SIGINT", () => {
    console.log("\nArrêt d'OpenGravity...");
    process.exit(0);
});
process.once("SIGTERM", () => {
    console.log("\nArrêt d'OpenGravity...");
    process.exit(0);
});
