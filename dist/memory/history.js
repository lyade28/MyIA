import { db } from "./db.js";
import { firebaseHistory } from "./firebase.js";
export const history = {
    addMessage: (userId, role, content) => {
        const stmt = db.prepare("INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)");
        const info = stmt.run(userId, role, content);
        // Sauvegarde asynchrone dans le Cloud (Firebase)
        firebaseHistory.addMessage(userId, role, content).catch(err => console.error("Erreur sync Firebase:", err));
        return {
            id: info.lastInsertRowid,
            userId,
            role,
            content,
        };
    },
    getHistory: (userId, limit = 20) => {
        const stmt = db.prepare("SELECT id, user_id as userId, role, content, created_at as createdAt FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ?");
        const messages = stmt.all(userId, limit);
        return messages.reverse(); // Retourner du plus ancien au plus récent
    },
    clearHistory: (userId) => {
        const stmt = db.prepare("DELETE FROM messages WHERE user_id = ?");
        stmt.run(userId);
    },
};
