/**
 * Gemini-specific Request Transformations
 * 
 * Handles Gemini model-specific request transformations including:
 * - Thinking config (camelCase keys, thinkingLevel for Gemini 3)
 * - Tool normalization (function/custom format)
 * - Schema transformation (JSON Schema -> Gemini Schema format)
 */

import { getCachedSignature } from "../cache";
import { createLogger } from "../logger";
import { applyAntigravitySystemInstruction, normalizeThinkingConfig } from "../request-helpers";
import { cacheToolSchemas } from "../tool-schema-cache";
import type { RequestPayload, ThinkingConfig, ThinkingTier, GoogleSearchConfig, TransformContext, TransformResult } from "./types";

const log = createLogger("transform.gemini");

const THOUGHT_SIGNATURE_BYPASS = "skip_thought_signature_validator";

const GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION = `<CRITICAL_TOOL_USAGE_INSTRUCTIONS>
You are operating in a CUSTOM ENVIRONMENT where tool definitions COMPLETELY DIFFER from your training data.
VIOLATION OF THESE RULES WILL CAUSE IMMEDIATE SYSTEM FAILURE.

## ABSOLUTE RULES - NO EXCEPTIONS

1. **SCHEMA IS LAW**: The JSON schema in each tool definition is the ONLY source of truth.
   - Your pre-trained knowledge about tools like 'read_file', 'apply_diff', 'write_to_file', 'bash', etc. is INVALID here.
   - Every tool has been REDEFINED with different parameters than what you learned during training.

2. **PARAMETER NAMES ARE EXACT**: Use ONLY the parameter names from the schema.
   - WRONG: 'suggested_answers', 'file_path', 'files_to_read', 'command_to_run'
   - RIGHT: Check the 'properties' field in the schema for the exact names
   - The schema's 'required' array tells you which parameters are mandatory

3. **ARRAY PARAMETERS**: When a parameter has "type": "array", check the 'items' field:
   - If items.type is "object", you MUST provide an array of objects with the EXACT properties listed
   - If items.type is "string", you MUST provide an array of strings
   - NEVER provide a single object when an array is expected
   - NEVER provide an array when a single value is expected

4. **NESTED OBJECTS**: When items.type is "object":
   - Check items.properties for the EXACT field names required
   - Check items.required for which nested fields are mandatory
   - Include ALL required nested fields in EVERY array element

5. **STRICT PARAMETERS HINT**: Tool descriptions contain "STRICT PARAMETERS: ..." which lists:
   - Parameter name, type, and whether REQUIRED
   - For arrays of objects: the nested structure in brackets like [field: type REQUIRED, ...]
   - USE THIS as your quick reference, but the JSON schema is authoritative

6. **BEFORE EVERY TOOL CALL**:
   a. Read the tool's 'parametersJsonSchema' or 'parameters' field completely
   b. Identify ALL required parameters
   c. Verify your parameter names match EXACTLY (case-sensitive)
   d. For arrays, verify you're providing the correct item structure
   e. Do NOT add parameters that don't exist in the schema

## COMMON FAILURE PATTERNS TO AVOID

- Using 'path' when schema says 'filePath' (or vice versa)
- Using 'content' when schema says 'text' (or vice versa)  
- Providing {"file": "..."} when schema wants [{"path": "...", "line_ranges": [...]}]
- Omitting required nested fields in array items
- Adding 'additionalProperties' that the schema doesn't define
- Guessing parameter names from similar tools you know from training

## REMEMBER
Your training data about function calling is OUTDATED for this environment.
The tool names may look familiar, but the schemas are DIFFERENT.
When in doubt, RE-READ THE SCHEMA before making the call.
</CRITICAL_TOOL_USAGE_INSTRUCTIONS>

## GEMINI 3 RESPONSE RULES
- Default to a direct, concise answer; add detail only when asked or required for correctness.
- For multi-part tasks, use a short numbered list or labeled sections.
- For long provided context, answer only from that context and avoid assumptions.
- For multimodal inputs, explicitly reference each modality used and synthesize across them; do not invent details from absent modalities.
- For complex tasks, outline a short plan and verify constraints before acting.
`;

/**
 * Transform a JSON Schema to Gemini-compatible format.
 * Based on @google/genai SDK's processJsonSchema() function.
 * 
 * Key transformations:
 * - Converts type values to uppercase (object -> OBJECT)
 * - Removes unsupported fields like additionalProperties, $schema
 * - Recursively processes nested schemas (properties, items, anyOf, etc.)
 * 
 * @param schema - A JSON Schema object or primitive value
 * @returns Gemini-compatible schema
 * 
 * Fields that Gemini API rejects and must be removed from schemas.
 * Antigravity uses strict protobuf-backed JSON validation.
 */
const UNSUPPORTED_SCHEMA_FIELDS = new Set([
  "additionalProperties",
  "$schema",
  "$id",
  "$comment",
  "$ref",
  "$defs",
  "definitions",
  "const",
  "contentMediaType",
  "contentEncoding",
  "if",
  "then",
  "else",
  "not",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "minContains",
  "maxContains",
]);

