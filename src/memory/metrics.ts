import { db } from "./db.js";

export interface TaskMetricsInsert {
  taskId: string;
  userId: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  llmCalls: number;
  ok: boolean;
  errorMessage: string | null;
  stepsOk: number;
  stepsTotal: number;
}

export function recordTaskMetrics(row: TaskMetricsInsert): void {
  const stmt = db.prepare(`
    INSERT INTO task_metrics (
      task_id, user_id, started_at, ended_at, duration_ms, llm_calls, ok, error_message, steps_ok, steps_total
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      ended_at = excluded.ended_at,
      duration_ms = excluded.duration_ms,
      llm_calls = excluded.llm_calls,
      ok = excluded.ok,
      error_message = excluded.error_message,
      steps_ok = excluded.steps_ok,
      steps_total = excluded.steps_total
  `);
  stmt.run(
    row.taskId,
    row.userId,
    row.startedAt,
    row.endedAt,
    row.durationMs,
    row.llmCalls,
    row.ok ? 1 : 0,
    row.errorMessage,
    row.stepsOk,
    row.stepsTotal
  );
}

export function getStatsSummary(): {
  totalTasks: number;
  last24h: number;
  successRate: number | null;
  avgDurationMs: number | null;
  avgLlmCalls: number | null;
} {
  const totalRow = db.prepare(`SELECT COUNT(*) as c FROM task_metrics`).get() as { c: number };
  const last24Row = db
    .prepare(
      `SELECT COUNT(*) as c FROM task_metrics WHERE datetime(ended_at) >= datetime('now', '-1 day')`
    )
    .get() as { c: number };
  const okRow = db
    .prepare(`SELECT SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) as okc, COUNT(*) as c FROM task_metrics`)
    .get() as { okc: number | null; c: number };

  const avgRow = db
    .prepare(
      `SELECT AVG(duration_ms) as d, AVG(llm_calls) as l FROM task_metrics WHERE duration_ms IS NOT NULL`
    )
    .get() as { d: number | null; l: number | null };

  const totalTasks = totalRow.c;
  const last24h = last24Row.c;
  const successRate =
    okRow.c > 0 && okRow.okc != null ? okRow.okc / okRow.c : null;
  const avgDurationMs = avgRow.d != null ? Math.round(avgRow.d) : null;
  const avgLlmCalls = avgRow.l != null ? Math.round(avgRow.l * 10) / 10 : null;

  return { totalTasks, last24h, successRate, avgDurationMs, avgLlmCalls };
}

export function formatStatsForTelegram(): string {
  const s = getStatsSummary();
  const rate =
    s.successRate != null ? `${Math.round(s.successRate * 100)}%` : "n/a";
  const dur = s.avgDurationMs != null ? `${s.avgDurationMs} ms` : "n/a";
  const llm = s.avgLlmCalls != null ? `${s.avgLlmCalls}` : "n/a";
  return [
    "📊 **Statistiques (task_metrics)**",
    "",
    `- Tâches enregistrées: **${s.totalTasks}**`,
    `- Dernières 24h: **${s.last24h}**`,
    `- Taux de succès (global): **${rate}**`,
    `- Durée médiane moyenne: **${dur}**`,
    `- Appels LLM moyens / tâche: **${llm}**`,
  ].join("\n");
}
