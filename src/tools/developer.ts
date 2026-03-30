import { Tool } from "./registry.js";
import fs from "fs";
import path from "path";

/**
 * Suite d'outils permettant à OpenGravity de coder et de gérer des projets.
 */

const STATE_FILE = ".opengravity-state.json";

function ensureWorkspace(): string {
  const workspace = path.resolve(process.cwd(), "workspace");
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
  return workspace;
}

function getStatePath(workspace: string): string {
  return path.join(workspace, STATE_FILE);
}

function readActiveProject(workspace: string): string | null {
  const statePath = getStatePath(workspace);
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const state = JSON.parse(raw) as { activeProjectPath?: string };
    if (!state.activeProjectPath) return null;
    const resolved = path.resolve(workspace, state.activeProjectPath);
    if (!resolved.startsWith(workspace)) return null;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;
    return resolved;
  } catch {
    return null;
  }
}

function detectAngularProjects(workspace: string): string[] {
  try {
    const entries = fs.readdirSync(workspace, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(workspace, entry.name))
      .filter((dirPath) => fs.existsSync(path.join(dirPath, "angular.json")));
  } catch {
    return [];
  }
}

function detectBestProject(workspace: string): string | null {
  const angularProjects = detectAngularProjects(workspace);
  if (angularProjects.length === 1) return angularProjects[0];
  if (angularProjects.length > 1) {
    const sorted = angularProjects.sort((a, b) => {
      const aTime = fs.statSync(a).mtimeMs;
      const bTime = fs.statSync(b).mtimeMs;
      return bTime - aTime;
    });
    return sorted[0];
  }

  // Fallback: dossiers contenant package.json (projet JS/TS générique)
  try {
    const entries = fs.readdirSync(workspace, { withFileTypes: true });
    const jsProjects = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(workspace, entry.name))
      .filter((dirPath) => fs.existsSync(path.join(dirPath, "package.json")));
    if (jsProjects.length === 1) return jsProjects[0];
    if (jsProjects.length > 1) {
      const sorted = jsProjects.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return sorted[0];
    }
  } catch {
    return null;
  }

  return null;
}

function writeActiveProject(workspace: string, absoluteProjectPath: string) {
  const relativePath = path.relative(workspace, absoluteProjectPath);
  fs.writeFileSync(getStatePath(workspace), JSON.stringify({ activeProjectPath: relativePath }, null, 2), "utf8");
}

function resolveBaseDir(workspace: string, optionalCwd?: string): string {
  if (optionalCwd) return path.resolve(workspace, optionalCwd);
  const active = readActiveProject(workspace);
  if (active) return active;

  const detected = detectBestProject(workspace);
  if (detected) {
    writeActiveProject(workspace, detected);
    return detected;
  }
  return workspace;
}

/** Chemins / segments sensibles (secrets, clés) — lecture/écriture refusée dans workspace. */
function isSensitiveProjectPath(normalizedRelativePath: string): boolean {
  const lower = normalizedRelativePath.replace(/\\/g, "/").toLowerCase();
  const base = path.basename(lower);
  const denyNames = new Set([
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".npmrc",
    "id_rsa",
    "id_rsa.pub",
    "credentials.json",
    "service-account.json",
    "firebase-adminsdk",
  ]);
  if (denyNames.has(base) || base.startsWith(".env")) return true;
  if (lower.includes("/.ssh/") || lower.startsWith(".ssh/")) return true;
  if (/(^|\/)secrets(\/|$)/.test(lower)) return true;
  if (/(^|\/)credentials(\/|$)/.test(lower) && /\.json$/i.test(base)) return true;
  if (/\.pem$/i.test(base) || base.endsWith("_rsa")) return true;
  return false;
}

function normalizeProjectRelativePath(baseDir: string, inputPath: string): string {
  const normalizedInput = inputPath.replace(/^\.\/+/, "");
  const baseName = path.basename(baseDir);
  if (!baseName || baseName === "workspace") return normalizedInput;

  // Si le chemin commence déjà par le nom du projet actif, on retire ce préfixe
  // pour éviter les doublons du type task-manager/task-manager/...
  if (normalizedInput === baseName) return ".";
  if (normalizedInput.startsWith(`${baseName}/`)) {
    return normalizedInput.slice(baseName.length + 1);
  }
  return normalizedInput;
}

