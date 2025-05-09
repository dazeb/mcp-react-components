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

// Interface for the main index file (harvested_index.json)
interface IndexedComponentInfo {
  name: string; // Display name, e.g., "3d-pin" or "Actual Component Name"
  source: string;
  slug: string;
  description?: string;
  filePath: string; // Relative path to the full JSON, e.g., "aceternity/3d-pin.json"
  jsonUrl: string;
  lastScanned: string;
  dependencies?: string[];
  registryDependencies?: string[];
}

// Interface for the full component data (e.g., data/aceternity/3d-pin.json)
interface FullComponentFile {
  path: string; // Target path for the file, e.g., "components/ui/3d-pin.tsx"
  content: string;
  type?: string; // e.g., "registry:ui"
  target?: string; // Often same as path
}
interface FullComponentData {
  name: string; // Usually the slug, e.g., "3d-pin"
  title?: string; // Display title, e.g., "3d Pin"
  type?: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files: FullComponentFile[];
  author?: string;
  [key: string]: any; // For other properties
}


// In-memory cache for the harvested_index.json content
// Key: "source:componentNameKey", e.g., "aceternity:3DPin"
const inMemoryIndexCache: Record<string, IndexedComponentInfo> = {};
const aceternityRegistryData: Record<string, string> = {}; // Cache for component name (normalized) to its slug, e.g. "3DPin": "3d-pin"

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseDataDir = path.join(__dirname, '..', 'data'); // Base data directory
const indexFilePath = path.join(baseDataDir, 'harvested_index.json');


