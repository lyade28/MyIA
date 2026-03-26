import { chatCompletion } from "./llm.js";
import { history } from "../memory/history.js";
import { registry } from "../tools/registry.js";
const MAX_ITERATIONS = 5;
const SYSTEM_PROMPT = `Tu es OpenGravity, un agent IA de développement avec des "Superpowers".
Ton objectif est de créer des applications de haute qualité selon les besoins de l'utilisateur.

### TON WORKFLOW (OBLIGATOIRE) :
1. **Brainstorming** : Avant de coder, pose des questions pour clarifier le besoin. Propose un design.
2. **Planning** : Crée un plan d'implémentation détaillé par micro-tâches avec des chemins de fichiers.
3. **Execution** : Écris le code proprement. Utilise write_file pour créer des fichiers.
4. **Vérification** : Utilise execute_command pour tester si nécessaire.

### RÈGLES CRITIQUES DE TOOL-CALLING (POUR ÉVITER LES ERREURS API) :
- Utilise **UNIQUEMENT** le système d'outils natif (Native Tool Calling) via l'API, en tâche de fond.
- **INTERDICTION FORMELLE** d'écrire ou générer du faux JSON, des balises ou du code comme "TOOLCALL>[...]" dans ton message texte destiné à l'utilisateur.
- Réponds à l'utilisateur de façon cordiale et conversationnelle en français clair, sans laisser fuiter de JSON ou de balise système.
- N'invente jamais d'outils. Utilise uniquement ceux fournis.
- Pour créer un dossier ou un fichier, ne fais pas de 'mkdir' ou 'touch' via execute_command, utilise directement **write_file** (il créera les dossiers parents automatiquement).
- Ne fais JAMAIS d'installation globale (pas de 'npm install -g'). Installe localement si besoin.
- **IMPORTANT CONTEXTE** : Pense à utiliser l'argument 'cwd' pour l'outil execute_command si tu dois agir dans un sous-projet. Et pour write_file, utilise TOUJOURS le chemin relatif complet depuis la racine (ex: 'custom-projet/app/src/fichier.ts').

### TES PRINCIPES :
- DRY (Don't Repeat Yourself) et YAGNI (You Aren't Gonna Need It).
- Réponds toujours en français.`;
export async function processUserMessage(userId, text) {
    // 1. Ajouter le message de l'utilisateur à l'historique
    history.addMessage(userId, "user", text);
    // 2. Construire la liste des messages
    const userHistory = history.getHistory(userId, 20);
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...userHistory.map(msg => ({
            role: msg.role,
            content: msg.content
        }))
    ];
    let iterations = 0;
    let finalResponse = "Désolé, j'ai rencontré une erreur interne lors de ma réflexion.";
    while (iterations < MAX_ITERATIONS) {
        iterations++;
        const tools = registry.getOpenAIToolsConfig();
        console.log(`[Agent] Itération ${iterations} - Appel LLM...`);
        try {
            const llmMessage = await chatCompletion(messages, tools);
            if (!llmMessage) {
                break;
            }
            // Ajouter la réponse de l'assistant aux messages contextuels
            messages.push(llmMessage);
            // --- PATCH POUR OLLAMA / QWEN2.5 ---
            // Certains modèles ressortent les tool calls sous forme de texte balisé au lieu de JSON natif.
            // Ex: <function/execute_command{"command": "ls"}></function>
            if (llmMessage.content && (!llmMessage.tool_calls || llmMessage.tool_calls.length === 0)) {
                const altRegex = /<function\/([a-zA-Z0-9_]+)([\s\S]*?)><\/function>/g;
                let match;
                const extractedTools = [];
                while ((match = altRegex.exec(llmMessage.content)) !== null) {
                    extractedTools.push({
                        id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                        type: "function",
                        function: {
                            name: match[1],
                            arguments: match[2]
                        }
                    });
                }
                if (extractedTools.length > 0) {
                    llmMessage.tool_calls = extractedTools;
                    // Nettoyer le contenu pour l'utilisateur
                    llmMessage.content = llmMessage.content.replace(altRegex, "").trim();
                    if (llmMessage.content === "")
                        llmMessage.content = null;
                }
            }
            // -----------------------------------
            // Si le LLM veut utiliser un outil
            if (llmMessage.tool_calls && llmMessage.tool_calls.length > 0) {
                for (const toolCall of llmMessage.tool_calls) {
                    const name = toolCall.function.name;
                    const argsStr = toolCall.function.arguments;
                    console.log(`[Agent] Outil demandé : ${name} avec args : ${argsStr}`);
                    let argsStrClean = argsStr.trim();
                    // Supprimer les blocs de markdown potentiels qui encadrent parfois le JSON
                    argsStrClean = argsStrClean.replace(/^\\s*\`\`\`(json)?\\s*/i, "").replace(/\\s*\`\`\`\\s*$/i, "").trim();
                    let args = {};
                    try {
                        args = JSON.parse(argsStrClean);
                    }
                    catch (e) {
                        console.error("Erreur de parsing des arguments JSON :", argsStrClean);
                        args = { error: "Format JSON invalide: " + e.message };
                    }
                    const result = await registry.executeTool(name, args);
                    console.log(`[Agent] Résultat outil :`, result);
                    messages.push({
                        role: "tool",
                        name: name,
                        tool_call_id: toolCall.id,
                        content: typeof result === "string" ? result : JSON.stringify(result)
                    });
                }
                continue;
            }
            if (llmMessage.content) {
                finalResponse = llmMessage.content;
                history.addMessage(userId, "assistant", finalResponse);
                break;
            }
        }
        catch (error) {
            console.error("❌ Erreur dans la boucle de l'agent:", error.message);
            finalResponse = "Une erreur est survenue avec le service LLM. Veuillez réessayer ou vérifier la configuration.";
            break;
        }
    }
    return finalResponse;
}
