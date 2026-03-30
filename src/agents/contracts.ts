export type AgentRole = "planner" | "developer" | "tester" | "reviewer" | "documenter";

export type ExecutionMode = "chain" | "parallel" | "hybrid";

export interface TaskStep {
  id: string;
  role: AgentRole;
  title: string;
  prompt: string;
  allowTools: boolean;
  dependsOn?: string[];
  timeoutMs?: number;
  retries?: number;
  /** Limite approximative de taille du prompt utilisateur pour cette étape (caractères). */
  maxPromptChars?: number;
  /** Limite de taille de la sortie attendue (troncature côté agrégation). */
  maxOutputChars?: number;
}

export interface OrchestrationPlan {
  mode: ExecutionMode;
  estimatedMinutes: number;
  steps: TaskStep[];
}

export interface AgentStepResult {
  stepId: string;
  role: AgentRole;
  ok: boolean;
  output: string;
  durationMs: number;
}

export interface AgentStatusEvent {
  type: "task_start" | "plan" | "step_start" | "step_done" | "done" | "error";
  message: string;
  /** Identifiant unique de la tâche (suivi Telegram / logs). */
  taskId?: string;
}

