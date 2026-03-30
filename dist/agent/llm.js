import Groq from "groq-sdk";
import { env } from "../config/env.js";
import fs from "fs";
// Client Groq
export const groq = env.GROQ_API_KEY ? new Groq({ apiKey: env.GROQ_API_KEY }) : null;
// Paramètres LLM
export const MODEL = "llama-3.3-70b-versatile";
export async function chatCompletion(messages, tools) {
    const providerErrors = [];
    const useTools = !!(tools && tools.length > 0);
    const geminiOnly = env.GEMINI_ONLY;
    const openRouterOnly = env.OPENROUTER_ONLY;
    const callOpenRouter = async () => {
        if (!env.OPENROUTER_API_KEY) {
            providerErrors.push("OpenRouter: OPENROUTER_API_KEY manquante");
            return null;
        }
        console.log(`🤖 Tentative avec OpenRouter (${env.OPENROUTER_MODEL})...`);
        let response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: env.OPENROUTER_MODEL,
                messages,
                tools: useTools ? tools : undefined
            })
        });
        if (response.ok) {
            const data = await response.json();
            const message = data?.choices?.[0]?.message;
            if (message)
                return message;
            providerErrors.push("OpenRouter: réponse vide");
            return null;
        }
        let errorText = await response.text();
        if (useTools && /tool|function|invalid/i.test(errorText)) {
            console.warn("⚠️ OpenRouter a refusé les tools, nouvelle tentative sans tools...");
            response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: env.OPENROUTER_MODEL,
                    messages
                })
            });
            if (response.ok) {
                const data = await response.json();
                const message = data?.choices?.[0]?.message;
                if (message)
                    return message;
            }
            errorText = await response.text();
        }
        providerErrors.push(`OpenRouter: HTTP ${response.status} (${errorText.slice(0, 200)})`);
        return null;
    };
    if (openRouterOnly) {
        const openRouterMessage = await callOpenRouter();
        if (openRouterMessage)
            return openRouterMessage;
        throw new Error(`Mode OpenRouter-only actif. Détails: ${providerErrors.join(" | ")}`);
    }
    // 1. Tentative Ollama (Local) si configuré (prioritaire)
    if (!geminiOnly && env.OLLAMA_MODEL) {
        try {
            console.log(`🤖 Tentative avec Ollama (${env.OLLAMA_MODEL})...`);
            let response = await fetch(`${env.OLLAMA_API_URL}/v1/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: env.OLLAMA_MODEL,
                    messages,
                    tools: useTools ? tools : undefined,
                })
            });
            if (response.ok) {
                const data = await response.json();
                const message = data?.choices?.[0]?.message;
                if (message)
                    return message;
                providerErrors.push("Ollama: réponse vide");
            }
            else {
                let errorText = await response.text();
                if (useTools && /invalid tool call arguments/i.test(errorText)) {
                    console.warn("⚠️ Ollama ne supporte pas ce tool format, nouvelle tentative sans tools...");
                    response = await fetch(`${env.OLLAMA_API_URL}/v1/chat/completions`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            model: env.OLLAMA_MODEL,
                            messages,
                        })
                    });
                    if (response.ok) {
                        const data = await response.json();
                        const message = data?.choices?.[0]?.message;
                        if (message)
                            return message;
                    }
                    errorText = await response.text();
                }
                providerErrors.push(`Ollama: HTTP ${response.status} (${errorText.slice(0, 200)})`);
                console.warn(`⚠️ Ollama a renvoyé l'erreur HTTP: ${response.status} - Détail: ${errorText}. Fallback vers modèles suivants...`);
            }
        }
        catch (ollamaError) {
            providerErrors.push(`Ollama: ${ollamaError.message}`);
            console.warn(`⚠️ Erreur de connexion à Ollama: ${ollamaError.message}. Fallback...`);
        }
    }
    // 2. Tentative Gemini (Google AI Studio) si configuré
    if (env.GEMINI_API_KEY) {
        try {
            console.log(`🤖 Tentative avec Gemini (${env.GEMINI_MODEL})...`);
            let response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${env.GEMINI_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: env.GEMINI_MODEL,
                    messages,
                    tools: tools && tools.length > 0 ? tools : undefined
                })
            });
            if (response.ok) {
                const data = await response.json();
                const message = data?.choices?.[0]?.message;
                if (message)
                    return message;
                providerErrors.push("Gemini: réponse vide");
            }
            else {
                let errorText = await response.text();
                if (useTools && /invalid argument/i.test(errorText)) {
                    console.warn("⚠️ Gemini refuse la requête avec tools, nouvelle tentative sans tools...");
                    response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${env.GEMINI_API_KEY}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            model: env.GEMINI_MODEL,
                            messages
                        })
                    });
                    if (response.ok) {
                        const data = await response.json();
                        const message = data?.choices?.[0]?.message;
                        if (message)
                            return message;
                    }
                    errorText = await response.text();
                }
                providerErrors.push(`Gemini: HTTP ${response.status} (${errorText.slice(0, 200)})`);
                console.warn(`⚠️ Gemini a renvoyé l'erreur HTTP: ${response.status} - Détail: ${errorText}. Fallback vers modèles suivants...`);
            }
        }
        catch (geminiError) {
            providerErrors.push(`Gemini: ${geminiError.message}`);
            console.warn(`⚠️ Erreur de connexion à Gemini: ${geminiError.message}. Fallback...`);
        }
    }
    // En mode Gemini-only, on bloque tous les autres fournisseurs.
    if (geminiOnly) {
        throw new Error(`Mode Gemini-only actif. Détails: ${providerErrors.join(" | ")}`);
    }
    // 3. Tentative Groq
    if (groq) {
        try {
            const response = await groq.chat.completions.create({
                model: MODEL,
                messages: messages,
                tools: tools,
                tool_choice: tools && tools.length > 0 ? "auto" : "none",
            });
            const message = response.choices?.[0]?.message;
            if (message)
                return message;
            providerErrors.push("Groq: réponse vide");
        }
        catch (error) {
            console.error("❌ Erreur Groq:", error);
            if (useTools && `${error?.message || ""}`.includes("tool_use_failed")) {
                try {
                    console.warn("⚠️ Groq tool_use_failed, nouvelle tentative sans tools...");
                    const retry = await groq.chat.completions.create({
                        model: MODEL,
                        messages: messages,
                        tool_choice: "none",
                    });
                    const retryMessage = retry.choices?.[0]?.message;
                    if (retryMessage)
                        return retryMessage;
                }
                catch (retryError) {
                    providerErrors.push(`Groq retry: ${retryError.message || "erreur inconnue"}`);
                }
            }
            providerErrors.push(`Groq: ${error.message || "erreur inconnue"}`);
            // Fallback simple vers OpenRouter si configuré et échoue
            if (env.OPENROUTER_API_KEY) {
                console.log("🔄 Tentative de fallback via OpenRouter...");
                try {
                    const fallbackMessage = await callOpenRouter();
                    if (fallbackMessage)
                        return fallbackMessage;
                }
                catch (fallbackError) {
                    console.error("❌ Erreur OpenRouter fallback:", fallbackError);
                    providerErrors.push(`OpenRouter: ${fallbackError.message || "erreur inconnue"}`);
                }
            }
        }
    }
    throw new Error(`Aucun fournisseur LLM n'a répondu correctement. Détails: ${providerErrors.join(" | ")}`);
}
export async function transcribeAudio(filePath) {
    if (!groq) {
        throw new Error("Transcription indisponible: GROQ_API_KEY non configurée.");
    }
    try {
        const translation = await groq.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-large-v3",
            language: "fr", // Forcer le français pour plus de précision
            response_format: "json",
        });
        return translation.text;
    }
    catch (error) {
        console.error("❌ Erreur transcription Groq:", error);
        throw error;
    }
}
