import { chatCompletion } from "./llm.js";
import { history } from "../memory/history.js";
import { registry } from "../tools/registry.js";
import { env } from "../config/env.js";
const TOKEN_SAVER = env.TOKEN_SAVER;
const MAX_ITERATIONS = TOKEN_SAVER ? 60 : 200;
const HISTORY_LIMIT = TOKEN_SAVER ? 8 : 20;
const MAX_TOOL_CONTENT_CHARS = TOKEN_SAVER ? 700 : 2000;
const MAX_MESSAGE_CONTENT_CHARS = TOKEN_SAVER ? 1400 : 5000;
const SYSTEM_PROMPT = TOKEN_SAVER ? `Tu es OpenGravity, agent dev fiable et concis.
Objectif: livrer du code propre, testé et sans hallucinations.

Règles:
- Toujours en français.
- Ne jamais prétendre avoir modifié un fichier sans appel d'outil.
- Utiliser write_file/execute_command pour les actions réelles.
- Pour Angular 17+: standalone, app.config.ts, app.routes.ts, pas de module.ts.
- Séparer services/models/guards/interceptors, logique métier dans services.
- Sécurité: pas de innerHTML direct, Reactive Forms, guards, interceptor HTTP.
- Projets longs: 1 étape à la fois, tester, annoncer "Étape X terminée", demander validation.
- Avant d'exécuter une tâche, annoncer systématiquement:
  1) le nombre d'étapes prévues,
  2) le détail bref de chaque étape,
  3) une estimation de durée totale.
- Quand tout est fini, terminer la réponse par une confirmation explicite:
  "TACHE TERMINEE: <résultat principal>".
- Réponse utile mais courte (éviter le verbiage).` : `Tu es OpenGravity, un agent IA de développement expert.
Objectif: livrer du code robuste et maintenable selon les besoins utilisateur.

Règles:
- Réponds en français.
- N'invente jamais d'actions non exécutées.
- Utilise les outils pour modifier/valider.
- Sur Angular 17+, applique standalone + architecture claire + sécurité frontend.
- Pour tâches complexes: découpe en étapes, teste à chaque étape, demande validation utilisateur.
- Avant d'exécuter, annonce nombre d'étapes + estimation de durée.
- À la fin, confirme clairement avec "TACHE TERMINEE: ...".`;
function compactContent(content, maxLength) {
    const oneLine = content.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxLength)
        return oneLine;
    return `${oneLine.slice(0, maxLength)} ...[tronqué]`;
}
function compactToolResult(result) {
    if (typeof result === "string")
        return compactContent(result, MAX_TOOL_CONTENT_CHARS);
    try {
        const json = JSON.stringify(result);
        return compactContent(json, MAX_TOOL_CONTENT_CHARS);
    }
    catch {
        return "[résultat outil non sérialisable]";
    }
}
export async function processUserMessage(userId, text) {
    // 1. Ajouter le message de l'utilisateur à l'historique
    history.addMessage(userId, "user", text);
    // 2. Construire la liste des messages
    const userHistory = history.getHistory(userId, HISTORY_LIMIT);
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...userHistory
            .map(msg => {
            const mappedMsg = {
                role: msg.role,
                content: msg.content !== "" ? msg.content : null,
            };
            // Réduire la taille des contenus historiques pour limiter le nombre de tokens.
            if (typeof mappedMsg.content === "string") {
                const maxLen = msg.role === "tool" ? MAX_TOOL_CONTENT_CHARS : MAX_MESSAGE_CONTENT_CHARS;
                mappedMsg.content = compactContent(mappedMsg.content, maxLen);
            }
            if (msg.toolCalls) {
                try {
                    mappedMsg.tool_calls = JSON.parse(msg.toolCalls);
                }
                catch {
                    mappedMsg.tool_calls = undefined;
                }
            }
            if (msg.toolCallId)
                mappedMsg.tool_call_id = msg.toolCallId;
            if (msg.name)
                mappedMsg.name = msg.name;
            // Gemini exige un nom non vide pour les réponses d'outils.
            if (mappedMsg.role === "tool" && !mappedMsg.name) {
                mappedMsg.name = "unknown_tool";
            }
            return mappedMsg;
        })
            // Écarter les messages outils invalides (anciens historiques incomplets).
            .filter((msg) => !(msg.role === "tool" && !msg.tool_call_id))
    ];
    let iterations = 0;
    let finalResponse = "Désolé, j'ai atteint ma limite de réflexion (15 itérations) pour cette tâche spécifique. La requête était peut-être trop complexe ou longue.";
    const verifiedActions = [];
    while (iterations < MAX_ITERATIONS) {
        iterations++;
        const isSimpleChat = TOKEN_SAVER &&
            iterations === 1 &&
            !/[\/\\]|fichier|file|code|projet|crée|cree|modifie|écris|ecris|commande|terminal|install|bug|erreur|fix|refactor/i.test(text);
        const tools = isSimpleChat ? undefined : registry.getOpenAIToolsConfig();
        console.log(`[Agent] Itération ${iterations} - Appel LLM...`);
        try {
            const llmMessage = await chatCompletion(messages, tools);
            if (!llmMessage) {
                break;
            }
            // Ajouter la réponse de l'assistant aux messages contextuels, purgée des clés non supportées par l'API
            messages.push({
                role: "assistant",
                content: llmMessage.content || null,
                ...(llmMessage.tool_calls ? { tool_calls: llmMessage.tool_calls } : {})
            });
            // Sauvegarder dans l'historique si ce message de l'assistant contient des appels d'outils
            if (llmMessage.tool_calls && llmMessage.tool_calls.length > 0) {
                history.addMessage(userId, "assistant", llmMessage.content || "", JSON.stringify(llmMessage.tool_calls));
            }
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
                    if (name === "write_file") {
                        const filePath = typeof args?.path === "string" ? args.path : "(path inconnu)";
                        verifiedActions.push(`write_file: ${filePath}`);
                    }
                    else if (name === "read_file") {
                        const filePath = typeof args?.path === "string" ? args.path : "(path inconnu)";
                        verifiedActions.push(`read_file: ${filePath}`);
                    }
                    else if (name === "list_files") {
                        const dirPath = typeof args?.path === "string" ? args.path : ".";
                        verifiedActions.push(`list_files: ${dirPath}`);
                    }
                    else if (name === "execute_command") {
                        const cmd = typeof args?.command === "string" ? args.command : "(commande inconnue)";
                        const cwd = typeof args?.cwd === "string" ? args.cwd : "(projet actif)";
                        verifiedActions.push(`execute_command: ${cmd} | cwd=${cwd}`);
                    }
                    else {
                        verifiedActions.push(`tool: ${name}`);
                    }
                    const resultStr = TOKEN_SAVER
                        ? compactToolResult(result)
                        : (typeof result === "string" ? result : JSON.stringify(result));
                    messages.push({
                        role: "tool",
                        name: name,
                        tool_call_id: toolCall.id,
                        content: resultStr
                    });
                    // Sauvegarder la réponse de l'outil dans l'historique
                    history.addMessage(userId, "tool", resultStr, undefined, toolCall.id, name);
                }
                continue;
            }
            if (llmMessage.content) {
                const uniqueActions = Array.from(new Set(verifiedActions));
                const actionsSummary = uniqueActions.length > 0
                    ? `\n\nActions verifiees:\n${uniqueActions.map((a) => `- ${a}`).join("\n")}`
                    : "\n\nActions verifiees:\n- Aucune action outil executee dans ce tour.";
                finalResponse = `${llmMessage.content}${actionsSummary}`;
                // On stocke une version compacte pour réduire les tokens des prochains tours.
                history.addMessage(userId, "assistant", TOKEN_SAVER ? compactContent(llmMessage.content, MAX_MESSAGE_CONTENT_CHARS) : llmMessage.content);
                break;
            }
        }
        catch (error) {
            console.error("❌ Erreur dans la boucle de l'agent:", error.message);
            finalResponse = `Une erreur est survenue avec le service LLM. Vérifiez vos clés API et la connexion réseau. Détail: ${error?.message || "inconnu"}`;
            break;
        }
    }
    return finalResponse;
}
