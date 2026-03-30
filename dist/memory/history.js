import { db } from "./db.js";
import { firebaseHistory } from "./firebase.js";
export const history = {
    addMessage: (userId, role, content, tool_calls, tool_call_id, name) => {
        const stmt = db.prepare("INSERT INTO messages (user_id, role, content, tool_calls, tool_call_id, name) VALUES (?, ?, ?, ?, ?, ?)");
        const info = stmt.run(userId, role, content || "", tool_calls || null, tool_call_id || null, name || null);
        // Sauvegarde asynchrone dans le Cloud (Firebase)
        firebaseHistory.addMessage(userId, role, content || "", tool_calls, tool_call_id, name).catch(err => console.error("Erreur sync Firebase:", err));
        return {
            id: info.lastInsertRowid,
            userId,
            role,
            content: content || "",
            toolCalls: tool_calls,
            toolCallId: tool_call_id,
            name,
        };
    },
    getHistory: (userId, limit = 20) => {
        const stmt = db.prepare("SELECT id, user_id as userId, role, content, tool_calls as toolCalls, tool_call_id as toolCallId, name, created_at as createdAt FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?");
        const messages = stmt.all(userId, limit);
        return messages.reverse(); // Retourner du plus ancien au plus récent
    },
    clearHistory: (userId) => {
        const stmt = db.prepare("DELETE FROM messages WHERE user_id = ?");
        stmt.run(userId);
    },
};