export function toGeminiSchema(schema: unknown): unknown {
  // Return primitives and arrays as-is
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return schema;
  }

  const inputSchema = schema as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  // First pass: collect all property names for required validation
  const propertyNames = new Set<string>();
  if (inputSchema.properties && typeof inputSchema.properties === "object") {
    for (const propName of Object.keys(inputSchema.properties as Record<string, unknown>)) {
      propertyNames.add(propName);
    }
  }

  for (const [key, value] of Object.entries(inputSchema)) {
    // Skip unsupported fields that Gemini API rejects
    if (UNSUPPORTED_SCHEMA_FIELDS.has(key)) {
      continue;
    }

    if (key === "type" && typeof value === "string") {
      // Convert type to uppercase for Gemini API
      result[key] = value.toUpperCase();
    } else if (key === "properties" && typeof value === "object" && value !== null) {
      // Recursively transform nested property schemas
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        props[propName] = toGeminiSchema(propSchema);
      }
      result[key] = props;
    } else if (key === "items" && typeof value === "object") {
      // Transform array items schema
      result[key] = toGeminiSchema(value);
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      // Transform union type schemas
      result[key] = value.map((item) => toGeminiSchema(item));
    } else if (key === "enum" && Array.isArray(value)) {
      // Keep enum values as-is
      result[key] = value;
    } else if (key === "default" || key === "examples") {
      // Keep default and examples as-is
      result[key] = value;
    } else if (key === "required" && Array.isArray(value)) {
      // Filter required array to only include properties that exist
      // This fixes: "parameters.required[X]: property is not defined"
      if (propertyNames.size > 0) {
        const validRequired = value.filter((prop) =>
          typeof prop === "string" && propertyNames.has(prop)
        );
        if (validRequired.length > 0) {
          result[key] = validRequired;
        }
        // If no valid required properties, omit the required field entirely
      } else {
        // If there are no properties, keep required as-is (might be a schema without properties)
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  // Issue #80: Ensure array schemas have an 'items' field
  // Gemini API requires: "parameters.properties[X].items: missing field"
  if (result.type === "ARRAY" && !result.items) {
    result.items = { type: "STRING" };
  }

  return result;
}

/**
 * Check if a model is a Gemini model (not Claude).
 */
export function isGeminiModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("gemini") && !lower.includes("claude");
}

/**
 * Check if a model is Gemini 3 (uses thinkingLevel string).
 */
export function isGemini3Model(model: string): boolean {
  return model.toLowerCase().includes("gemini-3");
}

/**
 * Check if a model is Gemini 2.5 (uses numeric thinkingBudget).
 */
export function isGemini25Model(model: string): boolean {
  return model.toLowerCase().includes("gemini-2.5");
}

/**
 * Check if a model is an image generation model.
 * Image models don't support thinking and require imageConfig.
 */
export function isImageGenerationModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    lower.includes("image") ||
    lower.includes("imagen")
  );
}

/**
 * Build Gemini 3 thinking config with thinkingLevel string.
 */
export function buildGemini3ThinkingConfig(
  includeThoughts: boolean,
  thinkingLevel: ThinkingTier,
): ThinkingConfig {
  return {
    includeThoughts,
    thinkingLevel,
  };
}

/**
 * Build Gemini 2.5 thinking config with numeric thinkingBudget.
 */
export function buildGemini25ThinkingConfig(
  includeThoughts: boolean,
  thinkingBudget?: number,
): ThinkingConfig {
  return {
    includeThoughts,
    ...(typeof thinkingBudget === "number" && thinkingBudget > 0 ? { thinkingBudget } : {}),
  };
}

/**
 * Image generation config for Gemini image models.
 * 
 * Supported aspect ratios: "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
 */
export interface ImageConfig {
  aspectRatio?: string;
}

/**
 * Valid aspect ratios for image generation.
 */
const VALID_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

/**
 * Build image generation config for Gemini image models.
 * 
 * Configuration is read from environment variables:
 * - OPENCODE_IMAGE_ASPECT_RATIO: Aspect ratio (e.g., "16:9", "4:3")
 * 
 * Defaults to 1:1 aspect ratio if not specified.
 * 
 * Note: Resolution setting is not currently supported by the Antigravity API.
 */
export function buildImageGenerationConfig(): ImageConfig {
  // Read aspect ratio from environment or default to 1:1
  const aspectRatio = process.env.OPENCODE_IMAGE_ASPECT_RATIO || "1:1";

  if (VALID_ASPECT_RATIOS.includes(aspectRatio)) {
    return { aspectRatio };
  }

  console.warn(`[gemini] Invalid aspect ratio "${aspectRatio}". Using default "1:1". Valid values: ${VALID_ASPECT_RATIOS.join(", ")}`);

  // Default to 1:1 square aspect ratio
  return { aspectRatio: "1:1" };
}

/**
 * Normalize tools for Gemini models.
 * Ensures tools have proper function-style format.
 * 
 * @returns Debug info about tool normalization
 */
