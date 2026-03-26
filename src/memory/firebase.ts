import admin from "firebase-admin";
import { env } from "../config/env.js";
import fs from "fs";

let db: admin.firestore.Firestore | null = null;

export function initFirebase() {
  try {
    if (!fs.existsSync(env.FIREBASE_SERVICE_ACCOUNT_PATH)) {
      console.warn("⚠️ Fichier service-account.json introuvable. Firebase ne sera pas activé.");
      return;
    }

    const serviceAccount = JSON.parse(fs.readFileSync(env.FIREBASE_SERVICE_ACCOUNT_PATH, "utf8"));

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    db = admin.firestore();
    console.log("✅ Connecté à Firebase Firestore via le Cloud.");
  } catch (error) {
    console.error("❌ Erreur lors de l'initialisation de Firebase :", error);
  }
}

export const firebaseHistory = {
  addMessage: async (userId: number, role: string, content: string, tool_calls?: string, tool_call_id?: string, name?: string) => {
    if (!db) return;
    try {
      const payload: any = {
        role,
        content,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      };
      if (tool_calls) payload.tool_calls = tool_calls;
      if (tool_call_id) payload.tool_call_id = tool_call_id;
      if (name) payload.name = name;

      await db.collection("conversations")
        .doc(userId.toString())
        .collection("messages")
        .add(payload);
    } catch (error) {
      console.error("❌ Erreur sauvegarde Firebase :", error);
    }
  }
};
