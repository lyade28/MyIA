import Database from "better-sqlite3";
import { env } from "../config/env.js";
import fs from "fs";
import path from "path";

// S'assurer que le dossier parent existe
const dbDir = path.dirname(env.DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(env.DB_PATH);

// Activer le mode WAL pour de meilleures performances
db.pragma("journal_mode = WAL");

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `);

  try { db.exec("ALTER TABLE messages ADD COLUMN tool_calls TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE messages ADD COLUMN tool_call_id TEXT;"); } catch (e) {}
  try { db.exec("ALTER TABLE messages ADD COLUMN name TEXT;"); } catch (e) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      llm_calls INTEGER NOT NULL DEFAULT 0,
      ok INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      steps_ok INTEGER NOT NULL DEFAULT 0,
      steps_total INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_task_metrics_ended ON task_metrics(ended_at);
  `);

  console.log("✅ Base de données initialisée.");
}
