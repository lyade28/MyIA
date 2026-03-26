import { db } from "./db.js";
import { firebaseHistory } from "./firebase.js";

export type Role = "user" | "assistant" | "system" | "tool";

export interface Message {
  id?: number;
  userId: number;
  role: Role;
  content: string;
  toolCalls?: string;
  toolCallId?: string;
  name?: string;
  createdAt?: string;
}

export const history = {
  addMessage: (userId: number, role: Role, content: string, tool_calls?: string, tool_call_id?: string, name?: string): Message => {
    const stmt = db.prepare(
      "INSERT INTO messages (user_id, role, content, tool_calls, tool_call_id, name) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const info = stmt.run(userId, role, content || "", tool_calls || null, tool_call_id || null, name || null);
    
    // Sauvegarde asynchrone dans le Cloud (Firebase)
    firebaseHistory.addMessage(userId, role, content || "", tool_calls, tool_call_id, name).catch(err => 
      console.error("Erreur sync Firebase:", err)
    );

    return {
      id: info.lastInsertRowid as number,
      userId,
      role,
      content: content || "",
      toolCalls: tool_calls,
      toolCallId: tool_call_id,
      name,
    };
  },

  getHistory: (userId: number, limit: number = 20): Message[] => {
    const stmt = db.prepare(
      "SELECT id, user_id as userId, role, content, tool_calls as toolCalls, tool_call_id as toolCallId, name, created_at as createdAt FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
    );
    const messages = stmt.all(userId, limit) as Message[];
    return messages.reverse(); // Retourner du plus ancien au plus récent
  },

  clearHistory: (userId: number) => {
    const stmt = db.prepare("DELETE FROM messages WHERE user_id = ?");
    stmt.run(userId);
  },
};
