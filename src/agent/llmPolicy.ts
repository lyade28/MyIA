import { env } from "../config/env.js";

/** Classification pour retry, Telegram et logs. */
export type LlmFailureKind =
  | "transient"
  | "quota"
  | "auth"
  | "timeout"
  | "unknown";

export class LLMProviderError extends Error {
  readonly kind: LlmFailureKind;

  constructor(kind: LlmFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LLMProviderError";
    this.kind = kind;
  }
}

const circuitState = new Map<
  string,
  { failures: number; openUntil: number }
>();

function getState(key: string) {
  let s = circuitState.get(key);
  if (!s) {
    s = { failures: 0, openUntil: 0 };
    circuitState.set(key, s);
  }
  return s;
}

export function assertCircuitClosed(providerKey: string): void {
  const s = getState(providerKey);
  if (Date.now() < s.openUntil) {
    throw new LLMProviderError(
      "transient",
      `Fournisseur ${providerKey} temporairement indisponible (circuit ouvert, réessayez plus tard).`
    );
  }
}

export function recordProviderFailure(providerKey: string): void {
  const s = getState(providerKey);
  s.failures += 1;
  if (s.failures >= env.LLM_CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    s.openUntil = Date.now() + env.LLM_CIRCUIT_BREAKER_COOLDOWN_MS;
    s.failures = 0;
    console.warn(
      `[LLM] Circuit ouvert pour ${providerKey} jusqu'à ${new Date(s.openUntil).toISOString()}`
    );
  }
}

export function recordProviderSuccess(providerKey: string): void {
  const s = getState(providerKey);
  s.failures = 0;
}

export function classifyHttpFailure(status: number, body: string): LlmFailureKind {
  const t = `${status} ${body}`.toLowerCase();
  if (status === 401 || status === 403 || /invalid.*key|unauthoriz|forbidden|api key/i.test(t)) {
    return "auth";
  }
  if (status === 429 || /quota|rate.?limit|too many requests/i.test(t)) {
    return "quota";
  }
  if (status === 408 || status === 504 || /timeout|timed out/i.test(t)) {
    return "timeout";
  }
  if (status >= 500) {
    return "transient";
  }
  if (status >= 400) {
    return "unknown";
  }
  return "unknown";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Message actionnable pour Telegram / utilisateur. */
export function formatLlmErrorForUser(err: unknown): string {
  if (err instanceof LLMProviderError) {
    if (err.kind === "auth") {
      return "Erreur d'authentification API : vérifiez les clés (OPENROUTER, GEMINI, GROQ, OLLAMA) dans l'environnement.";
    }
    if (err.kind === "quota") {
      return "Quota ou limite de débit atteinte : réessayez plus tard ou changez de fournisseur / modèle.";
    }
    if (err.kind === "timeout") {
      return "Délai dépassé côté fournisseur : réessayez ou réduisez la taille du contexte.";
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Retry sur 5xx / erreurs réseau / quota / timeout.
 * Sur 4xx « métier » (ex: tools invalides), retourne la réponse pour permettre un fallback sans tools.
 */
export async function fetchWithTransientRetry(
  providerKey: string,
  label: string,
  doFetch: () => Promise<Response>
): Promise<Response> {
  const max = env.LLM_HTTP_MAX_RETRIES;
  const base = env.LLM_HTTP_RETRY_BASE_MS;

  for (let attempt = 0; attempt <= max; attempt++) {
    assertCircuitClosed(providerKey);
    try {
      const res = await doFetch();
      if (res.ok) {
        recordProviderSuccess(providerKey);
        return res;
      }
      const text = await res.text();
      const kind = classifyHttpFailure(res.status, text);
      if (kind === "auth") {
        recordProviderFailure(providerKey);
        throw new LLMProviderError(
          "auth",
          `${label}: clé ou permissions invalides (HTTP ${res.status}).`
        );
      }
      const retryable =
        res.status >= 500 ||
        kind === "transient" ||
        kind === "timeout" ||
        kind === "quota";
      if (retryable && attempt < max) {
        const delay = base * Math.pow(2, attempt);
        console.warn(`[LLM] ${label} retry ${attempt + 1}/${max} dans ${delay}ms (HTTP ${res.status})`);
        await sleep(delay);
        continue;
      }
      recordProviderFailure(providerKey);
      return new Response(text, { status: res.status, statusText: res.statusText });
    } catch (e: unknown) {
      if (e instanceof LLMProviderError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < max) {
        const delay = base * Math.pow(2, attempt);
        console.warn(`[LLM] ${label} réseau: ${msg}, retry ${attempt + 1}/${max} dans ${delay}ms`);
        await sleep(delay);
        continue;
      }
      recordProviderFailure(providerKey);
      throw new LLMProviderError("transient", `${label}: ${msg}`);
    }
  }

  recordProviderFailure(providerKey);
  throw new LLMProviderError("unknown", `${label}: échec après retries`);
}
