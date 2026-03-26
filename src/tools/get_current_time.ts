import { Tool } from "./registry.js";

export const getCurrentTimeTool: Tool = {
  name: "get_current_time",
  description: "Obtient la date et l'heure actuelles.",
  parameters: {
    type: "object",
    properties: {
      format: {
        type: "string",
        description: "Optionnel: 'iso' ou 'local'. Par défaut: 'local'",
        enum: ["iso", "local"]
      }
    },
    required: [],
  },
  execute: (args) => {
    const date = new Date();
    const format = args.format || "local";
    
    if (format === "iso") {
      return { time: date.toISOString() };
    }
    return { time: date.toLocaleString("fr-FR") };
  },
};
