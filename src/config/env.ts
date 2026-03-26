import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN est requis"),
  TELEGRAM_ALLOWED_USER_IDS: z
    .string()
    .min(1, "TELEGRAM_ALLOWED_USER_IDS est requis")
    .transform((str) => str.split(",").map((id) => parseInt(id.trim(), 10))),
  GROQ_API_KEY: z.string().min(1, "GROQ_API_KEY est requis"),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("openrouter/free"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  OLLAMA_MODEL: z.string().optional(),
  OLLAMA_API_URL: z.string().default("http://localhost:11434"),
  DB_PATH: z.string().default("./memory.db"),
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().default("./service-account.json"),
});

const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error("❌ Erreur de configuration (variables d'environnement) :");
  console.error(_env.error.format());
  process.exit(1);
}

export const env = _env.data;
