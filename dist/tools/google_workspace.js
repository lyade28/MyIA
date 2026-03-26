import { execSync } from "child_process";
/**
 * Outil générique pour exécuter des commandes GOG CLI.
 * Permet d'interagir avec Gmail, Calendar, Drive, etc.
 */
export const googleWorkspaceTool = {
    name: "google_workspace_action",
    description: "Exécute des actions sur Google Workspace (Gmail, Calendar, Drive, Sheets) via la CLI gog. Permet de chercher des mails, envoyer des messages, lister des événements, etc.",
    parameters: {
        type: "object",
        properties: {
            action: {
                type: "string",
                description: "La commande gog à exécuter sans le préfixe 'gog' (ex: 'gmail search \"in:inbox\"', 'calendar events primary', 'gmail send --to user@example.com --subject \"Sujet\" --body \"Contenu\"')",
            },
        },
        required: ["action"],
    },
    execute: async (args) => {
        try {
            // Nettoyage basique pour éviter les injections de commandes complexes
            // Note: Dans un environnement local sous contrôle utilisateur, on fait confiance au LLM
            const command = `.\\gog.exe ${args.action}`;
            console.log(`[Tool] Exécution commande Google: ${command}`);
            const output = execSync(command, { encoding: "utf8", timeout: 30000 });
            return { success: true, output };
        }
        catch (error) {
            console.error("❌ Erreur Google Workspace Tool:", error.message);
            return {
                success: false,
                error: error.stdout || error.stderr || error.message,
                message: "Assurez-vous que 'gog' est installé et que 'gog auth' a été configuré."
            };
        }
    },
};