export function normalizeGeminiTools(
  payload: RequestPayload,
): { toolDebugMissing: number; toolDebugSummaries: string[] } {
  let toolDebugMissing = 0;
  const toolDebugSummaries: string[] = [];

  if (!Array.isArray(payload.tools)) {
    return { toolDebugMissing, toolDebugSummaries };
  }

  payload.tools = (payload.tools as unknown[]).map((tool: unknown, toolIndex: number) => {
    const t = tool as Record<string, unknown>;

    // Skip normalization for Google Search tools (both old and new API)
    if (t.googleSearch || t.googleSearchRetrieval) {
      return t;
    }

    const newTool = { ...t };

    const schemaCandidates = [
      (newTool.function as Record<string, unknown> | undefined)?.input_schema,
      (newTool.function as Record<string, unknown> | undefined)?.parameters,
      (newTool.function as Record<string, unknown> | undefined)?.inputSchema,
      (newTool.custom as Record<string, unknown> | undefined)?.input_schema,
      (newTool.custom as Record<string, unknown> | undefined)?.parameters,
      newTool.parameters,
      newTool.input_schema,
      newTool.inputSchema,
    ].filter(Boolean);

    const placeholderSchema: Record<string, unknown> = {
      type: "OBJECT",
      properties: {
        _placeholder: {
          type: "BOOLEAN",
          description: "Placeholder. Always pass true.",
        },
      },
      required: ["_placeholder"],
    };

    let schema = schemaCandidates[0] as Record<string, unknown> | undefined;
    const schemaObjectOk = schema && typeof schema === "object" && !Array.isArray(schema);
    if (!schemaObjectOk) {
      schema = placeholderSchema;
      toolDebugMissing += 1;
    } else {
      // Transform existing schema to Gemini-compatible format
      schema = toGeminiSchema(schema) as Record<string, unknown>;
    }

    const nameCandidate =
      newTool.name ||
      (newTool.function as Record<string, unknown> | undefined)?.name ||
      (newTool.custom as Record<string, unknown> | undefined)?.name ||
      `tool-${toolIndex}`;

    // Always update function.input_schema with transformed schema
    if (newTool.function && schema) {
      (newTool.function as Record<string, unknown>).input_schema = schema;
    }

    // Always update custom.input_schema with transformed schema
    if (newTool.custom && schema) {
      (newTool.custom as Record<string, unknown>).input_schema = schema;
    }

    // Create custom from function if missing
    if (!newTool.custom && newTool.function) {
      const fn = newTool.function as Record<string, unknown>;
      newTool.custom = {
        name: fn.name || nameCandidate,
        description: fn.description,
        input_schema: schema,
      };
    }

    // Create custom if both missing
    if (!newTool.custom && !newTool.function) {
      newTool.custom = {
        name: nameCandidate,
        description: newTool.description,
        input_schema: schema,
      };

      if (!newTool.parameters && !newTool.input_schema && !newTool.inputSchema) {
        newTool.parameters = schema;
      }
    }

    if (newTool.custom && !(newTool.custom as Record<string, unknown>).input_schema) {
      (newTool.custom as Record<string, unknown>).input_schema = {
        type: "OBJECT",
        properties: {},
      };
      toolDebugMissing += 1;
    }

    toolDebugSummaries.push(
      `idx=${toolIndex}, hasCustom=${!!newTool.custom}, customSchema=${!!(newTool.custom as Record<string, unknown> | undefined)?.input_schema}, hasFunction=${!!newTool.function}, functionSchema=${!!(newTool.function as Record<string, unknown> | undefined)?.input_schema}`,
    );

    // Strip custom wrappers for Gemini; only function-style is accepted.
    if (newTool.custom) {
      delete newTool.custom;
    }

    return newTool;
  });

  return { toolDebugMissing, toolDebugSummaries };
}

/**
 * Apply all Gemini-specific transformations to a request payload.
 */
export interface GeminiTransformOptions {
  /** The effective model name (resolved) */
  model: string;
  /** Tier-based thinking budget (from model suffix, for Gemini 2.5) */
  tierThinkingBudget?: number;
  /** Tier-based thinking level (from model suffix, for Gemini 3) */
  tierThinkingLevel?: ThinkingTier;
  /** Normalized thinking config from user settings */
  normalizedThinking?: { includeThoughts?: boolean; thinkingBudget?: number };
  /** Google Search configuration */
  googleSearch?: GoogleSearchConfig;
}

export interface GeminiTransformResult {
  toolDebugMissing: number;
  toolDebugSummaries: string[];
  /** Number of function declarations after wrapping */
  wrappedFunctionCount: number;
  /** Number of passthrough tools (googleSearch, googleSearchRetrieval, codeExecution) */
  passthroughToolCount: number;
}

/**
 * Apply all Gemini-specific transformations.
 */
