import Groq from "groq-sdk";
import { env } from "../config/env.js";
import fs from "fs";

// Client Groq
export const groq = new Groq({ apiKey: env.GROQ_API_KEY });

// Paramètres LLM
export const MODEL = "llama-3.3-70b-versatile";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export async function chatCompletion(
  messages: ChatMessage[],
  tools?: any[]
): Promise<any> {
  const providerErrors: string[] = [];
  const useTools = !!(tools && tools.length > 0);

  // 1. Tentative Ollama (Local) si configuré (prioritaire)
  if (env.OLLAMA_MODEL) {
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
        if (message) return message;
        providerErrors.push("Ollama: réponse vide");
      } else {
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
            if (message) return message;
          }
          errorText = await response.text();
        }
        providerErrors.push(`Ollama: HTTP ${response.status} (${errorText.slice(0, 200)})`);
        console.warn(`⚠️ Ollama a renvoyé l'erreur HTTP: ${response.status} - Détail: ${errorText}. Fallback vers modèles suivants...`);
      }
    } catch (ollamaError: any) {
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
        if (message) return message;
        providerErrors.push("Gemini: réponse vide");
      } else {
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
            if (message) return message;
          }
          errorText = await response.text();
        }
        providerErrors.push(`Gemini: HTTP ${response.status} (${errorText.slice(0, 200)})`);
        console.warn(`⚠️ Gemini a renvoyé l'erreur HTTP: ${response.status} - Détail: ${errorText}. Fallback vers modèles suivants...`);
      }
    } catch (geminiError: any) {
      providerErrors.push(`Gemini: ${geminiError.message}`);
      console.warn(`⚠️ Erreur de connexion à Gemini: ${geminiError.message}. Fallback...`);
    }
  }

  // 3. Tentative Groq
  try {
    const response = await groq.chat.completions.create({
      model: MODEL,
      messages: messages as any,
      tools: tools,
      tool_choice: tools && tools.length > 0 ? "auto" : "none",
    });

    const message = response.choices?.[0]?.message;
    if (message) return message;
    providerErrors.push("Groq: réponse vide");
  } catch (error: any) {
    console.error("❌ Erreur Groq:", error);
    if (useTools && `${error?.message || ""}`.includes("tool_use_failed")) {
      try {
        console.warn("⚠️ Groq tool_use_failed, nouvelle tentative sans tools...");
        const retry = await groq.chat.completions.create({
          model: MODEL,
          messages: messages as any,
          tool_choice: "none",
        } as any);
        const retryMessage = retry.choices?.[0]?.message;
        if (retryMessage) return retryMessage;
      } catch (retryError: any) {
        providerErrors.push(`Groq retry: ${retryError.message || "erreur inconnue"}`);
      }
    }
    providerErrors.push(`Groq: ${error.message || "erreur inconnue"}`);
    
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
        if (!response.ok) {
          const errorText = await response.text();
          providerErrors.push(`OpenRouter: HTTP ${response.status} (${errorText.slice(0, 200)})`);
        } else {
          const data = await response.json();
          const message = data?.choices?.[0]?.message;
          if (message) return message;
          providerErrors.push("OpenRouter: réponse vide");
        }
      } catch (fallbackError: any) {
        console.error("❌ Erreur OpenRouter fallback:", fallbackError);
        providerErrors.push(`OpenRouter: ${fallbackError.message || "erreur inconnue"}`);
      }
    }
  }

  throw new Error(
    `Aucun fournisseur LLM n'a répondu correctement. Détails: ${providerErrors.join(" | ")}`
  );
}

export async function transcribeAudio(filePath: string): Promise<string> {
  try {
    const translation = await groq.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-large-v3",
      language: "fr", // Forcer le français pour plus de précision
      response_format: "json",
    });
    return translation.text;
  } catch (error) {
    console.error("❌ Erreur transcription Groq:", error);
    throw error;
  }
}
