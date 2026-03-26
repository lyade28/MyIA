import { chatCompletion, ChatMessage } from "./llm.js";
import { history } from "../memory/history.js";
import { registry } from "../tools/registry.js";

const MAX_ITERATIONS = 200;
const HISTORY_LIMIT = 12;
const MAX_TOOL_CONTENT_CHARS = 1500;
const MAX_MESSAGE_CONTENT_CHARS = 4000;

const SYSTEM_PROMPT = `Tu es OpenGravity, un agent IA de développement avec des "Superpowers".
Ton objectif est de créer des applications de haute qualité selon les besoins de l'utilisateur.

### TON WORKFLOW (OBLIGATOIRE) :
1. **Brainstorming** : Clarifie le besoin.
2. **Planning** : Crée un plan d'implémentation.
3. **Execution** : Écris LE CODE COMPLET. Utilise toujours l'outil \`write_file\` ou \`execute_command\`.
4. **Vérification** : Teste le résultat.

### PROTOCOLE PROJETS LONGS (OBLIGATOIRE) :
- Si la demande est longue/complexe, découpe en étapes courtes (3 à 7 étapes max).
- N'exécute qu'UNE étape à la fois.
- À la fin de chaque étape :
  1) exécute des tests/validations adaptés à l'étape (\`npm run build\`, tests unitaires, lint, etc.),
  2) annonce clairement "Étape X terminée",
  3) liste ce qui a été fait et les fichiers touchés,
  4) demande explicitement la validation utilisateur avant de passer à l'étape suivante.
- Ne passe JAMAIS automatiquement à l'étape suivante sans validation explicite de l'utilisateur.

### RÈGLES CRITIQUES (POUR ÉVITER LES HALLUCINATIONS ET BLOCAGES) :
- **Ne mens JAMAIS**. Ne dis jamais "J'ai créé le fichier" si tu n'as pas explicitement appelé l'outil \`write_file\` avec le contenu complet du code.
- **Transparence obligatoire** : En fin de réponse, liste les chemins exacts réellement créés/modifiés et les commandes réellement exécutées.
- **Pas de code partiel**. Ne laisse pas de commentaires du type "// le reste du code ici". Tu dois générer la totalité du code d'un composant.
- **Commandes Shell** : Si tu utilises \`execute_command\` pour créer un projet (ex: Angular, React, Vite), tu dois OBLIGATOIREMENT utiliser des flags non interactifs (ex: \`--defaults\`, \`-y\`, \`--routing=true --style=css\`). Évite d'inventer des drapeaux malformés (ex: \`--no//router\`).
- **Dépendances NPM** : Si tu rencontres des erreurs ERESOLVE avec \`npm install\`, relance la commande avec \`--legacy-peer-deps\` ou \`--force\`. N'UTILISE PAS d'anciens paquets dépréciés comme \`@angular/flex-layout\`.
- **Frameworks Modernes (Angular 17+)** : Utilise Standalone Components, \`bootstrapApplication\`, \`app.config.ts\`, \`app.routes.ts\`. Ne génère pas de \`.module.ts\`.
- **Architecture Angular stricte** : sépare \`components\`, \`services\`, \`models\`, \`guards\`, \`interceptors\`; logique métier dans les services; composants simples.
- **Qualité Angular expert** : priorité RxJS, \`ChangeDetectionStrategy.OnPush\`, Reactive Forms, code DRY, lisible, maintenable.
- **Sécurité Angular** : n'utilise jamais \`innerHTML\` directement, n'expose jamais de secrets, utilise guards pour routes sécurisées, toutes requêtes HTTP passent par interceptor.
- Ne fais jamais d'installation globale. Installe localement si besoin.
- **IMPORTANT CONTEXTE** : Pense à utiliser l'argument 'cwd' pour l'outil execute_command si tu dois agir dans un sous-projet. Et pour write_file, utilise TOUJOURS le chemin relatif complet.

### TES PRINCIPES :
- DRY (Don't Repeat Yourself) et YAGNI.
- Réponds toujours en français.`;

export async function processUserMessage(userId: number, text: string): Promise<string> {
  // 1. Ajouter le message de l'utilisateur à l'historique
  history.addMessage(userId, "user", text);

  // 2. Construire la liste des messages
  const userHistory = history.getHistory(userId, HISTORY_LIMIT);

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...userHistory
    .map(msg => {
      const mappedMsg: any = {
        role: msg.role as "user" | "assistant" | "system" | "tool",
        content: msg.content !== "" ? msg.content : null,
      };
      // Réduire la taille des contenus historiques pour limiter le nombre de tokens.
      if (typeof mappedMsg.content === "string") {
        const maxLen = msg.role === "tool" ? MAX_TOOL_CONTENT_CHARS : MAX_MESSAGE_CONTENT_CHARS;
        if (mappedMsg.content.length > maxLen) {
          mappedMsg.content = `${mappedMsg.content.slice(0, maxLen)}\n...[contenu tronqué]`;
        }
      }
      if (msg.toolCalls) {
        try {
          mappedMsg.tool_calls = JSON.parse(msg.toolCalls);
        } catch {
          mappedMsg.tool_calls = undefined;
        }
      }
      if (msg.toolCallId) mappedMsg.tool_call_id = msg.toolCallId;
      if (msg.name) mappedMsg.name = msg.name;
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
  const verifiedActions: string[] = [];

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
          if (name === "write_file") {
            const filePath = typeof (args as any)?.path === "string" ? (args as any).path : "(path inconnu)";
            verifiedActions.push(`write_file: ${filePath}`);
          } else if (name === "read_file") {
            const filePath = typeof (args as any)?.path === "string" ? (args as any).path : "(path inconnu)";
            verifiedActions.push(`read_file: ${filePath}`);
          } else if (name === "list_files") {
            const dirPath = typeof (args as any)?.path === "string" ? (args as any).path : ".";
            verifiedActions.push(`list_files: ${dirPath}`);
          } else if (name === "execute_command") {
            const cmd = typeof (args as any)?.command === "string" ? (args as any).command : "(commande inconnue)";
            const cwd = typeof (args as any)?.cwd === "string" ? (args as any).cwd : "(projet actif)";
            verifiedActions.push(`execute_command: ${cmd} | cwd=${cwd}`);
          } else {
            verifiedActions.push(`tool: ${name}`);
          }

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
        const uniqueActions = Array.from(new Set(verifiedActions));
        const actionsSummary =
          uniqueActions.length > 0
            ? `\n\nActions verifiees:\n${uniqueActions.map((a) => `- ${a}`).join("\n")}`
            : "\n\nActions verifiees:\n- Aucune action outil executee dans ce tour.";
        finalResponse = `${llmMessage.content}${actionsSummary}`;
        history.addMessage(userId, "assistant", finalResponse);
        break;
      }
    } catch (error: any) {
      console.error("❌ Erreur dans la boucle de l'agent:", error.message);
      finalResponse = `Une erreur est survenue avec le service LLM. Vérifiez vos clés API et la connexion réseau. Détail: ${error?.message || "inconnu"}`;
      break;
    }
  }

  return finalResponse;
}
