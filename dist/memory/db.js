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
    console.log("✅ Base de données initialisée.");
}