// Function to load harvested_index.json into memory
function loadIndexIntoMemoryCache() {
  console.error(`Attempting to load index from ${indexFilePath}`);
  if (fs.existsSync(indexFilePath)) {
    try {
      const fileContent = fs.readFileSync(indexFilePath, 'utf8');
      const jsonData = JSON.parse(fileContent) as Record<string, IndexedComponentInfo>;
      // Clear existing cache before loading
      for (const key in inMemoryIndexCache) {
        delete inMemoryIndexCache[key];
      }
      for (const key in jsonData) {
        inMemoryIndexCache[key] = jsonData[key];
      }
      console.error(`Successfully loaded ${Object.keys(inMemoryIndexCache).length} components into memory cache from index.`);
    } catch (error: any) {
      console.error(`Error loading or parsing ${indexFilePath}: ${error.message}. Starting with an empty cache.`);
      // Ensure cache is empty if loading failed
      for (const key in inMemoryIndexCache) {
        delete inMemoryIndexCache[key];
      }
    }
  } else {
    console.warn(`${indexFilePath} not found. Starting with an empty cache.`);
  }
}


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
      const firstKey = Object.keys(aceternityRegistryData)[0];
      const exampleEntry = firstKey ? `${firstKey}: ${aceternityRegistryData[firstKey]}` : "N/A";
      console.error(`Aceternity UI registry cache refreshed. Found ${count} component slugs. Example: ${exampleEntry}`);
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

      const sourceDataDir = path.join(baseDataDir, 'aceternity'); // Source-specific directory
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

      if (!slug) { // If still no slug after potential hardcoding
        console.error(`'${rawComponentName}' (key: ${componentNameKey}) not found in registry and not hardcoded.`);
        if (!providedComponentURL) {
          throw new McpError(ErrorCode.InvalidParams, `'${rawComponentName}' not in registry and no componentURL provided.`);
        }
        // Logic for HTML scraping from providedComponentURL would go here (future enhancement)
        throw new McpError(ErrorCode.InternalError, `Component ${rawComponentName} not in registry, and HTML scraping from provided URL not implemented yet.`);
      }

      finalUrlToFetch = `https://ui.aceternity.com/registry/${slug}.json`;
      console.error(`Attempting to fetch JSON for '${rawComponentName}' (slug: ${slug}) from: ${finalUrlToFetch}`);

      try {
        const response = await axios.get(finalUrlToFetch);
        componentData = response.data; // This should be the JSON object
        console.error(`Successfully fetched JSON for ${rawComponentName}`);

        // Ensure base data directory and source-specific directory exist
        if (!fs.existsSync(baseDataDir)) {
          fs.mkdirSync(baseDataDir, { recursive: true });
        }
        if (!fs.existsSync(sourceDataDir)) {
          fs.mkdirSync(sourceDataDir, { recursive: true });
        }

        // Save the full JSON to its own file
        const componentJsonFilePath = path.join(sourceDataDir, `${slug}.json`);
        fs.writeFileSync(componentJsonFilePath, JSON.stringify(componentData, null, 2), 'utf8');
        console.error(`Saved component JSON to ${componentJsonFilePath}`);

        // Update the central index file
        let indexData: Record<string, any> = {};
        if (fs.existsSync(indexFilePath)) {
          try {
            indexData = JSON.parse(fs.readFileSync(indexFilePath, 'utf8'));
          } catch (e) {
            console.error(`Error parsing existing index file ${indexFilePath}, starting new index.`, e);
            indexData = {};
          }
        }
        
        const componentStorageKey = `aceternity:${componentNameKey}`;
        const newIndexEntry: IndexedComponentInfo = {
          name: componentData.title || componentData.name || rawComponentName, // Prefer title, then name from JSON, then raw
          source: "aceternity",
          slug: slug, // slug from registry or hardcoded
          description: componentData.description || "",
          filePath: path.relative(baseDataDir, componentJsonFilePath), // Store relative path
          jsonUrl: finalUrlToFetch,
          lastScanned: scanDate,
          dependencies: componentData.dependencies || [],
          registryDependencies: componentData.registryDependencies || []
        };
        indexData[componentStorageKey] = newIndexEntry;
        fs.writeFileSync(indexFilePath, JSON.stringify(indexData, null, 2), 'utf8');
        console.error(`Updated index file at ${indexFilePath}`);
        
        // Update in-memory cache
        inMemoryIndexCache[componentStorageKey] = newIndexEntry;

        return {
          content: [{ type: "text", text: `Successfully processed JSON for '${newIndexEntry.name}', saved to ${componentJsonFilePath}, and updated index.` }],
        };

      } catch (error: any) { 
        console.error(`Error during fetching, processing, or storing data for ${rawComponentName} (URL: ${finalUrlToFetch}):`, error);
        let errorMessage = `Failed to process component ${rawComponentName}.`;
        if (axios.isAxiosError(error)) {
          errorMessage += ` Axios error: ${error.message} (URL: ${finalUrlToFetch})`;
        } else if (error instanceof Error) {
          errorMessage += ` Error: ${error.message}`;
        }
        // Optionally, log failure to a separate error log or a section in a general log file
        // For now, just throw McpError
        throw new McpError(ErrorCode.InternalError, errorMessage);
      }
    }

    case "list_harvested_components": {
      const args = request.params.arguments as { source?: string } | undefined;
      const sourceFilter = args?.source || "all";
      
      const componentsToList = Object.values(inMemoryIndexCache).filter(comp => 
        sourceFilter === "all" || comp.source === sourceFilter
      );

      if (componentsToList.length === 0) {
        return { content: [{ type: "text", text: "No components harvested yet." }] };
      }

      const listText = componentsToList.map(c => `- ${c.name} (Source: ${c.source}, Slug: ${c.slug}, Scanned: ${new Date(c.lastScanned).toLocaleString()})`).join("\n");
      return { content: [{ type: "text", text: `Available components:\n${listText}` }] };
    }

    case "get_aceternity_component_prompt": {
      const { componentName: rawComponentNameFromArgs } = request.params.arguments as { componentName: string };
      if (!rawComponentNameFromArgs) {
        throw new McpError(ErrorCode.InvalidParams, "componentName is required.");
      }
      const componentNameKeyForLookup = rawComponentNameFromArgs.replace(/\s+/g, '').replace(/[.-]/g, '');
      const componentStorageLookupKey = `aceternity:${componentNameKeyForLookup}`;
      
      const indexedInfo = inMemoryIndexCache[componentStorageLookupKey];

      if (!indexedInfo) {
        return {
          content: [{ type: "text", text: `Component '${rawComponentNameFromArgs}' (key: ${componentStorageLookupKey}) not found in index. Try scanning it first.` }],
          isError: true,
        };
      }

      const fullComponentJsonPath = path.join(baseDataDir, indexedInfo.filePath);
      if (!fs.existsSync(fullComponentJsonPath)) {
        return {
          content: [{ type: "text", text: `Component data file not found at ${fullComponentJsonPath} for '${indexedInfo.name}'. Index might be stale.` }],
          isError: true,
        };
      }

      let componentData: FullComponentData;
      try {
        componentData = JSON.parse(fs.readFileSync(fullComponentJsonPath, 'utf8')) as FullComponentData;
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error parsing component data file ${fullComponentJsonPath}: ${e.message}` }],
          isError: true,
        };
      }
      
      const displayName = componentData.title || componentData.name || rawComponentNameFromArgs;

      let prompt = `You are given a task to integrate the '${displayName}' React component from Aceternity UI into your codebase.\n\n`;
      prompt += `Please verify your project has the following setup:\n`;
      prompt += `- shadcn/ui project structure (check for components.json, lib/utils.ts)\n`;
      prompt += `- Tailwind CSS (check for tailwind.config.ts)\n`;
      prompt += `- TypeScript (check for tsconfig.json)\n\n`;
      prompt += `If any of these are missing, provide instructions on how to set them up (e.g., 'pnpx shadcn@latest init', install Tailwind, install TypeScript).\n\n`;
      prompt += `Determine the default path for components (usually 'components/ui' or as specified in components.json).\n`;
      prompt += `If the default path for components is not 'components/ui', explain why it's important to use a consistent location like 'components/ui' for shadcn/ui components.\n\n`;
      
      componentData.files.forEach(file => {
        // Use file.path (which is the target path like components/ui/name.tsx)
        prompt += `Copy-paste this component to '${file.path}':\n`; 
        prompt += `File content:\n\`\`\`tsx\n${file.content}\n\`\`\`\n\n`;
      });

      if (componentData.dependencies?.includes("cn") || componentData.files.some(f => f.content.includes("@/lib/utils") || f.content.includes("lib/utils"))) {
        prompt += `This component uses the 'cn' utility function. Ensure you have 'lib/utils.ts' set up by shadcn/ui, which typically contains:\n`;
        prompt += `\`\`\`ts\n`;
        prompt += `import { type ClassValue, clsx } from "clsx"\n`;
        prompt += `import { twMerge } from "tailwind-merge"\n\n`;
        prompt += `export function cn(...inputs: ClassValue[]) {\n`;
        prompt += `  return twMerge(clsx(inputs))\n`;
        prompt += `}\n`;
        prompt += `\`\`\`\n\n`;
      }
      prompt += `After adding the files, import and use the main component (e.g., '${displayName}') in your application where needed.`;

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
  await refreshAceternityRegistryCache(); // Refresh Aceternity component slugs
  loadIndexIntoMemoryCache(); // Load existing harvested components index
  await server.connect(transport);
  console.error('Component Harvester MCP server running on stdio');
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