export function applyGeminiTransforms(
  payload: RequestPayload,
  options: GeminiTransformOptions,
): GeminiTransformResult {
  const { model, tierThinkingBudget, tierThinkingLevel, normalizedThinking, googleSearch } = options;

  // 1. Apply thinking config if needed
  if (normalizedThinking) {
    let thinkingConfig: ThinkingConfig;

    if (tierThinkingLevel && isGemini3Model(model)) {
      // Gemini 3 uses thinkingLevel string
      thinkingConfig = buildGemini3ThinkingConfig(
        normalizedThinking.includeThoughts ?? true,
        tierThinkingLevel,
      );
    } else {
      // Gemini 2.5 and others use numeric budget
      const thinkingBudget = tierThinkingBudget ?? normalizedThinking.thinkingBudget;
      thinkingConfig = buildGemini25ThinkingConfig(
        normalizedThinking.includeThoughts ?? true,
        thinkingBudget,
      );
    }

    const generationConfig = (payload.generationConfig ?? {}) as Record<string, unknown>;
    generationConfig.thinkingConfig = thinkingConfig;
    payload.generationConfig = generationConfig;
  }

  // 2. Apply Google Search (Grounding) if enabled
  // Uses the new googleSearch API for Gemini 2.0+ / Gemini 3 models
  // Note: The old googleSearchRetrieval with dynamicRetrievalConfig is deprecated
  // The new API doesn't support threshold - the model decides when to search automatically
  if (googleSearch && googleSearch.mode === 'auto') {
    const tools = (payload.tools as unknown[]) || [];
    if (!payload.tools) {
      payload.tools = tools;
    }

    // Add Google Search tool using new API format for Gemini 2.0+
    // See: https://ai.google.dev/gemini-api/docs/grounding
    (payload.tools as any[]).push({
      googleSearch: {},
    });
  }

  // 3. Normalize tools
  const result = normalizeGeminiTools(payload);

  // 4. Wrap tools in functionDeclarations format (fixes #203, #206)
  // Antigravity strict protobuf validation rejects wrapper-level 'parameters' field
  // Must be: [{ functionDeclarations: [{ name, description, parameters }] }]
  const wrapResult = wrapToolsAsFunctionDeclarations(payload);

  return {
    ...result,
    wrappedFunctionCount: wrapResult.wrappedFunctionCount,
    passthroughToolCount: wrapResult.passthroughToolCount,
  };
}

export interface WrapToolsResult {
  wrappedFunctionCount: number;
  passthroughToolCount: number;
}

/**
 * Wrap tools array in Gemini's required functionDeclarations format.
 * 
 * Gemini/Antigravity API expects:
 *   { tools: [{ functionDeclarations: [{ name, description, parameters }] }] }
 * 
 * NOT:
 *   { tools: [{ function: {...}, parameters: {...} }] }
 * 
 * The wrapper-level 'parameters' field causes:
 *   "Unknown name 'parameters' at 'request.tools[0]'"
 */
/**
 * Detect if a tool is a web search tool in any of the supported formats:
 * - Claude/Anthropic: { type: "web_search_20250305" } or { name: "web_search" }
 * - Gemini native: { googleSearch: {} } or { googleSearchRetrieval: {} }
 */
function isWebSearchTool(tool: Record<string, unknown>): boolean {
  // 1. Gemini native format
  if (tool.googleSearch || tool.googleSearchRetrieval) {
    return true;
  }

  // 2. Claude/Anthropic format: { type: "web_search_20250305" }
  if (tool.type === "web_search_20250305") {
    return true;
  }

  // 3. Simple name-based format: { name: "web_search" | "google_search" }
  const name = tool.name as string | undefined;
  if (name === "web_search" || name === "google_search") {
    return true;
  }

  return false;
}

export function wrapToolsAsFunctionDeclarations(payload: RequestPayload): WrapToolsResult {
  if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
    return { wrappedFunctionCount: 0, passthroughToolCount: 0 };
  }

  const functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> = [];

  const passthroughTools: unknown[] = [];
  let hasWebSearchTool = false;

  for (const tool of payload.tools as Array<Record<string, unknown>>) {
    // Handle passthrough tools (Google Search and Code Execution)
    if (tool.googleSearch || tool.googleSearchRetrieval || tool.codeExecution) {
      passthroughTools.push(tool);
      continue;
    }

    // Detect and convert web search tools to Gemini format
    if (isWebSearchTool(tool)) {
      hasWebSearchTool = true;
      continue; // Will be added as { googleSearch: {} } at the end
    }

    if (tool.functionDeclarations) {
      if (Array.isArray(tool.functionDeclarations)) {
        for (const decl of tool.functionDeclarations as Array<Record<string, unknown>>) {
          functionDeclarations.push({
            name: String(decl.name || `tool-${functionDeclarations.length}`),
            description: String(decl.description || ""),
            parameters: (decl.parameters as Record<string, unknown>) || { type: "OBJECT", properties: {} },
          });
        }
      }
      continue;
    }

    const fn = tool.function as Record<string, unknown> | undefined;
    const custom = tool.custom as Record<string, unknown> | undefined;

    const name = String(
      tool.name ||
      fn?.name ||
      custom?.name ||
      `tool-${functionDeclarations.length}`
    );

    const description = String(
      tool.description ||
      fn?.description ||
      custom?.description ||
      ""
    );

    const schema = (
      fn?.input_schema ||
      fn?.parameters ||
      fn?.inputSchema ||
      custom?.input_schema ||
      custom?.parameters ||
      tool.parameters ||
      tool.input_schema ||
      tool.inputSchema ||
      { type: "OBJECT", properties: {} }
    ) as Record<string, unknown>;

    functionDeclarations.push({
      name,
      description,
      parameters: schema,
    });
  }

  const finalTools: unknown[] = [];

  if (functionDeclarations.length > 0) {
    finalTools.push({ functionDeclarations });
  }

  finalTools.push(...passthroughTools);

  // Add googleSearch tool if a web search tool was detected
  // Note: googleSearch cannot be combined with functionDeclarations in the same request
  // If there are function declarations, we skip adding googleSearch (Gemini API limitation)
  if (hasWebSearchTool && functionDeclarations.length === 0) {
    finalTools.push({ googleSearch: {} });
  } else if (hasWebSearchTool && functionDeclarations.length > 0) {
    // Log warning: web search requested but can't be used with functions
    console.warn(
      "[gemini] web_search tool detected but cannot be combined with function declarations. " +
      "Use the explicit google_search() tool call instead."
    );
  }

  payload.tools = finalTools;

  return {
    wrappedFunctionCount: functionDeclarations.length,
    passthroughToolCount: passthroughTools.length + (hasWebSearchTool && functionDeclarations.length === 0 ? 1 : 0),
  };
}

