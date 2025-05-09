#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import * as cheerio from 'cheerio'; // Using namespace import for cheerio
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Define the structure for a harvested component
interface HarvestedComponentFile {
  path: string; // e.g., "components/ui/animated-pin.tsx"
  content: string;
}
interface HarvestedComponent {
  name: string; // e.g., "AnimatedPin"
  source: string; // e.g., "aceternity"
  url: string; // Source URL
  files: HarvestedComponentFile[];
  dependencies?: string[]; // e.g., ["cn", "motion"]
  lastScanned: string; // ISO date string
}

// Simple in-memory storage for harvested components
// Key: "source:componentName", e.g., "aceternity:AnimatedPin"
const harvestedComponents: Record<string, HarvestedComponent> = {};
const aceternityRegistryData: Record<string, string> = {}; // Cache for component name (normalized) to its slug, e.g. "3DPin": "3d-pin"

// Function to refresh the Aceternity UI registry cache
async function refreshAceternityRegistryCache() {
  console.error("Attempting to refresh Aceternity UI registry cache...");
  const registryUrl = "https://ui.aceternity.com/registry";
  try {
    const response = await axios.get(registryUrl);
    const html = response.data;
    const $ = cheerio.load(html);

    // Clear previous cache
    for (const key in aceternityRegistryData) {
      delete aceternityRegistryData[key];
    }

    let count = 0;
    // Selector for links to component pages. This might need adjustment.
    // Assuming component links are <a> tags within some identifiable parent,
    // and their href attribute starts with "/components/".
    // A common pattern is a list of cards or items.
    // Example: looking for links within elements that might represent component cards.
    // This is a general guess; specific selectors would be more robust if known.
    $('a[href^="/components/"]').each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      // Extract slug from href (e.g., "/components/sticky-banner" -> "sticky-banner")
      const slug = href.split('/').pop();
      if (!slug || slug === "registry") return; // Skip invalid slugs or the registry link itself

      // Attempt to get a meaningful name.
      // Look for common heading tags or specific class names if known.
      // This is a common pattern: <a href="..."><article><h2>Name</h2>...</article></a>
      // Or <a href="..."><div class="card-title">Name</div>...</a>
      let name = $(el).find('h1, h2, h3, h4, .component-name, .card-title').first().text().trim();
      if (!name) { 
        // Fallback: try to find a direct child div/span that might contain the name
        name = $(el).find('> div, > span').first().text().trim();
      }
      if (!name) { // Last fallback to the direct text of the <a> tag
        name = $(el).clone().children().remove().end().text().trim(); // Get text of <a> excluding children
      }
      
      // Further filter out non-component links if necessary
      if (name && name.length > 0 && name.toLowerCase() !== "all components" && name.toLowerCase() !== "components" && !name.toLowerCase().includes("view all")) {
        // Normalize name to be used as a key (e.g., "3D Pin" -> "3DPin")
        const keyName = name.replace(/\s+/g, '').replace(/[.-]/g, '');
        
        if (keyName && slug) { // Ensure slug is also valid
          aceternityRegistryData[keyName] = slug;
          // console.error(`Found in registry: Name='${name}', Key='${keyName}', Slug='${slug}'`); // Debug log
          count++;
        }
      }
    });

    if (count > 0) {
      console.error(`Aceternity UI registry cache refreshed. Found ${count} component slugs. Example: ${Object.keys(aceternityRegistryData)[0]}: ${aceternityRegistryData[Object.keys(aceternityRegistryData)[0]]}`);
    } else {
      console.warn("No components found in Aceternity UI registry. Check selectors or page structure.");
    }
  } catch (error: any) {
    console.error(`Failed to refresh Aceternity UI registry cache from ${registryUrl}: ${error.message}`);
  }
}

