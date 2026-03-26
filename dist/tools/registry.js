class ToolRegistry {
    tools = new Map();
    register(tool) {
        this.tools.set(tool.name, tool);
    }
    getTool(name) {
        return this.tools.get(name);
    }
    getAllTools() {
        return Array.from(this.tools.values());
    }
    getOpenAIToolsConfig() {
        return this.getAllTools().map((t) => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));
    }
    async executeTool(name, args) {
        const tool = this.getTool(name);
        if (!tool) {
            throw new Error(`Tool ${name} non trouvé.`);
        }
        try {
            return await tool.execute(args);
        }
        catch (e) {
            return { error: e?.message || "Erreur inconnue lors de l'exécution de l'outil" };
        }
    }
}
export const registry = new ToolRegistry();
