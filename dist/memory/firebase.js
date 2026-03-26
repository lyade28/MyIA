import admin from "firebase-admin";
import { env } from "../config/env.js";
import fs from "fs";
let db = null;
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
    }
    catch (error) {
        console.error("❌ Erreur lors de l'initialisation de Firebase :", error);
    }
}
export const firebaseHistory = {
    addMessage: async (userId, role, content) => {
        if (!db)
            return;
        try {
            await db.collection("conversations")
                .doc(userId.toString())
                .collection("messages")
                .add({
                role,
                content,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        catch (error) {
            console.error("❌ Erreur sauvegarde Firebase :", error);
        }
    }
};
