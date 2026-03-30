import {
  AgentStatusEvent,
  AgentStepResult,
  ExecutionMode,
  OrchestrationPlan,
  TaskStep,
} from "./contracts.js";
import { env } from "../config/env.js";

type StepExecutor = (step: TaskStep) => Promise<string>;

function detectMode(input: string): ExecutionMode {
  const t = input.toLowerCase();
  if (/(parallele|parallel|en meme temps|simultan)/.test(t)) return "parallel";
  if (/(hybride|pipeline|chaine et parallele|complexe|architecture)/.test(t)) return "hybrid";
  return "chain";
}

function estimateMinutes(mode: ExecutionMode, stepsCount: number): number {
  const base = mode === "parallel" ? 2 : mode === "hybrid" ? 4 : 3;
  return Math.max(base, Math.ceil((stepsCount * base) / (mode === "parallel" ? 2 : 1)));
}

function applyStepCap(fullSteps: TaskStep[], maxSteps: number): TaskStep[] {
  if (fullSteps.length <= maxSteps) return fullSteps;
  return fullSteps.slice(0, maxSteps);
}

export function buildPlan(userInput: string): OrchestrationPlan {
  const mode = detectMode(userInput);
  const maxPrompt = env.MAX_PROMPT_CHARS_PER_STEP;
  const maxOut = 4000;

  const common: TaskStep[] = [
    {
      id: "plan",
      role: "planner",
      title: "Analyse et plan",
      prompt:
        "Analyse la demande et produis un plan technique court, concret et actionnable. Donne les fichiers cibles.",
      allowTools: false,
      timeoutMs: 30_000,
      retries: 1,
      maxPromptChars: maxPrompt,
      maxOutputChars: maxOut,
    },
    {
      id: "impl",
      role: "developer",
      title: "Implémentation",
      prompt:
        "Implémente la solution demandée. Utilise les outils nécessaires pour modifier le code correctement.",
      allowTools: true,
      timeoutMs: 90_000,
      retries: 1,
      dependsOn: ["plan"],
      maxPromptChars: maxPrompt,
      maxOutputChars: maxOut,
    },
    {
      id: "test",
      role: "tester",
      title: "Validation technique",
      prompt:
        "Valide les changements (build/lint/tests pertinents), résume les résultats et signale les risques restants.",
      allowTools: true,
      timeoutMs: 60_000,
      retries: 1,
      dependsOn: ["impl"],
      maxPromptChars: maxPrompt,
      maxOutputChars: maxOut,
    },
    {
      id: "review",
      role: "reviewer",
      title: "Revue qualité",
      prompt:
        "Fais une revue finale: cohérence, sécurité, maintenabilité, régressions potentielles, et actions restantes.",
      allowTools: false,
      timeoutMs: 40_000,
      retries: 1,
      dependsOn: ["test"],
      maxPromptChars: maxPrompt,
      maxOutputChars: maxOut,
    },
  ];

  const capped = applyStepCap(common, env.MAX_ORCHESTRATION_STEPS);

  let steps: TaskStep[];
  if (mode === "parallel") {
    steps = [
      capped[0],
      ...(capped[1]
        ? [{ ...capped[1], dependsOn: ["plan"] as string[] }]
        : []),
      ...(capped[2]
        ? [{ ...capped[2], dependsOn: ["plan"] as string[] }]
        : []),
      ...(capped[3]
        ? [{ ...capped[3], dependsOn: ["impl", "test"] as string[] }]
        : []),
    ].filter(Boolean) as TaskStep[];
  } else if (mode === "hybrid") {
    steps = [
      capped[0],
      ...(capped[1]
        ? [{ ...capped[1], dependsOn: ["plan"] as string[] }]
        : []),
      ...(capped[2]
        ? [{ ...capped[2], dependsOn: ["impl"] as string[] }]
        : []),
      ...(capped[3]
        ? [{ ...capped[3], dependsOn: ["impl", "test"] as string[] }]
        : []),
    ].filter(Boolean) as TaskStep[];
  } else {
    steps = capped;
  }

  return {
    mode,
    estimatedMinutes: estimateMinutes(mode, steps.length),
    steps,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
}

async function executeStep(
  step: TaskStep,
  executor: StepExecutor
): Promise<AgentStepResult> {
  const start = Date.now();
  let attempt = 0;
  const maxRetries = step.retries ?? 0;
  const timeoutMs = step.timeoutMs ?? 60_000;

  while (attempt <= maxRetries) {
    attempt++;
    try {
      const output = await withTimeout(executor(step), timeoutMs);
      return {
        stepId: step.id,
        role: step.role,
        ok: true,
        output,
        durationMs: Date.now() - start,
      };
    } catch (error: any) {
      if (attempt > maxRetries) {
        return {
          stepId: step.id,
          role: step.role,
          ok: false,
          output: error?.message || "erreur inconnue",
          durationMs: Date.now() - start,
        };
      }
    }
  }

  return {
    stepId: step.id,
    role: step.role,
    ok: false,
    output: "erreur inconnue",
    durationMs: Date.now() - start,
  };
}

export async function runOrchestration(
  plan: OrchestrationPlan,
  executor: StepExecutor,
  onStatus?: (event: AgentStatusEvent) => Promise<void> | void,
  options?: { taskId?: string; planPreview?: string }
): Promise<AgentStepResult[]> {
  const results: AgentStepResult[] = [];
  const done = new Set<string>();
  const taskId = options?.taskId;

  const notify = async (event: AgentStatusEvent) => {
    if (onStatus) await onStatus({ ...event, taskId: event.taskId ?? taskId });
  };

  await notify({
    type: "task_start",
    message:
      options?.planPreview ??
      `Plan: ${plan.steps.length} etapes, mode ${plan.mode}, estimation ${plan.estimatedMinutes} min.`,
  });

  while (done.size < plan.steps.length) {
    const ready = plan.steps.filter(
      (s) => !done.has(s.id) && (s.dependsOn ?? []).every((dep) => done.has(dep))
    );
    if (ready.length === 0) {
      throw new Error("Aucune etape executable (dependances cycliques).");
    }

    const runParallel = plan.mode === "parallel" || (plan.mode === "hybrid" && ready.length > 1);
    const batch = runParallel ? ready : [ready[0]];

    await Promise.all(
      batch.map(async (step) => {
        await notify({ type: "step_start", message: `Debut: ${step.title}` });
        const r = await executeStep(step, executor);
        results.push(r);
        done.add(step.id);
        await notify({
          type: r.ok ? "step_done" : "error",
          message: `${r.ok ? "Termine" : "Echec"}: ${step.title} (${Math.round(
            r.durationMs / 1000
          )}s)`,
        });
      })
    );
  }

  await notify({
    type: "done",
    message: `Orchestration terminee. Etapes: ${plan.steps.length}.`,
  });
  // Keep original order for deterministic summary.
  return plan.steps.map((s) => results.find((r) => r.stepId === s.id)!).filter(Boolean);
}

export function formatPlanPreview(plan: OrchestrationPlan): string {
  const lines = [
    `Je vais executer cette tache en ${plan.steps.length} etapes (mode: ${plan.mode}).`,
    `Temps estime: ~${plan.estimatedMinutes} minutes.`,
    "",
    "Etapes:",
    ...plan.steps.map((s, i) => `${i + 1}. ${s.title}`),
  ];
  return lines.join("\n");
}

export function formatFinalSummary(results: AgentStepResult[]): string {
  const ok = results.every((r) => r.ok);
  const lines = [
    "Bilan d'execution:",
    ...results.map(
      (r, i) =>
        `${i + 1}. [${r.ok ? "OK" : "ECHEC"}] ${r.stepId} (${Math.round(r.durationMs / 1000)}s)`
    ),
    "",
    ok ? "TACHE TERMINEE: Execution multi-agents complete." : "TACHE TERMINEE: execution terminee avec erreurs.",
  ];
  return lines.join("\n");
}

