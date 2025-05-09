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

// For Shadcn, we'll store the whole registry entry object, not just the slug, as there's no further per-component JSON to fetch.
interface ShadcnRegistryEntry {
  name: string; // This is the slug
  type: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files: string[]; // Array of file paths
  [key: string]: any; // Other potential properties
}
const shadcnRegistryData: Record<string, ShadcnRegistryEntry> = {}; // Cache for shadcn component key to its full registry object

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
    const response = await axios.get(registryUrl, { responseType: 'json' });
    // The data is expected to be a JSON array of component objects
    const components = response.data as Array<{ name: string, [key: string]: any }>;

    // Clear previous cache
    for (const key in aceternityRegistryData) {
      delete aceternityRegistryData[key];
    }

    let count = 0;
    for (const component of components) {
      const slug = component.name; // 'name' field in the JSON is the slug
      if (slug) {
        // Create a display name from the slug, e.g., "3d-pin" -> "3D Pin"
        const displayName = slug
          .split('-')
          .map(part => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ');
        const keyName = displayName.replace(/\s+/g, '').replace(/[.-]/g, ''); // Normalize for cache key
        
        aceternityRegistryData[keyName] = slug;
        count++;
      }
    }

    if (count > 0) {
      const firstKey = Object.keys(aceternityRegistryData)[0];
      const exampleEntry = firstKey ? `${firstKey}: ${aceternityRegistryData[firstKey]}` : "N/A";
      console.error(`Aceternity UI registry cache refreshed. Found ${count} component slugs. Example: ${exampleEntry}`);
    } else {
      console.warn("No components found in Aceternity UI registry JSON.");
    }
  } catch (error: any) {
    console.error(`Failed to refresh Aceternity UI registry cache from ${registryUrl}: ${error.message}`);
    if (axios.isAxiosError(error)) {
      console.error(`Axios error details: status ${error.response?.status}, data ${JSON.stringify(error.response?.data)}`);
    }
  }
}

