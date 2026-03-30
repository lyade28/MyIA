import Groq from "groq-sdk";
import { env } from "../config/env.js";
import fs from "fs";
import {
  fetchWithTransientRetry,
  LLMProviderError,
  recordProviderFailure,
  recordProviderSuccess,
} from "./llmPolicy.js";

// Client Groq
export const groq = env.GROQ_API_KEY ? new Groq({ apiKey: env.GROQ_API_KEY }) : null;

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
  const geminiOnly = env.GEMINI_ONLY;
  const openRouterOnly = env.OPENROUTER_ONLY;

  const callOpenRouter = async () => {
    if (!env.OPENROUTER_API_KEY) {
      providerErrors.push("OpenRouter: OPENROUTER_API_KEY manquante");
      return null;
    }
    console.log(`🤖 Tentative avec OpenRouter (${env.OPENROUTER_MODEL})...`);
    let response = await fetchWithTransientRetry("openrouter", "OpenRouter", () =>
      fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: env.OPENROUTER_MODEL,
          messages,
          tools: useTools ? tools : undefined,
        }),
      })
    );

    if (response.ok) {
      const data = await response.json();
      const message = data?.choices?.[0]?.message;
      if (message) return message;
      providerErrors.push("OpenRouter: réponse vide");
      return null;
    }

    let errorText = await response.text();
    if (useTools && /tool|function|invalid/i.test(errorText)) {
      console.warn("⚠️ OpenRouter a refusé les tools, nouvelle tentative sans tools...");
      response = await fetchWithTransientRetry("openrouter", "OpenRouter(sans tools)", () =>
        fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: env.OPENROUTER_MODEL,
            messages,
          }),
        })
      );
      if (response.ok) {
        const data = await response.json();
        const message = data?.choices?.[0]?.message;
        if (message) return message;
      }
      errorText = await response.text();
    }
    providerErrors.push(`OpenRouter: HTTP ${response.status} (${errorText.slice(0, 200)})`);
    return null;
  };

  if (openRouterOnly) {
    try {
      const openRouterMessage = await callOpenRouter();
      if (openRouterMessage) return openRouterMessage;
    } catch (e: unknown) {
      if (e instanceof LLMProviderError) {
        throw new Error(`Mode OpenRouter-only actif. ${e.message}`);
      }
      throw e;
    }
    throw new Error(`Mode OpenRouter-only actif. Détails: ${providerErrors.join(" | ")}`);
  }

  // 1. Tentative Ollama (Local) si configuré (prioritaire)
  if (!geminiOnly && env.OLLAMA_MODEL) {
    try {
      console.log(`🤖 Tentative avec Ollama (${env.OLLAMA_MODEL})...`);
      let response = await fetchWithTransientRetry("ollama", "Ollama", () =>
        fetch(`${env.OLLAMA_API_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: env.OLLAMA_MODEL,
            messages,
            tools: useTools ? tools : undefined,
          }),
        })
      );

      if (response.ok) {
        const data = await response.json();
        const message = data?.choices?.[0]?.message;
        if (message) return message;
        providerErrors.push("Ollama: réponse vide");
      } else {
        let errorText = await response.text();
        if (useTools && /invalid tool call arguments/i.test(errorText)) {
          console.warn("⚠️ Ollama ne supporte pas ce tool format, nouvelle tentative sans tools...");
          response = await fetchWithTransientRetry("ollama", "Ollama(sans tools)", () =>
            fetch(`${env.OLLAMA_API_URL}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: env.OLLAMA_MODEL,
                messages,
              }),
            })
          );
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
    } catch (ollamaError: unknown) {
      const msg =
        ollamaError instanceof LLMProviderError
          ? ollamaError.message
          : ollamaError instanceof Error
            ? ollamaError.message
            : String(ollamaError);
      providerErrors.push(`Ollama: ${msg}`);
      console.warn(`⚠️ Erreur de connexion à Ollama: ${msg}. Fallback...`);
    }
  }

  // 2. Tentative Gemini (Google AI Studio) si configuré
  if (env.GEMINI_API_KEY) {
    try {
      console.log(`🤖 Tentative avec Gemini (${env.GEMINI_MODEL})...`);
      let response = await fetchWithTransientRetry("gemini", "Gemini", () =>
        fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GEMINI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: env.GEMINI_MODEL,
            messages,
            tools: tools && tools.length > 0 ? tools : undefined,
          }),
        })
      );

      if (response.ok) {
        const data = await response.json();
        const message = data?.choices?.[0]?.message;
        if (message) return message;
        providerErrors.push("Gemini: réponse vide");
      } else {
        let errorText = await response.text();
        if (useTools && /invalid argument/i.test(errorText)) {
          console.warn("⚠️ Gemini refuse la requête avec tools, nouvelle tentative sans tools...");
          response = await fetchWithTransientRetry("gemini", "Gemini(sans tools)", () =>
            fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${env.GEMINI_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: env.GEMINI_MODEL,
                messages,
              }),
            })
          );
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
    } catch (geminiError: unknown) {
      const msg =
        geminiError instanceof LLMProviderError
          ? geminiError.message
          : geminiError instanceof Error
            ? geminiError.message
            : String(geminiError);
      providerErrors.push(`Gemini: ${msg}`);
      console.warn(`⚠️ Erreur de connexion à Gemini: ${msg}. Fallback...`);
    }
  }

  // En mode Gemini-only, on bloque tous les autres fournisseurs.
  if (geminiOnly) {
    throw new Error(
      `Mode Gemini-only actif. Détails: ${providerErrors.join(" | ")}`
    );
  }

  // 3. Tentative Groq
  if (groq) {
    try {
      const response = await groq.chat.completions.create({
        model: MODEL,
        messages: messages as any,
        tools: tools,
        tool_choice: tools && tools.length > 0 ? "auto" : "none",
      });

      const message = response.choices?.[0]?.message;
      if (message) {
        recordProviderSuccess("groq");
        return message;
      }
      recordProviderFailure("groq");
      providerErrors.push("Groq: réponse vide");
    } catch (error: unknown) {
      console.error("❌ Erreur Groq:", error);
      recordProviderFailure("groq");
      const errMsg = error instanceof Error ? error.message : String(error);
      if (useTools && errMsg.includes("tool_use_failed")) {
        try {
          console.warn("⚠️ Groq tool_use_failed, nouvelle tentative sans tools...");
          const retry = await groq.chat.completions.create({
            model: MODEL,
            messages: messages as any,
            tool_choice: "none",
          } as any);
          const retryMessage = retry.choices?.[0]?.message;
          if (retryMessage) {
            recordProviderSuccess("groq");
            return retryMessage;
          }
        } catch (retryError: unknown) {
          const rmsg = retryError instanceof Error ? retryError.message : String(retryError);
          providerErrors.push(`Groq retry: ${rmsg}`);
        }
      }
      providerErrors.push(`Groq: ${errMsg || "erreur inconnue"}`);

      // Fallback simple vers OpenRouter si configuré et échoue
      if (env.OPENROUTER_API_KEY) {
        console.log("🔄 Tentative de fallback via OpenRouter...");
        try {
          const fallbackMessage = await callOpenRouter();
          if (fallbackMessage) return fallbackMessage;
        } catch (fallbackError: unknown) {
          console.error("❌ Erreur OpenRouter fallback:", fallbackError);
          const fmsg =
            fallbackError instanceof LLMProviderError
              ? fallbackError.message
              : fallbackError instanceof Error
                ? fallbackError.message
                : String(fallbackError);
          providerErrors.push(`OpenRouter: ${fmsg}`);
        }
      }
    }
  }

  throw new Error(
    `Aucun fournisseur LLM n'a répondu correctement. Détails: ${providerErrors.join(" | ")}`
  );
}

export async function transcribeAudio(filePath: string): Promise<string> {
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
  } catch (error) {
    console.error("❌ Erreur transcription Groq:", error);
    throw error;
  }
}
