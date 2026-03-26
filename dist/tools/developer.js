import fs from "fs";
import path from "path";
/**
 * Suite d'outils permettant à OpenGravity de coder et de gérer des projets.
 */
// 1. Exécuter une commande shell
export const executeCommandTool = {
    name: "execute_command",
    description: "Exécute une commande système (npm, git, mkdir, etc.) dans le dossier du projet ou un sous-dossier spécifié.",
    parameters: {
        type: "object",
        properties: {
            command: { type: "string", description: "La commande à exécuter." },
            cwd: { type: "string", description: "Chemin relatif optionnel où exécuter la commande (ex: 'dossier/sous-dossier')." }
        },
        required: ["command"],
    },
    execute: async ({ command, cwd }) => {
        try {
            const execCwd = cwd ? path.resolve(process.cwd(), cwd) : process.cwd();
            const { exec } = await import("child_process");
            const util = await import("util");
            const execAsync = util.promisify(exec);
            const { stdout, stderr } = await execAsync(command, { encoding: "utf8", timeout: 60000, cwd: execCwd });
            // On retourne stdout s'il y en a, sinon stderr
            return { success: true, output: stdout || stderr || "Commande exécutée avec succès (sans sortie)." };
        }
        catch (error) {
            return { success: false, error: error.stdout || error.stderr || error.message };
        }
    }
};
// 2. Lire un fichier
export const readFileTool = {
    name: "read_file",
    description: "Lit le contenu d'un fichier du projet.",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "Chemin relatif du fichier." }
        },
        required: ["path"],
    },
    execute: async ({ path: filePath }) => {
        try {
            const workspace = path.resolve(process.cwd(), "workspace");
            if (!fs.existsSync(workspace))
                fs.mkdirSync(workspace, { recursive: true });
            const fullPath = path.resolve(workspace, filePath);
            // Empêcher la traversée de répertoires (Directory Traversal)
            if (!fullPath.startsWith(workspace)) {
                return { success: false, error: "Accès refusé. Les fichiers doivent être dans le dossier workspace/." };
            }
            const content = fs.readFileSync(fullPath, "utf8");
            return { success: true, content };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
};
// 3. Écrire dans un fichier
export const writeFileTool = {
    name: "write_file",
    description: "Crée ou modifie un fichier dans le projet.",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "Chemin relatif du fichier." },
            content: { type: "string", description: "Contenu à écrire." }
        },
        required: ["path", "content"],
    },
    execute: async ({ path: filePath, content }) => {
        try {
            const workspace = path.resolve(process.cwd(), "workspace");
            if (!fs.existsSync(workspace))
                fs.mkdirSync(workspace, { recursive: true });
            const fullPath = path.resolve(workspace, filePath);
            // Empêcher la traversée de répertoires
            if (!fullPath.startsWith(workspace)) {
                return { success: false, error: "Accès refusé. Les fichiers doivent être écrits dans le dossier workspace/." };
            }
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, content, "utf8");
            return { success: true, message: `Fichier ${filePath} écrit avec succès dans workspace/.` };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
};
// 4. Lister les fichiers
export const listFilesTool = {
    name: "list_files",
    description: "Liste les fichiers et dossiers dans un répertoire.",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "Répertoire à lister (défaut: racine)." }
        },
    },
    execute: async ({ path: dirPath = "." }) => {
        try {
            const workspace = path.resolve(process.cwd(), "workspace");
            if (!fs.existsSync(workspace))
                fs.mkdirSync(workspace, { recursive: true });
            const fullPath = path.resolve(workspace, dirPath);
            // Empêcher la traversée de répertoires
            if (!fullPath.startsWith(workspace)) {
                return { success: false, error: "Accès refusé. Vous ne pouvez lister que le dossier workspace/." };
            }
            const files = fs.readdirSync(fullPath, { withFileTypes: true });
            return {
                success: true,
                files: files.map(f => ({
                    name: f.name,
                    type: f.isDirectory() ? "directory" : "file"
                }))
            };
        }
        catch (error) {
            return { success: false, error: error.message };
        }
    }
};
