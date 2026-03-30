import { randomUUID } from "crypto";
import { chatCompletion } from "./llm.js";
import { history } from "../memory/history.js";
import { registry } from "../tools/registry.js";
import { env } from "../config/env.js";
import fs from "fs";
import path from "path";
import { buildPlan, formatFinalSummary, formatPlanPreview, runOrchestration, } from "../agents/orchestrator.js";
import { recordTaskMetrics } from "../memory/metrics.js";
const TOKEN_SAVER = env.TOKEN_SAVER;
const MAX_ITERATIONS = TOKEN_SAVER ? 60 : 200;
const HISTORY_LIMIT = TOKEN_SAVER ? 8 : 20;
const MAX_TOOL_CONTENT_CHARS = TOKEN_SAVER ? 700 : 2000;
const MAX_MESSAGE_CONTENT_CHARS = TOKEN_SAVER ? 1400 : 5000;
const SYSTEM_PROMPT = TOKEN_SAVER
    ? `Tu es OpenGravity, agent dev fiable et concis.
Objectif: livrer du code propre, testé et sans hallucinations.
Règles: français, pas d'hallucination d'actions, Angular 17+ propre, sécurité frontend, réponses courtes.`
    : `Tu es OpenGravity, agent IA de développement expert. Réponds en français et livre du code robuste.`;