// Function to refresh the shadcn UI registry cache
async function refreshShadcnRegistryCache() {
  console.error("Attempting to refresh shadcn UI registry cache from https://ui.shadcn.com/registry...");
  const registryUrl = "https://ui.shadcn.com/registry";
  try {
    const response = await axios.get(registryUrl, { responseType: 'json' });
    // The data is expected to be a JSON array of component objects
    const components = response.data as Array<ShadcnRegistryEntry>;

    // Clear previous cache
    for (const key in shadcnRegistryData) {
      delete shadcnRegistryData[key];
    }

    let count = 0;
    for (const component of components) {
      const slug = component.name; // 'name' field in the JSON is the slug
      if (slug) {
        // Create a display name from the slug, e.g., "alert-dialog" -> "Alert Dialog"
        const displayName = slug
          .split('-')
          .map(part => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ');
        const keyName = displayName.replace(/\s+/g, '').replace(/[.-]/g, ''); // Normalize for cache key

        shadcnRegistryData[keyName] = component; // Store the whole component object
        count++;
      }
    }

    if (count > 0) {
      const firstKey = Object.keys(shadcnRegistryData)[0];
      const exampleEntry = firstKey ? `${firstKey}: ${shadcnRegistryData[firstKey]}` : "N/A";
      console.error(`Shadcn UI registry cache refreshed. Found ${count} component slugs. Example: ${exampleEntry}`);
    } else {
      console.warn("No components found in Shadcn UI registry JSON.");
    }
  } catch (error: any) {
    console.error(`Failed to refresh shadcn UI registry cache from ${registryUrl}: ${error.message}`);
    if (axios.isAxiosError(error)) {
      console.error(`Axios error details: status ${error.response?.status}, data ${JSON.stringify(error.response?.data)}`);
    }
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
              enum: ["aceternity", "shadcn", "all"],
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
      {
        name: "scan_shadcn_component",
        description: "Scans a specific shadcn UI component and stores it.",
        inputSchema: {
          type: "object",
          properties: {
            componentName: {
              type: "string",
              description: "The unique name for the component (e.g., 'button', 'card').",
            },
          },
          required: ["componentName"],
        },
      },
      {
        name: "list_shadcn_components",
        description: "Lists all available shadcn UI components.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_shadcn_component_prompt",
        description: "Retrieves a harvested shadcn component and generates a detailed integration prompt.",
        inputSchema: {
          type: "object",
          properties: {
            componentName: {
              type: "string",
              description: "The name of the component to retrieve (e.g., 'button').",
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
      // Normalize the input componentName to match the key generation in refresh functions
      // (e.g. "Alert Dialog" or "alert dialog" should both resolve to "AlertDialog" key)
      const displayNameForNormalization = rawComponentName
          .toLowerCase()
          .split(/[\s.-]+/)
          .map(part => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' '); // Ensures "alert dialog" becomes "Alert Dialog"
      const componentNameKey = displayNameForNormalization.replace(/\s+/g, '').replace(/[.-]/g, '');


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

    case "list_shadcn_components": {
      try {
        // This should now list components found in shadcnRegistryData
        const componentNames = Object.keys(shadcnRegistryData).map(key => {
          // Attempt to find a more display-friendly name if possible,
          // otherwise use the key or slug. This depends on what's stored.
          // For now, let's assume the key is derived from a display name.
          // key is the normalized display name, shadcnRegistryData[key] is the ShadcnRegistryEntry object
          // shadcnRegistryData[key].name is the slug
          return `${key} (slug: ${shadcnRegistryData[key].name})`; 
        });

        if (componentNames.length === 0) {
          return { content: [{ type: "text", text: "No shadcn UI components found in the registry cache. Try restarting the server or check parsing logic." }] };
        }

        const listText = componentNames.join("\n");
        return { content: [{ type: "text", text: `Available shadcn UI components:\n${listText}` }] };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error listing shadcn UI components: ${error.message}` }],
          isError: true
        };
      }
    }

    case "scan_shadcn_component": {
      const { componentName: rawComponentName } = request.params.arguments as { componentName: string };

      if (!rawComponentName) {
        throw new McpError(ErrorCode.InvalidParams, "componentName is required.");
      }

      // Normalize component name
      const normalizedName = rawComponentName.toLowerCase().trim(); // Keep for user display if needed, or use displayNameForNormalization

      try {
        // Refresh the shadcn registry cache if needed
        if (Object.keys(shadcnRegistryData).length === 0) {
          // This might happen if the initial refresh failed or server restarted without full init.
          console.warn("Shadcn registry cache is empty, attempting to refresh before scan...");
          await refreshShadcnRegistryCache();
        }

        // Normalize the input componentName to match the key generation in refresh functions
        const displayNameForNormalization = rawComponentName
            .toLowerCase()
            .split(/[\s.-]+/)
            .map(part => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' '); // Ensures "alert dialog" becomes "Alert Dialog"
        const componentNameKey = displayNameForNormalization.replace(/\s+/g, '').replace(/[.-]/g, '');
        
        const registryEntry = shadcnRegistryData[componentNameKey];

        if (!registryEntry) {
          return {
            content: [{ type: "text", text: `Component '${rawComponentName}' (key: ${componentNameKey}) not found in shadcn UI registry cache. Known keys: ${Object.keys(shadcnRegistryData).join(', ')}` }],
            isError: true
          };
        }
        
        const slug = registryEntry.name; // slug is the 'name' field from the registry entry

        // For Shadcn, we don't fetch a further [slug].json. The registryEntry is the data.
        // We will save this registryEntry itself as the component's JSON data.
        const componentDataForStorage: FullComponentData = {
            name: slug,
            title: displayNameForNormalization, // Use the generated display name
            type: registryEntry.type,
            dependencies: registryEntry.dependencies,
            registryDependencies: registryEntry.registryDependencies,
            files: registryEntry.files.map(f => ({ path: f, content: `// Content for ${f} is typically added by 'npx shadcn-ui@latest add ${slug}'`})),
            author: "shadcn", // Or similar
            // Add any other relevant fields from registryEntry if needed for FullComponentData
        };
        
        console.error(`Using registry data for shadcn component '${normalizedName}' (slug: ${slug})`);

        // Create directory for shadcn components if it doesn't exist
        const sourceDataDir = path.join(baseDataDir, 'shadcn');
        if (!fs.existsSync(baseDataDir)) {
          fs.mkdirSync(baseDataDir, { recursive: true });
        }
        if (!fs.existsSync(sourceDataDir)) {
          fs.mkdirSync(sourceDataDir, { recursive: true });
        }
        
        const scanDate = new Date().toISOString();
        const componentJsonFilePath = path.join(sourceDataDir, `${slug}.json`);
        // Save the constructed componentDataForStorage (derived from the main registry entry)
        fs.writeFileSync(componentJsonFilePath, JSON.stringify(componentDataForStorage, null, 2), 'utf8');
        console.error(`Saved shadcn component metadata to ${componentJsonFilePath}`);

        // Update the central index file
        let indexData: Record<string, IndexedComponentInfo> = {};
        if (fs.existsSync(indexFilePath)) {
          try {
            indexData = JSON.parse(fs.readFileSync(indexFilePath, 'utf8')) as Record<string, IndexedComponentInfo>;
          } catch (e) {
            console.error(`Error parsing existing index file ${indexFilePath}, starting new index.`, e);
            indexData = {};
          }
        }

        const componentStorageKey = `shadcn:${componentNameKey}`;
        const newIndexEntry: IndexedComponentInfo = {
          name: displayNameForNormalization, // Use the generated display name
          source: "shadcn",
          slug: slug,
          description: (componentDataForStorage as any).description || `shadcn UI ${slug} component`,
          filePath: path.relative(baseDataDir, componentJsonFilePath),
          // jsonUrl should point to the main registry as there's no individual one
          jsonUrl: `https://ui.shadcn.com/registry#${slug}`, // Or just the main registry URL
          lastScanned: scanDate,
          dependencies: componentDataForStorage.dependencies || [],
          registryDependencies: componentDataForStorage.registryDependencies || []
        };

        indexData[componentStorageKey] = newIndexEntry;
        fs.writeFileSync(indexFilePath, JSON.stringify(indexData, null, 2), 'utf8');
        console.error(`Updated index file at ${indexFilePath} for shadcn component ${displayNameForNormalization}`);

        // Update in-memory cache
        inMemoryIndexCache[componentStorageKey] = newIndexEntry;

        return {
          content: [{ type: "text", text: `Successfully processed and stored metadata for shadcn UI component '${newIndexEntry.name}', saved to ${componentJsonFilePath}, and updated index.` }],
        };
      } catch (error: any) { // Catch errors from the outer try block of scan_shadcn_component
        console.error(`Error processing shadcn component ${rawComponentName}:`, error);
        // Ensure error is an McpError or wrap it
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError, `Failed to process shadcn component ${rawComponentName}: ${error.message}`);
      }
    }

    case "get_shadcn_component_prompt": {
      // This case will now be very similar to get_aceternity_component_prompt
      const { componentName: rawComponentNameFromArgs } = request.params.arguments as { componentName: string };
      if (!rawComponentNameFromArgs) {
        throw new McpError(ErrorCode.InvalidParams, "componentName is required.");
      }

      const displayNameForNormalizationLookup = rawComponentNameFromArgs
          .toLowerCase()
          .split(/[\s.-]+/)
          .map(part => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ');
      const componentNameKeyForLookup = displayNameForNormalizationLookup.replace(/\s+/g, '').replace(/[.-]/g, '');
      const componentStorageLookupKey = `shadcn:${componentNameKeyForLookup}`;

      const indexedInfo = inMemoryIndexCache[componentStorageLookupKey];

      if (!indexedInfo) {
        return {
          content: [{ type: "text", text: `Shadcn component '${rawComponentNameFromArgs}' (key: ${componentStorageLookupKey}) not found in index. Try scanning it first.` }],
          isError: true,
        };
      }

      const fullComponentJsonPath = path.join(baseDataDir, indexedInfo.filePath);
      if (!fs.existsSync(fullComponentJsonPath)) {
        return {
          content: [{ type: "text", text: `Shadcn component data file not found at ${fullComponentJsonPath} for '${indexedInfo.name}'. Index might be stale.` }],
          isError: true,
        };
      }

      let componentData: FullComponentData;
      try {
        componentData = JSON.parse(fs.readFileSync(fullComponentJsonPath, 'utf8')) as FullComponentData;
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error parsing Shadcn component data file ${fullComponentJsonPath}: ${e.message}` }],
          isError: true,
        };
      }

      const displayName = componentData.title || componentData.name || rawComponentNameFromArgs;

      let prompt = `You are given a task to integrate the '${displayName}' React component from shadcn UI into your codebase.\n\n`;
      prompt += `Please verify your project has the following setup:\n`;
      prompt += `- shadcn/ui project structure (check for components.json, lib/utils.ts)\n`;
      prompt += `- Tailwind CSS (check for tailwind.config.ts)\n`;
      prompt += `- TypeScript (check for tsconfig.json)\n\n`;
      prompt += `If any of these are missing, provide instructions on how to set them up (e.g., 'npx shadcn-ui@latest init', install Tailwind, install TypeScript).\n\n`;
      prompt += `Determine the default path for components (usually 'components/ui' or as specified in components.json).\n`;
      prompt += `If the default path for components is not 'components/ui', explain why it's important to use a consistent location like 'components/ui' for shadcn/ui components.\n\n`;

      // For Shadcn, the prompt should guide CLI usage, but can list files/dependencies from stored metadata
      prompt += `To add the '${displayName}' component to your project, run the following command:\n\n`;
      prompt += `\`\`\`bash\nnpx shadcn-ui@latest add ${indexedInfo.slug}\n\`\`\`\n\n`;
      prompt += `This command will install the component and its necessary dependencies into your project.\n\n`;
      
      if (componentData.files && componentData.files.length > 0) {
        prompt += `The following file(s) will typically be added or modified in your project (usually under 'components/ui'):\n`;
        componentData.files.forEach(file => {
          // file.path is now just a string like "ui/accordion.tsx" from the main registry
          prompt += `- ${file.path}\n`;
        });
        prompt += `\n`;
      }
      
      // Check for 'cn' utility based on common patterns or if explicitly listed as a dep (though usually implicit)
      // This check might need refinement based on how dependencies are actually listed in shadcn's main registry JSON
      let usesCn = false;
      if (componentData.dependencies?.some(dep => dep.toLowerCase().includes("clsx") || dep.toLowerCase().includes("tailwind-merge"))) {
          usesCn = true;
      }
      // A more direct check might be if 'cn' is part of a known pattern for shadcn components,
      // or if the actual file contents (if we ever get them) include it.
      // For now, this is a heuristic.
      // A simpler heuristic: many shadcn components use `cn`.
      if (true) { // Assuming most shadcn components might use cn
        prompt += `Many shadcn UI components use the 'cn' utility function. Ensure you have 'lib/utils.ts' set up (this is done by \`npx shadcn-ui@latest init\`), which typically contains:\n`;
        prompt += `\`\`\`ts\n`;
        prompt += `import { type ClassValue, clsx } from "clsx"\n`;
        prompt += `import { twMerge } from "tailwind-merge"\n\n`;
        prompt += `export function cn(...inputs: ClassValue[]) {\n`;
        prompt += `  return twMerge(clsx(inputs))\n`;
        prompt += `}\n`;
        prompt += `\`\`\`\n\n`;
      }
      prompt += `After adding the files (if provided), import and use the main component (e.g., '${displayName}') in your application where needed.`;
      
      if (componentData.registryDependencies && componentData.registryDependencies.length > 0) {
        prompt += `\nThis component has registry dependencies: ${componentData.registryDependencies.join(', ')}. You might need to install them separately using the shadcn CLI (e.g., 'npx shadcn@latest add dependency-name').\n`;
      }
      if (componentData.dependencies && componentData.dependencies.length > 0) {
         const externalDeps = componentData.dependencies.filter(dep => dep !== "cn" && dep !== "react" && dep !== "tailwindcss" && !(componentData.registryDependencies || []).includes(dep) );
         if (externalDeps.length > 0) {
            prompt += `\nThis component also has external npm dependencies: ${externalDeps.join(', ')}. Ensure these are installed in your project (e.g., 'pnpm add ${externalDeps.join(' ')}').\n`;
         }
      }

      return { content: [{ type: "text", text: prompt }] };
    }

    case "get_aceternity_component_prompt": {
      const { componentName: rawComponentNameFromArgs } = request.params.arguments as { componentName: string };
      if (!rawComponentNameFromArgs) {
        throw new McpError(ErrorCode.InvalidParams, "componentName is required.");
      }
      const displayNameForNormalizationLookupAceternity = rawComponentNameFromArgs
          .toLowerCase()
          .split(/[\s.-]+/)
          .map(part => part.charAt(0).toUpperCase() + part.slice(1))
          .join(' ');
      const componentNameKeyForLookup = displayNameForNormalizationLookupAceternity.replace(/\s+/g, '').replace(/[.-]/g, '');
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
      prompt += `If any of these are missing, provide instructions on how to set them up (e.g., 'npx shadcn-ui@latest init', install Tailwind, install TypeScript).\n\n`;
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
  await refreshShadcnRegistryCache(); // Refresh shadcn component slugs
  loadIndexIntoMemoryCache(); // Load existing harvested components index
  await server.connect(transport);
  console.error('Component Harvester MCP server running on stdio');
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