function hasFunctionTools(payload: RequestPayload): boolean {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return false;
  return tools.some((tool) => Array.isArray(tool.functionDeclarations));
}

function extractSystemInstructionText(systemInstruction: unknown): string {
  if (typeof systemInstruction === "string") {
    return systemInstruction;
  }
  if (!systemInstruction || typeof systemInstruction !== "object") {
    return "";
  }

  const parts = (systemInstruction as Record<string, unknown>).parts as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function getToolCallingMode(payload: RequestPayload): string | undefined {
  const toolConfig = payload.toolConfig;
  if (!toolConfig || typeof toolConfig !== "object") return undefined;

  const functionCallingConfig = (toolConfig as Record<string, unknown>).functionCallingConfig;
  if (!functionCallingConfig || typeof functionCallingConfig !== "object") return undefined;

  const mode = (functionCallingConfig as Record<string, unknown>).mode;
  return typeof mode === "string" ? mode : undefined;
}

function getFunctionToolNames(payload: RequestPayload): string[] {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return [];

  const names: string[] = [];
  for (const tool of tools) {
    const funcDecls = tool.functionDeclarations as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(funcDecls)) continue;

    for (const funcDecl of funcDecls) {
      const name = funcDecl.name;
      if (typeof name === "string") names.push(name);
    }
  }
  return names;
}

function hasInjectedToolSchemaInstruction(payload: RequestPayload): boolean {
  const existingText = extractSystemInstructionText(payload.systemInstruction);
  return existingText.includes("<CRITICAL_TOOL_USAGE_INSTRUCTIONS>");
}

type ScrubResult = { cleaned: string; removedLines: number; removedBlocks: number };

function scrubToolTranscriptArtifacts(text: string): ScrubResult {
  const lines = text.split("\n");
  const output: string[] = [];
  const removed = { lines: 0, blocks: 0 };
  const state = { inFence: false, fenceStart: "", fenceLines: [] as string[] };

  const isMarkerLine = (line: string): boolean => {
    return /^\s*Tool:\s*\w+/i.test(line) || /^\s*(?:thought|think)\s*:/i.test(line);
  };

  for (const line of lines) {
    const isFence = line.trim().startsWith("```");

    if (isFence) {
      if (!state.inFence) {
        state.inFence = true;
        state.fenceStart = line;
        state.fenceLines = [];
        continue;
      }

      const hadMarker = state.fenceLines.some(isMarkerLine);
      const cleanedFenceLines: string[] = [];
      for (const fenceLine of state.fenceLines) {
        if (isMarkerLine(fenceLine)) {
          removed.lines += 1;
          continue;
        }
        cleanedFenceLines.push(fenceLine);
      }

      const hasNonWhitespace = cleanedFenceLines.some((l) => l.trim().length > 0);
      if (hadMarker && !hasNonWhitespace) {
        removed.blocks += 1;
      }
      if (!hadMarker || hasNonWhitespace) {
        output.push(state.fenceStart);
        output.push(...cleanedFenceLines);
        output.push(line);
      }

      state.inFence = false;
      state.fenceStart = "";
      state.fenceLines = [];
      continue;
    }

    if (state.inFence) {
      state.fenceLines.push(line);
      continue;
    }

    if (isMarkerLine(line)) {
      removed.lines += 1;
      continue;
    }

    output.push(line);
  }

  if (state.inFence) {
    output.push(state.fenceStart);
    output.push(...state.fenceLines);
  }

  const cleaned = output.join("\n").replace(/\n{4,}/g, "\n\n\n");
  return { cleaned, removedLines: removed.lines, removedBlocks: removed.blocks };
}

