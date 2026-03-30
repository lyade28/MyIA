import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN est requis"),
  TELEGRAM_ALLOWED_USER_IDS: z
    .string()
    .min(1, "TELEGRAM_ALLOWED_USER_IDS est requis")
    .transform((str) => str.split(",").map((id) => parseInt(id.trim(), 10))),
  GROQ_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("google/gemini-2.0-flash-001"),
  OPENROUTER_ONLY: z
    .string()
    .default("false")
    .transform((value) => value === "true" || value === "1"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  GEMINI_ONLY: z
    .string()
    .default("true")
    .transform((value) => value === "true" || value === "1"),
  OLLAMA_MODEL: z.string().optional(),
  OLLAMA_API_URL: z.string().default("http://localhost:11434"),
  TOKEN_SAVER: z
    .string()
    .default("true")
    .transform((value) => value === "true" || value === "1"),
  /** Durée max d'une tâche orchestrée (ms). */
  MAX_TASK_DURATION_MS: z.coerce.number().default(600_000),
  /** Nombre max d'appels LLM (chatCompletion) par tâche utilisateur. */
  MAX_LLM_CALLS_PER_TASK: z.coerce.number().default(80),
  /** Nombre max d'étapes dans le plan orchestrateur (troncature si dépassement). */
  MAX_ORCHESTRATION_STEPS: z.coerce.number().min(1).max(12).default(4),
  /** Taille max du texte utilisateur par étape (caractères). */
  MAX_PROMPT_CHARS_PER_STEP: z.coerce.number().default(12_000),
  /** Retry HTTP LLM: nombre de tentatives supplémentaires sur erreurs transitoires. */
  LLM_HTTP_MAX_RETRIES: z.coerce.number().min(0).max(5).default(2),
  /** Délai initial backoff (ms). */
  LLM_HTTP_RETRY_BASE_MS: z.coerce.number().min(50).default(500),
  /** Après N échecs consécutifs sur un provider, pause circuit breaker (ms). */
  LLM_CIRCUIT_BREAKER_COOLDOWN_MS: z.coerce.number().default(60_000),
  /** Seuil d'échecs pour ouvrir le circuit breaker. */
  LLM_CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().default(5),
  /** IDs Telegram autorisés pour /stats (séparés par virgule), optionnel = même liste que TELEGRAM_ALLOWED_USER_IDS. */
  TELEGRAM_ADMIN_USER_IDS: z
    .string()
    .optional()
    .transform((str) =>
      str
        ? str.split(",").map((id) => parseInt(id.trim(), 10))
        : undefined
    ),
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