const server = new Server(
  {
    name: "mcp-component-harvester",
    version: "0.1.0",
    description: "Scans websites like Aceternity UI for React components and provides them for integration.",
  },
  {
    capabilities: {
      tools: {},
      // Resources and prompts are not the primary focus for V1
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "scan_aceternity_component",
        description: "Scans a specific Aceternity UI component page and stores the component.",
        inputSchema: {
          type: "object",
          properties: {
            componentName: {
              type: "string",
              description: "The unique name for the component (e.g., 'AnimatedPin', '3D Pin').",
            },
            componentURL: {
              type: "string",
              description: "Optional: The URL of the Aceternity UI page for the component (used as a fallback if not in registry, or for non-Aceternity sources).",
            },
          },
          required: ["componentName"], // componentURL is now optional for Aceternity if found in registry
        },
      },
      {
        name: "list_harvested_components",
        description: "Lists components that have been harvested and stored.",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              enum: ["aceternity", "all"],
              description: "Filter components by source, or 'all'. Defaults to 'all'.",
            },
          },
        },
      },
      {
        name: "get_aceternity_component_prompt",
        description: "Retrieves a harvested Aceternity component and generates a detailed integration prompt.",
        inputSchema: {
          type: "object",
          properties: {
            componentName: {
              type: "string",
              description: "The name of the component to retrieve (e.g., 'AnimatedPin').",
            },
          },
          required: ["componentName"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case "scan_aceternity_component": {
      const { componentName: rawComponentName, componentURL: providedComponentURL } = request.params.arguments as { componentName: string; componentURL?: string; };
      
      if (!rawComponentName) {
        throw new McpError(ErrorCode.InvalidParams, "componentName is required.");
      }
      const componentNameKey = rawComponentName.replace(/\s+/g, '').replace(/[.-]/g, '');

      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const dataDir = path.join(__dirname, '..', 'data');
      const markdownFilePath = path.join(dataDir, 'harvested-components.md');
      const scanDate = new Date().toISOString();
      
      let finalUrlToFetch: string | undefined;
      let componentData: any; // To hold the fetched JSON data
      let slug = aceternityRegistryData[componentNameKey];

      // TEMPORARY HARDCODING FOR "3D Pin" to test JSON fetching if registry parsing fails
      if (componentNameKey === "3DPin" && !slug) {
        console.warn("TEMPORARY: '3DPin' not found in registry, using hardcoded slug '3d-pin'.");
        slug = "3d-pin"; 
      }
      // END TEMPORARY HARDCODING

      if (slug) {
        finalUrlToFetch = `https://ui.aceternity.com/registry/${slug}.json`;
        console.error(`Found '${rawComponentName}' (key: ${componentNameKey}, slug: ${slug}) in registry or by temp hardcode. Attempting to fetch JSON from: ${finalUrlToFetch}`);
        try {
          const response = await axios.get(finalUrlToFetch);
          componentData = response.data; // This should be the JSON object
          console.error(`Successfully fetched JSON for ${rawComponentName}`);
        } catch (jsonError: any) {
          console.error(`Failed to fetch JSON for ${rawComponentName} from ${finalUrlToFetch}: ${jsonError.message}.`);
          if (providedComponentURL) {
            console.warn(`Falling back to provided HTML URL for HTML scraping (not implemented): ${providedComponentURL}`);
            finalUrlToFetch = providedComponentURL; 
            throw new McpError(ErrorCode.InternalError, `Failed to fetch JSON for ${rawComponentName}. HTML fallback for ${providedComponentURL} not implemented yet.`);
          } else {
            throw new McpError(ErrorCode.InternalError, `Component ${rawComponentName} JSON at ${finalUrlToFetch} not found or failed to fetch, and no fallback URL provided.`);
          }
        }
      } else { // Not in registry and not the temporary hardcoded component
        console.error(`'${rawComponentName}' (key: ${componentNameKey}) not found in registry cache and not hardcoded.`);
        if (!providedComponentURL) {
          throw new McpError(ErrorCode.InvalidParams, `'${rawComponentName}' not in registry and no componentURL provided.`);
        }
        finalUrlToFetch = providedComponentURL;
        console.error(`Proceeding with provided URL for HTML scraping (not implemented): ${finalUrlToFetch}`);
        throw new McpError(ErrorCode.InternalError, `Component ${rawComponentName} not in registry. HTML scraping from ${finalUrlToFetch} not implemented yet.`);
      }

      if (!componentData) {
         throw new McpError(ErrorCode.InternalError, "Could not obtain component data.");
      }

      try {
        // Ensure data directory exists
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }

        // Construct Markdown content from the fetched JSON data
        let markdownEntry = `
## ${componentData.name || rawComponentName} (aceternity)

- **Source JSON URL**: ${finalUrlToFetch}
- **Scanned**: ${scanDate}
`;
        if (componentData.description) {
          markdownEntry += `- **Description**: ${componentData.description}\n`;
        }
        if (componentData.dependencies && componentData.dependencies.length > 0) {
          markdownEntry += `- **Dependencies**: ${componentData.dependencies.join(', ')}\n`;
        }
        if (componentData.registryDependencies && componentData.registryDependencies.length > 0) {
          markdownEntry += `- **Registry Dependencies**: ${componentData.registryDependencies.join(', ')}\n`;
        }
        markdownEntry += "\n";

        if (componentData.files && Array.isArray(componentData.files)) {
          componentData.files.forEach((file: { name: string; content: string; path?: string; }) => { // Assuming structure from shadcn/ui registry
            const filePath = file.path || `components/ui/${file.name}`; // Guess path if not provided
            markdownEntry += `### File: ${filePath}\n`;
            markdownEntry += `\`\`\`tsx\n${file.content}\n\`\`\`\n\n`;
          });
        }
        markdownEntry += "---\n";
        
        fs.appendFileSync(markdownFilePath, markdownEntry, 'utf8');

        // Update in-memory store
        const componentStorageKey = `aceternity:${componentNameKey}`; 
        harvestedComponents[componentStorageKey] = {
          name: componentData.name || rawComponentName,
          source: "aceternity",
          url: finalUrlToFetch, // Store the JSON URL
          files: componentData.files?.map((f: any) => ({ path: f.path || `components/ui/${f.name}`, content: f.content })) || [],
          dependencies: componentData.dependencies,
          lastScanned: scanDate,
        };

        return {
          content: [{ type: "text", text: `Successfully processed JSON for '${componentData.name || rawComponentName}' and appended to ${markdownFilePath}.` }],
        };

      } catch (error: any) { // Catch errors related to file writing or data processing
        console.error(`Error processing or storing data for ${rawComponentName}:`, error);
        let errorMessage = `Failed to process or store data for ${rawComponentName}.`;
        if (error instanceof Error) {
          errorMessage += ` Error: ${error.message}`;
        }
        // Log failure to Markdown
        try {
          const errorMarkdownEntry = `
## ${rawComponentName} (aceternity) - FAILED PROCESSING

- **Source URL**: ${finalUrlToFetch}
- **Scanned**: ${scanDate}
- **Error**: ${errorMessage}
---
`;
          fs.appendFileSync(markdownFilePath, errorMarkdownEntry, 'utf8');
        } catch (fileError: any) {
          console.error(`Error writing processing failure to Markdown:`, fileError);
        }
        throw new McpError(ErrorCode.InternalError, errorMessage);
      }
    }

    case "list_harvested_components": {
      const args = request.params.arguments as { source?: string } | undefined;
      const sourceFilter = args?.source || "all";
      
      const componentsToList = Object.values(harvestedComponents).filter(comp => 
        sourceFilter === "all" || comp.source === sourceFilter
      );

      if (componentsToList.length === 0) {
        return { content: [{ type: "text", text: "No components harvested yet." }] };
      }

      const listText = componentsToList.map(c => `- ${c.name} (from ${c.source}, scanned ${c.lastScanned})`).join("\n");
      return { content: [{ type: "text", text: `Available components:\n${listText}` }] };
    }

    case "get_aceternity_component_prompt": {
      const { componentName: rawComponentNameFromArgs } = request.params.arguments as { componentName: string };
      if (!rawComponentNameFromArgs) {
        throw new McpError(ErrorCode.InvalidParams, "componentName is required.");
      }
      // Normalize the input componentName to match the key used during storage
      const componentNameKeyForLookup = rawComponentNameFromArgs.replace(/\s+/g, '').replace(/[.-]/g, '');
      const componentStorageLookupKey = `aceternity:${componentNameKeyForLookup}`;
      
      const component = harvestedComponents[componentStorageLookupKey];

      if (!component) {
        return {
          content: [{ type: "text", text: `Component '${rawComponentNameFromArgs}' (normalized key: ${componentNameKeyForLookup}) from Aceternity not found. Try scanning it first.` }],
          isError: true,
        };
      }

      // Use component.name (which is from the JSON or rawComponentName if JSON had no name) for the prompt
      let prompt = `You are given a task to integrate the '${component.name}' React component from Aceternity UI into your codebase.\n\n`;
      prompt += `Please verify your project has the following setup:\n`;
      prompt += `- shadcn/ui project structure (check for components.json, lib/utils.ts)\n`;
      prompt += `- Tailwind CSS (check for tailwind.config.ts)\n`;
      prompt += `- TypeScript (check for tsconfig.json)\n\n`;
      prompt += `If any of these are missing, provide instructions on how to set them up (e.g., 'pnpx shadcn@latest init', install Tailwind, install TypeScript).\n\n`;
      prompt += `Determine the default path for components (usually 'components/ui' or as specified in components.json).\n`;
      prompt += `If the default path for components is not 'components/ui', explain why it's important to use a consistent location like 'components/ui' for shadcn/ui components.\n\n`;
      
      component.files.forEach(file => {
        prompt += `Copy-paste this component to '${file.path}':\n`;
        prompt += `File content:\n\`\`\`tsx\n${file.content}\n\`\`\`\n\n`;
      });

      if (component.dependencies?.includes("cn")) {
        prompt += `This component uses the 'cn' utility function. Ensure you have 'lib/utils.ts' set up by shadcn/ui, which typically contains:\n`;
        prompt += `\`\`\`ts\n`;
        prompt += `import { type ClassValue, clsx } from "clsx"\n`;
        prompt += `import { twMerge } from "tailwind-merge"\n\n`;
        prompt += `export function cn(...inputs: ClassValue[]) {\n`;
        prompt += `  return twMerge(clsx(inputs))\n`;
        prompt += `}\n`;
        prompt += `\`\`\`\n\n`;
      }
      prompt += `After adding the files, import and use the main component (e.g., '${component.name}') in your application where needed.`;


      return { content: [{ type: "text", text: prompt }] };
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  server.onerror = (error) => console.error('[MCP Error]', error);
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });
  await refreshAceternityRegistryCache(); // Call on server startup
  await server.connect(transport);
  console.error('Component Harvester MCP server running on stdio');
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