function extractCreatedProjectPath(command: string, execCwd: string): string | null {
  const ngNewMatch = command.match(/(?:^|\s)ng\s+new\s+([a-zA-Z0-9._-]+)/);
  if (ngNewMatch?.[1]) {
    return path.resolve(execCwd, ngNewMatch[1]);
  }
  return null;
}

// 1. Exécuter une commande shell
export const executeCommandTool: Tool = {
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
      const workspace = ensureWorkspace();
      
      const execCwd = resolveBaseDir(workspace, cwd);
      
      // Empêcher la commande de remonter au-dessus du workspace
      if (!execCwd.startsWith(workspace)) {
        return { success: false, error: "Accès refusé. Les commandes shell doivent être exécutées dans le dossier workspace/." };
      }
      const { exec } = await import("child_process");
      const util = await import("util");
      const execAsync = util.promisify(exec);
      
      const { stdout, stderr } = await execAsync(command, { encoding: "utf8", timeout: 60000, cwd: execCwd });

      const candidateProjectPath = extractCreatedProjectPath(command, execCwd);
      if (candidateProjectPath && candidateProjectPath.startsWith(workspace) && fs.existsSync(candidateProjectPath)) {
        writeActiveProject(workspace, candidateProjectPath);
      } else if (fs.existsSync(path.join(execCwd, "angular.json")) || fs.existsSync(path.join(execCwd, "package.json"))) {
        // Si on exécute déjà dans un projet valide, on le mémorise pour les prochaines actions.
        writeActiveProject(workspace, execCwd);
      }
      
      // On retourne stdout s'il y en a, sinon stderr
      return { success: true, output: stdout || stderr || "Commande exécutée avec succès (sans sortie)." };
    } catch (error: any) {
      return { success: false, error: error.stdout || error.stderr || error.message };
    }
  }
};

// 2. Lire un fichier
export const readFileTool: Tool = {
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
      const workspace = ensureWorkspace();
      const baseDir = resolveBaseDir(workspace);
      const normalizedPath = normalizeProjectRelativePath(baseDir, filePath);
      const fullPath = path.resolve(baseDir, normalizedPath);
      
      // Empêcher la traversée de répertoires (Directory Traversal)
      if (!fullPath.startsWith(workspace)) {
        return { success: false, error: "Accès refusé. Les fichiers doivent être dans le dossier workspace/." };
      }
      if (isSensitiveProjectPath(normalizedPath)) {
        return { success: false, error: "Accès refusé: chemin sensible (secrets / clés) protégé." };
      }
      
      const content = fs.readFileSync(fullPath, "utf8");
      return { success: true, content };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
};

// 3. Écrire dans un fichier
export const writeFileTool: Tool = {
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
      const workspace = ensureWorkspace();
      const baseDir = resolveBaseDir(workspace);
      const normalizedPath = normalizeProjectRelativePath(baseDir, filePath);
      const fullPath = path.resolve(baseDir, normalizedPath);
      
      // Empêcher la traversée de répertoires
      if (!fullPath.startsWith(workspace)) {
        return { success: false, error: "Accès refusé. Les fichiers doivent être écrits dans le dossier workspace/." };
      }
      if (isSensitiveProjectPath(normalizedPath)) {
        return { success: false, error: "Accès refusé: chemin sensible (secrets / clés) protégé." };
      }
      
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content, "utf8");
      return { success: true, message: `Fichier ${filePath} écrit avec succès dans workspace/.` };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
};

// 4. Lister les fichiers
export const listFilesTool: Tool = {
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
      const workspace = ensureWorkspace();
      const baseDir = resolveBaseDir(workspace);
      const normalizedPath = normalizeProjectRelativePath(baseDir, dirPath);
      const fullPath = path.resolve(baseDir, normalizedPath);
      
      // Empêcher la traversée de répertoires
      if (!fullPath.startsWith(workspace)) {
        return { success: false, error: "Accès refusé. Vous ne pouvez lister que le dossier workspace/." };
      }
      if (isSensitiveProjectPath(normalizedPath)) {
        return { success: false, error: "Accès refusé: répertoire sensible protégé." };
      }
      
      const files = fs.readdirSync(fullPath, { withFileTypes: true });
      return {
        success: true,
        files: files.map(f => ({
          name: f.name,
          type: f.isDirectory() ? "directory" : "file"
        }))
      };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
};
