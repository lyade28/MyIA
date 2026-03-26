import Groq from "groq-sdk";
import { env } from "../config/env.js";
import fs from "fs";
// Client Groq
export const groq = new Groq({ apiKey: env.GROQ_API_KEY });
// Paramètres LLM
export const MODEL = "llama-3.3-70b-versatile";
export async function chatCompletion(messages, tools) {
    // 1. Tentative Ollama (Local) si configuré
    if (env.OLLAMA_MODEL) {
        try {
            console.log(`🤖 Tentative avec Ollama (${env.OLLAMA_MODEL})...`);
            const response = await fetch(`${env.OLLAMA_API_URL}/v1/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: env.OLLAMA_MODEL,
                    messages,
                    tools: tools && tools.length > 0 ? tools : undefined,
                })
            });
            if (response.ok) {
                const data = await response.json();
                return data.choices?.[0]?.message;
            }
            else {
                const errorText = await response.text();
                console.warn(`⚠️ Ollama a renvoyé l'erreur HTTP: ${response.status} - Détail: ${errorText}. Fallback vers Groq...`);
            }
        }
        catch (ollamaError) {
            console.warn(`⚠️ Erreur de connexion à Ollama: ${ollamaError.message}. Fallback vers Groq...`);
        }
    }
    // 2. Tentative Groq
    try {
        const response = await groq.chat.completions.create({
            model: MODEL,
            messages: messages,
            tools: tools,
            tool_choice: tools && tools.length > 0 ? "auto" : "none",
        });
        return response.choices[0]?.message;
    }
    catch (error) {
        console.error("❌ Erreur Groq:", error);
        // Fallback simple vers OpenRouter si configuré et échoue
        if (env.OPENROUTER_API_KEY) {
            console.log("🔄 Tentative de fallback via OpenRouter...");
            try {
                const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        model: env.OPENROUTER_MODEL,
                        messages,
                        tools: tools && tools.length > 0 ? tools : undefined
                    })
                });
                const data = await response.json();
                return data.choices?.[0]?.message;
            }
            catch (fallbackError) {
                console.error("❌ Erreur OpenRouter fallback:", fallbackError);
                throw fallbackError;
            }
        }
        throw error;
    }
}
export async function transcribeAudio(filePath) {
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
