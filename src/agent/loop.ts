import { chatCompletion, ChatMessage } from "./llm.js";
import { history } from "../memory/history.js";
import { registry } from "../tools/registry.js";

const MAX_ITERATIONS = 200;

const SYSTEM_PROMPT = `Tu es OpenGravity, un agent IA de développement avec des "Superpowers".
Ton objectif est de créer des applications de haute qualité selon les besoins de l'utilisateur.

### TON WORKFLOW (OBLIGATOIRE) :
1. **Brainstorming** : Clarifie le besoin.
2. **Planning** : Crée un plan d'implémentation.
3. **Execution** : Écris LE CODE COMPLET. Utilise toujours l'outil \`write_file\` ou \`execute_command\`.
4. **Vérification** : Teste le résultat.

### RÈGLES CRITIQUES (POUR ÉVITER LES HALLUCINATIONS ET BLOCAGES) :
- **Ne mens JAMAIS**. Ne dis jamais "J'ai créé le fichier" si tu n'as pas explicitement appelé l'outil \`write_file\` avec le contenu complet du code.
- **Pas de code partiel**. Ne laisse pas de commentaires du type "// le reste du code ici". Tu dois générer la totalité du code d'un composant.
- **Commandes Shell** : Si tu utilises \`execute_command\` pour créer un projet (ex: Angular, React, Vite), tu dois OBLIGATOIREMENT utiliser des flags non interactifs (ex: \`--defaults\`, \`-y\`, \`--routing=true --style=css\`). Évite d'inventer des drapeaux malformés (ex: \`--no//router\`).
- **Dépendances NPM** : Si tu rencontres des erreurs ERESOLVE avec \`npm install\`, relance la commande avec \`--legacy-peer-deps\` ou \`--force\`. N'UTILISE PAS d'anciens paquets dépréciés comme \`@angular/flex-layout\`.
- **Frameworks Modernes (ex: Angular)** : Utilise l'architecture Standalone Components (Angular 15+). Ne génère PAS de fichiers \`.module.ts\` (comme \`app-routing.module\`) avec \`ng generate module\` car les projets récents n'en utilisent plus.
- Ne fais jamais d'installation globale. Installe localement si besoin.
- **IMPORTANT CONTEXTE** : Pense à utiliser l'argument 'cwd' pour l'outil execute_command si tu dois agir dans un sous-projet. Et pour write_file, utilise TOUJOURS le chemin relatif complet.

### TES PRINCIPES :
- DRY (Don't Repeat Yourself) et YAGNI.
- Réponds toujours en français.`;

export async function processUserMessage(userId: number, text: string): Promise<string> {
  // 1. Ajouter le message de l'utilisateur à l'historique
  history.addMessage(userId, "user", text);

  // 2. Construire la liste des messages
  const userHistory = history.getHistory(userId, 20);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...userHistory.map(msg => {
      const mappedMsg: any = {
        role: msg.role as "user" | "assistant" | "system" | "tool",
        content: msg.content !== "" ? msg.content : null,
      };
      if (msg.toolCalls) mappedMsg.tool_calls = JSON.parse(msg.toolCalls);
      if (msg.toolCallId) mappedMsg.tool_call_id = msg.toolCallId;
      if (msg.name) mappedMsg.name = msg.name;
      return mappedMsg;
    })
  ];

  let iterations = 0;
  let finalResponse = "Désolé, j'ai atteint ma limite de réflexion (15 itérations) pour cette tâche spécifique. La requête était peut-être trop complexe ou longue.";

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const tools = registry.getOpenAIToolsConfig();

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
          if (llmMessage.content === "") llmMessage.content = null;
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
          } catch (e: any) {
            console.error("Erreur de parsing des arguments JSON :", argsStrClean);
            args = { error: "Format JSON invalide: " + e.message };
          }

          const result = await registry.executeTool(name, args);
          console.log(`[Agent] Résultat outil :`, result);

          const resultStr = typeof result === "string" ? result : JSON.stringify(result);

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
        finalResponse = llmMessage.content;
        history.addMessage(userId, "assistant", finalResponse);
        break;
      }
    } catch (error: any) {
      console.error("❌ Erreur dans la boucle de l'agent:", error.message);
      finalResponse = "Une erreur est survenue avec le service LLM. Veuillez réessayer ou vérifier la configuration.";
      break;
    }
  }

  return finalResponse;
}