function createTaskBudget() {
    const deadline = Date.now() + env.MAX_TASK_DURATION_MS;
    let calls = 0;
    return {
        beforeLlmCall() {
            if (Date.now() > deadline) {
                throw new Error(`Budget temps: la tâche a dépassé ${env.MAX_TASK_DURATION_MS} ms. Réduisez la portée ou augmentez MAX_TASK_DURATION_MS.`);
            }
            calls++;
            if (calls > env.MAX_LLM_CALLS_PER_TASK) {
                throw new Error(`Budget LLM: maximum ${env.MAX_LLM_CALLS_PER_TASK} appels atteint. Ajustez MAX_LLM_CALLS_PER_TASK si besoin.`);
            }
        },
        getCalls: () => calls,
    };
}
function loadCodingAgentSkillSnippet() {
    const candidates = [
        path.resolve(process.cwd(), "SKILL 2.md"),
        path.resolve(process.cwd(), ".codex/skills/coding-agent/SKILL.md"),
    ];
    for (const filePath of candidates) {
        try {
            if (!fs.existsSync(filePath))
                continue;
            const content = fs.readFileSync(filePath, "utf8");
            const lines = content.split("\n");
            const picked = [];
            for (const line of lines) {
                const l = line.trim();
                if (!l)
                    continue;
                if (/Always use `pty:true`/i.test(l))
                    picked.push("- Toujours utiliser pty:true pour les agents CLI interactifs.");
                if (/workdir/i.test(l) && /focused|focus/i.test(l))
                    picked.push("- Toujours fixer workdir au projet cible pour eviter les actions hors contexte.");
                if (/background/i.test(l) && /monitor|progress/i.test(l))
                    picked.push("- Pour longues taches, preferer background + suivi regulier de progression.");
                if (/exec/i.test(l) && /one-shot|runs and exits|exits cleanly/i.test(l))
                    picked.push("- Pour taches simples, preferer un mode one-shot propre.");
                if (/Respect tool choice/i.test(l))
                    picked.push("- Respecter strictement l'agent demande (pas de substitution silencieuse).");
            }
            if (picked.length > 0)
                return picked.slice(0, 5).join("\n");
        }
        catch {
            // ignore read errors, fallback below
        }
    }
    return [
        "- Toujours executer dans le bon dossier projet.",
        "- Utiliser des etapes courtes et verifier apres chaque etape.",
        "- Eviter les actions implicites non verifiees.",
    ].join("\n");
}
const CODING_AGENT_SKILL_SNIPPET = loadCodingAgentSkillSnippet();
function roleSpecificSkillHints(role) {
    if (role === "developer" || role === "planner" || role === "tester") {
        return `Regles skill coding-agent:\n${CODING_AGENT_SKILL_SNIPPET}`;
    }
    return "Regles skill coding-agent: rester concis, verifier et signaler clairement les resultats.";
}
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
        return compactContent(JSON.stringify(result), MAX_TOOL_CONTENT_CHARS);
    }
    catch {
        return "[résultat outil non sérialisable]";
    }
}
function truncateForStep(text, maxChars) {
    if (maxChars == null || maxChars <= 0)
        return text;
    if (text.length <= maxChars)
        return text;
    return `${compactContent(text, maxChars)}\n...[tronqué: budget MAX_PROMPT_CHARS_PER_STEP]`;
}
function buildMessages(userId, userText, systemPrompt) {
    const userHistory = history.getHistory(userId, HISTORY_LIMIT);
    return [
        { role: "system", content: systemPrompt },
        ...userHistory
            .map((msg) => {
            const mappedMsg = {
                role: msg.role,
                content: msg.content !== "" ? msg.content : null,
            };
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
            if (mappedMsg.role === "tool" && !mappedMsg.name)
                mappedMsg.name = "unknown_tool";
            return mappedMsg;
        })
            .filter((msg) => !(msg.role === "tool" && !msg.tool_call_id)),
        { role: "user", content: userText },
    ];
}
async function runSingleAgent(userId, userText, options) {
    let allowTools = options?.allowTools ?? true;
    const systemPrompt = options?.systemPrompt ?? SYSTEM_PROMPT;
    const persistUserMessage = options?.persistUserMessage ?? false;
    const budget = options?.budget;
    const maxOut = options?.maxOutputChars ?? 5000;
    const toolsConfig = registry.getOpenAIToolsConfig();
    if (allowTools && toolsConfig.length === 0) {
        allowTools = false;
    }
    const degradationNote = allowTools === false && (options?.allowTools ?? true)
        ? "\n\nMODE DEGRADE: outils indisponibles — analyse et propose uniquement sans exécution d'outils."
        : "";
    if (persistUserMessage) {
        history.addMessage(userId, "user", userText);
    }
    const messages = buildMessages(userId, userText + degradationNote, systemPrompt);
    let iterations = 0;
    let finalResponse = "Désolé, je n'ai pas pu finaliser correctement cette étape. Réessaie avec plus de détails.";
    const verifiedActions = [];
    while (iterations < MAX_ITERATIONS) {
        iterations++;
        const tools = allowTools ? registry.getOpenAIToolsConfig() : undefined;
        budget?.beforeLlmCall();
        const llmMessage = await chatCompletion(messages, tools);
        if (!llmMessage)
            break;
        messages.push({
            role: "assistant",
            content: llmMessage.content || null,
            ...(llmMessage.tool_calls ? { tool_calls: llmMessage.tool_calls } : {}),
        });
        if (llmMessage.tool_calls && llmMessage.tool_calls.length > 0 && allowTools) {
            for (const toolCall of llmMessage.tool_calls) {
                const name = toolCall.function.name;
                const argsStr = toolCall.function.arguments?.trim() ?? "{}";
                let args = {};
                try {
                    args = JSON.parse(argsStr.replace(/^\s*\`\`\`(json)?\s*/i, "").replace(/\s*\`\`\`\s*$/i, "").trim());
                }
                catch (e) {
                    args = { error: `Format JSON invalide: ${e.message}` };
                }
                const result = await registry.executeTool(name, args);
                const resultStr = TOKEN_SAVER ? compactToolResult(result) : typeof result === "string" ? result : JSON.stringify(result);
                verifiedActions.push(`${name}`);
                messages.push({
                    role: "tool",
                    name,
                    tool_call_id: toolCall.id,
                    content: resultStr,
                });
            }
            continue;
        }
        if (llmMessage.content) {
            const actions = Array.from(new Set(verifiedActions));
            let content = llmMessage.content;
            if (content.length > maxOut) {
                content = compactContent(content, maxOut) + "\n...[sortie tronquée pour budget étape]";
            }
            finalResponse =
                actions.length > 0
                    ? `${content}\n\nActions verifiees:\n${actions.map((a) => `- ${a}`).join("\n")}`
                    : content;
            history.addMessage(userId, "assistant", TOKEN_SAVER ? compactContent(llmMessage.content, MAX_MESSAGE_CONTENT_CHARS) : llmMessage.content);
            break;
        }
    }
    return finalResponse;
}
export async function processUserMessage(userId, text, onStatus) {
    const taskId = randomUUID().slice(0, 8);
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    const budget = createTaskBudget();
    let results = [];
    let caughtError = null;
    try {
        history.addMessage(userId, "user", text);
        const plan = buildPlan(text);
        const planPreview = formatPlanPreview(plan);
        results = await runOrchestration(plan, async (step) => {
            const rolePrompt = truncateForStep([
                `ROLE AGENT: ${step.role}`,
                `OBJECTIF ETAPE: ${step.title}`,
                `INSTRUCTION: ${step.prompt}`,
                roleSpecificSkillHints(step.role),
                `DEMANDE UTILISATEUR: ${text}`,
            ].join("\n"), step.maxPromptChars);
            return await runSingleAgent(userId, rolePrompt, {
                allowTools: step.allowTools,
                persistUserMessage: false,
                budget,
                maxOutputChars: step.maxOutputChars,
            });
        }, onStatus, { taskId, planPreview });
        const details = results
            .map((r, i) => `Etape ${i + 1} (${r.role})\n${compactContent(r.output, 1200)}`)
            .join("\n\n");
        return `${planPreview}\n\n${details}\n\n${formatFinalSummary(results)}`;
    }
    catch (e) {
        caughtError = e instanceof Error ? e.message : String(e);
        if (onStatus) {
            await onStatus({
                type: "error",
                taskId,
                message: `Erreur fatale: ${caughtError}. Action: vérifier les logs serveur et la configuration .env.`,
            });
        }
        throw e;
    }
    finally {
        const ok = caughtError == null && results.length > 0 && results.every((r) => r.ok);
        recordTaskMetrics({
            taskId,
            userId,
            startedAt,
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - t0,
            llmCalls: budget.getCalls(),
            ok,
            errorMessage: caughtError,
            stepsOk: results.filter((r) => r.ok).length,
            stepsTotal: results.length,
        });
    }
}