function scrubConversationArtifactsFromModelHistory(payload: RequestPayload): void {
  const contents = payload.contents as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(contents)) return;

  const stats = { scrubbedParts: 0, removedLines: 0, removedBlocks: 0 };

  for (const content of contents) {
    if (content.role !== "model") continue;

    const parts = content.parts as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (typeof part.text !== "string") continue;

      const scrubbed = scrubToolTranscriptArtifacts(part.text);
      if (scrubbed.removedLines > 0 || scrubbed.removedBlocks > 0) {
        part.text = scrubbed.cleaned;
        stats.scrubbedParts += 1;
        stats.removedLines += scrubbed.removedLines;
        stats.removedBlocks += scrubbed.removedBlocks;
      }
    }
  }

  if (stats.scrubbedParts > 0) {
    log.debug("Scrubbed tool transcript artifacts from model history", {
      scrubbedParts: stats.scrubbedParts,
      removedLines: stats.removedLines,
      removedBlocks: stats.removedBlocks,
    });
  }
}

function injectSystemInstructionIfNeeded(payload: RequestPayload): void {
  if (!hasFunctionTools(payload)) return;

  const existingText = extractSystemInstructionText(payload.systemInstruction);
  if (existingText.includes("<CRITICAL_TOOL_USAGE_INSTRUCTIONS>")) {
    return;
  }

  const existing = payload.systemInstruction;
  if (!existing || typeof existing === "string") {
    const suffix = typeof existing === "string" && existing.trim().length > 0 ? `\n\n${existing}` : "";
    payload.systemInstruction = { parts: [{ text: `${GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION}${suffix}` }] };
    log.debug("Injected tool-schema systemInstruction", { existingType: typeof existing });
    return;
  }

  const asRecord = existing as Record<string, unknown>;
  const parts = asRecord.parts;
  if (Array.isArray(parts)) {
    asRecord.parts = [{ text: GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION }, ...parts];
    payload.systemInstruction = asRecord;
    log.debug("Injected tool-schema systemInstruction", { existingType: "object(parts[])" });
    return;
  }

  payload.systemInstruction = {
    ...asRecord,
    parts: [{ text: GEMINI_TOOL_SCHEMA_SYSTEM_INSTRUCTION }],
  };
  log.debug("Injected tool-schema systemInstruction", { existingType: "object" });
}

function normalizeSchemaType(typeValue: unknown): string | undefined {
  if (typeof typeValue === "string") {
    return typeValue;
  }
  if (Array.isArray(typeValue)) {
    const nonNull = typeValue.filter((t) => t !== "null");
    const first = nonNull[0] ?? typeValue[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function summarizeSchema(schema: unknown, depth: number): string {
  if (!schema || typeof schema !== "object") {
    return "unknown";
  }

  const record = schema as Record<string, unknown>;
  const normalizedType = normalizeSchemaType(record.type);
  const enumValues = Array.isArray(record.enum) ? record.enum : undefined;

  if (normalizedType === "array") {
    const items = record.items;
    const itemSummary = depth > 0 ? summarizeSchema(items, depth - 1) : "unknown";
    return `array[${itemSummary}]`;
  }

  if (normalizedType === "object") {
    const props = record.properties as Record<string, unknown> | undefined;
    const required = Array.isArray(record.required)
      ? (record.required as unknown[]).filter((v): v is string => typeof v === "string")
      : [];

    if (!props || depth <= 0) {
      return "object";
    }

    const keys = Object.keys(props);
    const requiredKeys = keys.filter((k) => required.includes(k));
    const optionalKeys = keys.filter((k) => !required.includes(k));
    const orderedKeys = [...requiredKeys.sort(), ...optionalKeys.sort()];

    const maxPropsToShow = 8;
    const shownKeys = orderedKeys.slice(0, maxPropsToShow);

    const inner = shownKeys
      .map((key) => {
        const propSchema = props[key];
        const propType = summarizeSchema(propSchema, depth - 1);
        const requiredSuffix = required.includes(key) ? " REQUIRED" : "";
        return `${key}: ${propType}${requiredSuffix}`;
      })
      .join(", ");

    const extraCount = orderedKeys.length - shownKeys.length;
    const extra = extraCount > 0 ? `, …+${extraCount}` : "";

    return `{${inner}${extra}}`;
  }

  if (enumValues && enumValues.length > 0) {
    const preview = enumValues.slice(0, 6).map(String).join("|");
    const suffix = enumValues.length > 6 ? "|…" : "";
    return `${normalizedType ?? "unknown"} enum(${preview}${suffix})`;
  }

  return normalizedType ?? "unknown";
}

function buildStrictParamsSummary(parametersSchema: Record<string, unknown>): string {
  const schemaType = normalizeSchemaType(parametersSchema.type);
  const properties = parametersSchema.properties as Record<string, unknown> | undefined;
  const required = Array.isArray(parametersSchema.required)
    ? (parametersSchema.required as unknown[]).filter((v): v is string => typeof v === "string")
    : [];

  if (schemaType !== "object" || !properties) {
    return "(schema missing top-level object properties)";
  }

  const keys = Object.keys(properties);
  const requiredKeys = keys.filter((k) => required.includes(k));
  const optionalKeys = keys.filter((k) => !required.includes(k));
  const orderedKeys = [...requiredKeys.sort(), ...optionalKeys.sort()];

  const parts = orderedKeys.map((key) => {
    const propSchema = properties[key];
    const typeSummary = summarizeSchema(propSchema, 2);
    const requiredSuffix = required.includes(key) ? " REQUIRED" : "";
    return `${key}: ${typeSummary}${requiredSuffix}`;
  });

  const summary = parts.join(", ");
  const maxLen = 900;
  return summary.length > maxLen ? `${summary.slice(0, maxLen)}…` : summary;
}

function augmentToolDescriptionsWithStrictParams(payload: RequestPayload): void {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return;

  const stats = { augmented: 0 };
  const toolNames: string[] = [];

  for (const tool of tools) {
    const funcDecls = tool.functionDeclarations as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(funcDecls)) continue;

    for (const funcDecl of funcDecls) {
      const schema = (funcDecl.parametersJsonSchema ?? funcDecl.parameters) as Record<string, unknown> | undefined;
      if (!schema || typeof schema !== "object") continue;

      const currentDescription = typeof funcDecl.description === "string" ? funcDecl.description : "";
      if (currentDescription.includes("STRICT PARAMETERS:")) continue;

      const summary = buildStrictParamsSummary(schema);
      const nextDescription = currentDescription.trim().length > 0
        ? `${currentDescription.trim()}\n\nSTRICT PARAMETERS: ${summary}`
        : `STRICT PARAMETERS: ${summary}`;

      funcDecl.description = nextDescription;
      stats.augmented += 1;
      if (typeof funcDecl.name === "string") {
        toolNames.push(funcDecl.name);
      }
    }
  }

  if (stats.augmented > 0) {
    log.debug("Augmented tool descriptions with STRICT PARAMETERS", {
      count: stats.augmented,
      toolNamesPreview: toolNames.slice(0, 8),
    });
  }
}

function sanitizeToolNameForGemini(name: string): string {
  if (/^[0-9]/.test(name)) {
    return `t_${name}`;
  }
  return name;
}

function sanitizeToolNames(payload: RequestPayload): void {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    const funcDecls = tool.functionDeclarations as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(funcDecls)) continue;

    for (const func of funcDecls) {
      if (typeof func.name === "string") {
        const originalName = func.name;
        func.name = sanitizeToolNameForGemini(originalName);
        if (originalName !== func.name) {
          log.debug("Sanitized tool name", { original: originalName, next: func.name });
        }
      }
    }
  }
}

export function transformGeminiRequest(
  context: TransformContext,
  parsedBody: RequestPayload,
): TransformResult {
  const requestPayload: RequestPayload = { ...parsedBody };

  delete requestPayload.safetySettings;

  if (!requestPayload.toolConfig) {
    requestPayload.toolConfig = {};
  }
  if (typeof requestPayload.toolConfig === "object") {
    const toolConfig = requestPayload.toolConfig as Record<string, unknown>;
    if (!toolConfig.functionCallingConfig) {
      toolConfig.functionCallingConfig = {};
    }
    if (typeof toolConfig.functionCallingConfig === "object") {
      (toolConfig.functionCallingConfig as Record<string, unknown>).mode = "VALIDATED";
    }
  }

  const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined;
  const normalizedThinking = normalizeThinkingConfig(rawGenerationConfig?.thinkingConfig);
  if (normalizedThinking) {
    if (rawGenerationConfig) {
      rawGenerationConfig.thinkingConfig = normalizedThinking;
      requestPayload.generationConfig = rawGenerationConfig;
    }
    if (!rawGenerationConfig) {
      requestPayload.generationConfig = { thinkingConfig: normalizedThinking };
    }
  }
  if (!normalizedThinking && rawGenerationConfig?.thinkingConfig) {
    delete rawGenerationConfig.thinkingConfig;
    requestPayload.generationConfig = rawGenerationConfig;
  }

  if ("system_instruction" in requestPayload) {
    requestPayload.systemInstruction = requestPayload.system_instruction;
    delete requestPayload.system_instruction;
  }

  const cachedContentFromExtra =
    typeof requestPayload.extra_body === "object" && requestPayload.extra_body
      ? (requestPayload.extra_body as Record<string, unknown>).cached_content ??
        (requestPayload.extra_body as Record<string, unknown>).cachedContent
      : undefined;
  const cachedContent =
    (requestPayload.cached_content as string | undefined) ??
    (requestPayload.cachedContent as string | undefined) ??
    (cachedContentFromExtra as string | undefined);
  if (cachedContent) {
    requestPayload.cachedContent = cachedContent;
  }

  delete requestPayload.cached_content;
  delete requestPayload.cachedContent;
  if (requestPayload.extra_body && typeof requestPayload.extra_body === "object") {
    delete (requestPayload.extra_body as Record<string, unknown>).cached_content;
    delete (requestPayload.extra_body as Record<string, unknown>).cachedContent;
    if (Object.keys(requestPayload.extra_body as Record<string, unknown>).length === 0) {
      delete requestPayload.extra_body;
    }
  }

  if ("model" in requestPayload) {
    delete requestPayload.model;
  }

  sanitizeToolNames(requestPayload);
  cacheToolSchemas(requestPayload.tools as any[]);
  augmentToolDescriptionsWithStrictParams(requestPayload);
  injectSystemInstructionIfNeeded(requestPayload);
  scrubConversationArtifactsFromModelHistory(requestPayload);
  applyAntigravitySystemInstruction(requestPayload, context.model);

  const contents = requestPayload.contents as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(contents)) {
    for (const [contentIndex, content] of contents.entries()) {
      if (!content) continue;
      if (content.role !== "model") continue;

      const parts = content.parts as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(parts)) continue;

      const filteredParts: Array<Record<string, unknown>> = [];
      const counts = { thinkingRemoved: 0, signaturesRemoved: 0, functionSignaturesAdded: 0 };
      const current = { signature: undefined as string | undefined };

      for (const [partIndex, part] of parts.entries()) {
        if (!part) continue;

        if (part.thought === true) {
          const thoughtText = part.text as string | undefined;
          if (thoughtText && context.sessionId) {
            const cachedSig = getCachedSignature(context.family, context.sessionId, thoughtText);
            if (cachedSig) {
              part.thoughtSignature = cachedSig;
              current.signature = cachedSig;
              filteredParts.push(part);
              log.debug("Restored thought from own cache", {
                family: context.family,
                sessionId: context.sessionId,
                contentIndex,
                partIndex,
                textLen: thoughtText.length,
              });
              continue;
            }
          }

          counts.thinkingRemoved += 1;
          log.debug("Removed thinking block (not in own cache)", {
            family: context.family,
            sessionId: context.sessionId,
            contentIndex,
            partIndex,
            textLen: typeof part.text === "string" ? part.text.length : undefined,
          });
          continue;
        }

        if (part.functionCall) {
          const functionCall = (part.functionCall ?? {}) as Record<string, unknown>;
          const callName = typeof functionCall.name === "string" ? functionCall.name : "<unknown>";

          const existingSig = part.thoughtSignature;
          if (typeof existingSig !== "string" || existingSig.length === 0) {
            const source = current.signature ? "current_thought" : "bypass";
            const nextSig = current.signature ?? THOUGHT_SIGNATURE_BYPASS;
            part.thoughtSignature = nextSig;
            counts.functionSignaturesAdded += 1;

            log.debug("Added thoughtSignature to functionCall part", {
              family: context.family,
              sessionId: context.sessionId,
              contentIndex,
              partIndex,
              callName,
              signatureSource: source,
              signatureLen: nextSig.length,
            });
          }

          filteredParts.push(part);
          continue;
        }

        if (part.thoughtSignature !== undefined) {
          delete part.thoughtSignature;
          counts.signaturesRemoved += 1;
        }

        filteredParts.push(part);
      }

      content.parts = filteredParts;

      if (counts.thinkingRemoved > 0) {
        log.debug("Removed foreign thinking blocks", { count: counts.thinkingRemoved, contentIndex });
      }
      if (counts.signaturesRemoved > 0) {
        log.debug("Removed thoughtSignature from non-thought non-tool model parts", {
          count: counts.signaturesRemoved,
          contentIndex,
        });
      }
      if (counts.functionSignaturesAdded > 0) {
        log.debug("Added thoughtSignature to functionCall parts", {
          count: counts.functionSignaturesAdded,
          contentIndex,
        });
      }
    }
  }

  requestPayload.sessionId = context.sessionId;

  const wrappedBody = {
    project: context.projectId,
    model: context.model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: context.requestId,
    request: requestPayload,
  };

  const toolCount = countTools(requestPayload);
  const toolCallingMode = getToolCallingMode(requestPayload);
  const systemInstructionHasMarker = hasInjectedToolSchemaInstruction(requestPayload);
  const functionToolNames = getFunctionToolNames(requestPayload);
  const contentsCount = Array.isArray(requestPayload.contents) ? requestPayload.contents.length : 0;

  log.debug("Gemini request transformed", {
    model: context.model,
    streaming: context.streaming,
    sessionId: context.sessionId,
    toolCount,
    toolCallingMode,
    systemInstructionHasMarker,
    functionToolNamesPreview: functionToolNames.slice(0, 8),
    contentsCount,
  });

  const body = JSON.stringify(wrappedBody);

  return {
    body,
    debugInfo: {
      transformer: "gemini",
      toolCount,
    },
  };
}

function countTools(payload: RequestPayload): number {
  const tools = payload.tools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return 0;
  const stats = { count: 0 };
  for (const tool of tools) {
    const funcDecls = tool.functionDeclarations as Array<unknown> | undefined;
    if (Array.isArray(funcDecls)) {
      stats.count += funcDecls.length;
    }
    if (tool.googleSearch) {
      stats.count += 1;
    }
    if (tool.urlContext) {
      stats.count += 1;
    }
  }
  return stats.count;
}
