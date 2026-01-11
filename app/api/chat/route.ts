import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createMcpClient, getToolsForClaude, executeTool, closeMcpClient } from '@/lib/mcp-client';
import type { MessageParam, ToolResultBlockParam, ContentBlock, Tool } from '@anthropic-ai/sdk/resources/messages';
import { readFileSync } from 'fs';
import { join } from 'path';
import { query } from '@/lib/planetscale';
import { marked } from 'marked';

// Generate a random ID for content storage
function generateContentId(length: number = 64): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}

// Detect if text contains HTML content
function containsHtml(text: string): boolean {
  const trimmed = text.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  // Check for HTML document markers
  if (lowerTrimmed.startsWith('<!doctype html')) return true;
  if (lowerTrimmed.startsWith('<html')) return true;

  // Check for markdown code block with html
  const htmlCodeBlockMatch = trimmed.match(/```html\s*([\s\S]*?)\n```/) || trimmed.match(/```html\s*([\s\S]*)```$/);
  if (htmlCodeBlockMatch) {
    const htmlContent = htmlCodeBlockMatch[1].trim().toLowerCase();
    if (htmlContent.startsWith('<!doctype html') || htmlContent.startsWith('<html')) {
      return true;
    }
  }

  // Check for raw HTML in text
  if (lowerTrimmed.includes('<!doctype html') && lowerTrimmed.includes('</html>')) {
    return true;
  }
  if (lowerTrimmed.includes('<html') && lowerTrimmed.includes('</html>')) {
    return true;
  }

  return false;
}

// Extract HTML content from text (handles markdown code blocks)
function extractHtmlContent(text: string): string | null {
  const trimmed = text.trim();

  // Check for markdown HTML code block
  const htmlCodeBlockMatch = trimmed.match(/```html\s*([\s\S]*?)\n```/) || trimmed.match(/```html\s*([\s\S]*)```$/);
  if (htmlCodeBlockMatch) {
    const htmlContent = htmlCodeBlockMatch[1].trim();
    const htmlLower = htmlContent.toLowerCase();
    if (htmlLower.startsWith('<!doctype html') || htmlLower.startsWith('<html')) {
      return htmlContent;
    }
  }

  // Check for direct HTML
  const lowerTrimmed = trimmed.toLowerCase();
  if (lowerTrimmed.startsWith('<!doctype html') || lowerTrimmed.startsWith('<html')) {
    return trimmed;
  }

  // Extract raw HTML from text
  const rawHtmlMatch = trimmed.match(/(<!DOCTYPE html[\s\S]*<\/html>)/i);
  if (rawHtmlMatch) {
    return rawHtmlMatch[1].trim();
  }

  const rawHtmlMatch2 = trimmed.match(/(<html[\s\S]*<\/html>)/i);
  if (rawHtmlMatch2) {
    return rawHtmlMatch2[1].trim();
  }

  return null;
}

// Metadata to include in saved HTML
interface HtmlMetadata {
  question: string;
  sqlQueries: Array<{ sql: string; result?: string }>;
  intermediateOutput: string[];
  model: string;
  timestamp: string;
  isMobile?: boolean;
}

// Escape HTML comment content to prevent breaking out of comments
function escapeHtmlComment(text: string): string {
  return text.replace(/-->/g, '--&gt;').replace(/<!--/g, '&lt;!--');
}

// Inject metadata as HTML comments into the HTML content
function injectMetadataComments(html: string, metadata: HtmlMetadata): string {
  const metadataComment = `
<!--
=== REPORT METADATA ===
Generated: ${metadata.timestamp}
Model: ${metadata.model}

=== USER QUESTION ===
${escapeHtmlComment(metadata.question)}

=== SQL QUERIES ===
${metadata.sqlQueries.map((q, i) => `
--- Query ${i + 1} ---
${escapeHtmlComment(q.sql)}
${q.result ? `\n--- Result ${i + 1} ---\n${escapeHtmlComment(q.result.slice(0, 2000))}${q.result.length > 2000 ? '\n... (truncated)' : ''}` : ''}`).join('\n')}

=== INTERMEDIATE OUTPUT ===
${metadata.intermediateOutput.map(o => escapeHtmlComment(o)).join('\n\n')}

=== END METADATA ===
-->
`;

  // Insert inside <head> tag so it's accessible via document.documentElement.outerHTML
  const headMatch = html.match(/(<head[^>]*>)/i);
  if (headMatch) {
    const headIndex = html.indexOf(headMatch[1]) + headMatch[1].length;
    return html.slice(0, headIndex) + metadataComment + html.slice(headIndex);
  }
  // Fallback: insert after <!DOCTYPE html>
  const doctypeMatch = html.match(/^(<!DOCTYPE[^>]*>)/i);
  if (doctypeMatch) {
    return doctypeMatch[1] + metadataComment + html.slice(doctypeMatch[1].length);
  }
  return metadataComment + html;
}

// Convert sparkline syntax to inline SVG
function sparklineToSvg(values: number[]): string {
  if (values.length === 0) return '';
  const width = 80;
  const height = 20;
  const padding = 2;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const points = values.map((v, i) => {
    const x = padding + (i / (values.length - 1)) * (width - padding * 2);
    const y = height - padding - ((v - min) / range) * (height - padding * 2);
    return `${x},${y}`;
  }).join(' ');

  return `<svg width="${width}" height="${height}" style="vertical-align: middle;"><polyline fill="none" stroke="#666" stroke-width="1.5" points="${points}"/></svg>`;
}

// Process markdown text to convert sparkline syntax to SVG
function processSparklines(text: string): string {
  return text.replace(/sparkline\(([^)]+)\)/g, (match, values) => {
    const nums = values.split(',').map((v: string) => parseFloat(v.trim())).filter((n: number) => !isNaN(n));
    if (nums.length >= 2) {
      return sparklineToSvg(nums);
    }
    return match;
  });
}

// Convert markdown to styled HTML document
function markdownToHtml(markdown: string, metadata?: HtmlMetadata): string {
  // Process sparklines before markdown rendering
  const processedMarkdown = processSparklines(markdown);

  // Render markdown to HTML
  const contentHtml = marked.parse(processedMarkdown) as string;

  // Create full HTML document with Tufte-inspired styling
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@400;600&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: Palatino, Georgia, serif;
            background: #fffff8;
            padding: 40px 60px;
            max-width: 900px;
            margin: 0 auto;
            color: #111;
            line-height: 1.6;
        }
        h1 { font-size: 2em; font-weight: normal; margin-bottom: 0.5em; border-bottom: 1px solid #ccc; padding-bottom: 0.3em; }
        h2 { font-size: 1.5em; font-weight: normal; margin-top: 1.5em; margin-bottom: 0.5em; color: #333; }
        h3 { font-size: 1.2em; font-weight: 600; margin-top: 1.2em; margin-bottom: 0.4em; }
        p { margin-bottom: 1em; }
        table { width: 100%; border-collapse: collapse; margin: 1.5em 0; font-size: 0.9em; }
        th { text-align: left; font-weight: 400; color: #666; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 12px 8px 0; border-bottom: 2px solid #ccc; }
        td { padding: 10px 12px 10px 0; border-bottom: 1px solid #eee; vertical-align: middle; }
        th:last-child, td:last-child { text-align: right; padding-right: 0; }
        tr:hover { background: rgba(0,0,0,0.02); }
        .num { font-family: 'Source Sans Pro', sans-serif; font-variant-numeric: tabular-nums; }
        code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
        pre { background: #f5f5f5; padding: 16px; border-radius: 4px; overflow-x: auto; margin: 1em 0; }
        pre code { background: none; padding: 0; }
        ul, ol { margin: 1em 0; padding-left: 1.5em; }
        li { margin-bottom: 0.5em; }
        strong { font-weight: 600; }
        blockquote { border-left: 3px solid #ccc; padding-left: 1em; margin: 1em 0; color: #666; }
        a { color: #a00; text-decoration: none; }
        a:hover { text-decoration: underline; }
        @media (max-width: 600px) {
            body { padding: 20px; }
            table { font-size: 0.8em; }
        }
    </style>
</head>
<body>
${contentHtml}
</body>
</html>`;

  return html;
}

// Save HTML content to database and return ID
async function saveHtmlContent(html: string, metadata?: HtmlMetadata): Promise<string | null> {
  try {
    const id = generateContentId();
    const htmlWithMetadata = metadata ? injectMetadataComments(html, metadata) : html;
    const model = metadata?.model || null;
    const isMobile = metadata?.isMobile ?? false;
    await query(
      `INSERT INTO shares (id, html_content, model, is_mobile, created_at, expires_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW() + INTERVAL '30 days')`,
      [id, htmlWithMetadata, model, isMobile]
    );
    return id;
  } catch (error) {
    console.error('[Chat API] Failed to save HTML content:', error);
    return null;
  }
}

// Fetch HTML content from a shared report
async function fetchSharedReportHtml(shareId: string): Promise<string | null> {
  try {
    const result = await query<{ html_content: string }>(
      `SELECT html_content FROM shares WHERE id = $1 AND expires_at > NOW()`,
      [shareId]
    );
    if (result.rows.length === 0) {
      console.log('[Chat API] Shared report not found or expired:', shareId);
      return null;
    }
    return result.rows[0].html_content;
  } catch (error) {
    console.error('[Chat API] Failed to fetch shared report:', error);
    return null;
  }
}

// Create a new Anthropic client for each request to avoid stream conflicts
function createAnthropicClient() {
  return new Anthropic({
    apiKey: process.env.OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api',
  });
}

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Check if an error is retryable (transient OpenRouter issues)
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('json error injected') ||
      msg.includes('stream error') ||
      msg.includes('network error') ||
      msg.includes('timeout') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up')
    );
  }
  return false;
}

// Sleep helper
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Default model - Gemini 3 Flash Preview via OpenRouter
const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

// Model IDs for blended mode
const GEMINI_MODEL = 'google/gemini-3-flash-preview';
const OPUS_MODEL = 'anthropic/claude-opus-4.5';

// Custom tool for chart generation
const chartTool: Tool = {
  name: 'generate_chart',
  description: 'Generate a chart to visualize data. Use this after querying data to create visual representations. The chart will be displayed inline in the chat.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['line', 'bar', 'pie', 'xmr'],
        description: 'The type of chart to generate. Use line for trends over time, bar for comparisons, pie for proportions, xmr for statistical process control.',
      },
      title: {
        type: 'string',
        description: 'A descriptive title for the chart.',
      },
      data: {
        type: 'array',
        items: {
          type: 'object',
        },
        description: 'Array of data objects. Each object should have keys matching xKey and yKey.',
      },
      xKey: {
        type: 'string',
        description: 'The key in data objects to use for the x-axis (categories/labels).',
      },
      yKey: {
        type: 'string',
        description: 'The key in data objects to use for the y-axis (values).',
      },
    },
    required: ['type', 'title', 'data', 'xKey', 'yKey'],
  },
};

// Custom tool for map generation
const mapTool: Tool = {
  name: 'generate_map',
  description: 'Generate an interactive map to visualize geographic data. Use this when data has location information (latitude/longitude, cities, states, regions, countries). The map will display markers sized by value with popup details.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: {
        type: 'string',
        description: 'A descriptive title for the map.',
      },
      data: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            lat: { type: 'number', description: 'Latitude coordinate' },
            lng: { type: 'number', description: 'Longitude coordinate' },
            label: { type: 'string', description: 'Location name or label for the marker' },
            value: { type: 'number', description: 'Numeric value that determines marker size' },
            details: { type: 'object', description: 'Optional additional key-value pairs to show in popup' },
          },
          required: ['lat', 'lng', 'label', 'value'],
        },
        description: 'Array of location objects with coordinates and data.',
      },
      center: {
        type: 'array',
        items: { type: 'number' },
        description: 'Optional [lat, lng] center point for the map. If not provided, will be calculated from data.',
      },
      zoom: {
        type: 'number',
        description: 'Optional zoom level (1-18). Default is 4 for country-level view.',
      },
      valueLabel: {
        type: 'string',
        description: 'Label for the value field in popups (e.g., "Revenue", "Orders", "Sales").',
      },
    },
    required: ['title', 'data'],
  },
};

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
  isMobile?: boolean;
  includeMetadata?: boolean;
  model?: string;
  shareId?: string; // ID of a shared report to use as context
}

// Allowed databases - restrict access to only these
const ALLOWED_DATABASES = ['eastlake'];

// Load prompt files from disk
const promptsDir = join(process.cwd(), 'prompts');

function loadPromptFile(filename: string): string {
  try {
    return readFileSync(join(promptsDir, filename), 'utf-8');
  } catch (error) {
    console.error(`[Prompts] Failed to load ${filename}:`, error);
    return '';
  }
}

// Cache loaded prompts
const promptCache: Record<string, string> = {};

function getPrompt(filename: string): string {
  if (!promptCache[filename]) {
    promptCache[filename] = loadPromptFile(filename);
  }
  return promptCache[filename];
}

// Dynamic content generators
const getMobileLayoutInstructions = (isMobile: boolean) => isMobile ? `**MOBILE LAYOUT**: The user is on a mobile device. Generate reports with a single-column layout optimized for narrow screens (max-width: 400px). Use stacked sections instead of grids, larger touch-friendly text, and avoid wide tables. Keep visualizations simple and vertically oriented.

` : '';

const getMetadataSection = (metadata?: string) => metadata ? `**DATABASE METADATA**:
${metadata}

` : '';

const getMetadataUsageInstructions = (metadata?: string) => metadata ? `**USE THE PROVIDED METADATA**: The DATABASE METADATA section above contains complete table schemas. DO NOT use list_tables or list_columns tools - you already have all table and column information. Go directly to running SQL queries.

` : '';

// Compose a prompt by replacing placeholders with actual content
function composePrompt(template: string, replacements: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  // Remove any unreplaced placeholders
  result = result.replace(/\{\{[A-Z_]+\}\}/g, '');
  return result;
}

// Build the shared data gathering prompt component
const buildDataGatheringPromptComponent = (metadata?: string) => {
  const template = getPrompt('system-prompt-data-gathering.md').replace(/^# .*\n+/, '');

  return composePrompt(template, {
    'DATABASE_METADATA': getMetadataSection(metadata),
    'METADATA_USAGE_INSTRUCTIONS': getMetadataUsageInstructions(metadata),
    'NARRATION_DATABASE': getPrompt('narration-database.md').replace(/^# .*\n+/, ''),
    'DATABASE_RULES': getPrompt('database-rules.md').replace(/^# .*\n+/, '').replace('{{ALLOWED_DATABASES}}', ALLOWED_DATABASES.join(', ')),
    'SCHEMA_EXPLORATION_STEP': metadata ? 'Review the DATABASE METADATA above' : 'Use list_tables and list_columns tools',
  });
};

// Build the shared report generation prompt component
const buildReportGenerationPromptComponent = (isMobile: boolean) => {
  const template = getPrompt('system-prompt-report-generation.md').replace(/^# .*\n+/, '');

  return composePrompt(template, {
    'MOBILE_LAYOUT_INSTRUCTIONS': getMobileLayoutInstructions(isMobile),
    'NARRATION_REPORT': getPrompt('narration-report.md').replace(/^# .*\n+/, ''),
    'TUFTE_STYLE_GUIDE': getPrompt('tufte-style-guide.md').replace(/^# .*\n+/, ''),
    'HTML_TEMPLATE': getPrompt('html-template.md').replace(/^# .*\n+/, ''),
  });
};

// Build the system prompt for standalone mode (any model)
const getSystemPrompt = (isMobile: boolean, metadata?: string) => {
  const template = getPrompt('standalone-system-prompt.md').replace(/^# .*\n+/, '');

  return composePrompt(template, {
    'DATA_GATHERING_PROMPT': buildDataGatheringPromptComponent(metadata),
    'REPORT_GENERATION_PROMPT': buildReportGenerationPromptComponent(isMobile),
  });
};

// Build the data gathering prompt for Gemini in blended mode
const getDataGatheringPrompt = (metadata?: string) => {
  const template = getPrompt('blended-data-gathering-prompt.md').replace(/^# .*\n+/, '');

  return composePrompt(template, {
    'DATA_GATHERING_PROMPT': buildDataGatheringPromptComponent(metadata),
    'SKIP_SCHEMA_INSTRUCTION': metadata ? 'DO NOT waste time exploring schema - use the metadata provided. ' : '',
  });
};

// Build the report generation prompt for Opus in blended mode
const getReportGenerationPrompt = (isMobile: boolean) => {
  const template = getPrompt('blended-report-generation-prompt.md').replace(/^# .*\n+/, '');

  return composePrompt(template, {
    'DATABASE_RULES': getPrompt('database-rules.md').replace(/^# .*\n+/, '').replace('{{ALLOWED_DATABASES}}', ALLOWED_DATABASES.join(', ')),
    'REPORT_GENERATION_PROMPT': buildReportGenerationPromptComponent(isMobile),
  });
};

// Check if a database reference is allowed
function isDatabaseAllowed(dbName: string): boolean {
  const normalized = dbName.toLowerCase().trim();
  return ALLOWED_DATABASES.some(allowed =>
    normalized === allowed.toLowerCase() ||
    normalized.startsWith(allowed.toLowerCase() + '.')
  );
}

// Validate tool arguments for database access
function validateToolAccess(toolName: string, args: Record<string, unknown>): { allowed: boolean; message?: string } {
  // Check database parameter in list_tables, list_columns, query tools
  if (args.database && typeof args.database === 'string') {
    if (!isDatabaseAllowed(args.database)) {
      return {
        allowed: false,
        message: `Access denied: Database '${args.database}' is not in the allowed list. You can only access: ${ALLOWED_DATABASES.join(', ')}`
      };
    }
  }

  // Check SQL queries for unauthorized database references
  // Only look for explicit three-part names (database.schema.table) or two-part (database.table)
  // Be careful not to match table aliases, function calls, or EXTRACT(...FROM...) patterns
  if (args.sql && typeof args.sql === 'string') {
    const sql = args.sql;
    // Look for patterns like: FROM database.table or JOIN database.table
    // Must be at the start of a clause (not inside parentheses like EXTRACT(... FROM ...))
    // Negative lookbehind for open paren to avoid matching function syntax
    // Use a simpler approach: only flag explicit database.schema.table patterns with known non-allowed databases
    const dbRefPattern = /\b(?:FROM|JOIN|INTO)\s+([a-zA-Z_][a-zA-Z0-9_]{2,})\.([a-zA-Z_][a-zA-Z0-9_]*)/gi;
    let match;
    while ((match = dbRefPattern.exec(sql)) !== null) {
      const potentialDb = match[1];
      const afterDot = match[2];
      // Skip common schema names (main, public, etc.) - these aren't database references
      if (['main', 'public', 'information_schema', 'pg_catalog'].includes(potentialDb.toLowerCase())) continue;
      // Skip if it looks like a table.column reference (afterDot is a column-like name)
      // Only flag if the first part looks like a database name and is NOT allowed
      if (!isDatabaseAllowed(potentialDb)) {
        return {
          allowed: false,
          message: `Access denied: Query references unauthorized database '${potentialDb}'. You can only access: ${ALLOWED_DATABASES.join(', ')}`
        };
      }
    }
  }

  return { allowed: true };
}

function convertToAnthropicMessages(messages: ChatMessage[]): MessageParam[] {
  return messages.map(msg => ({
    role: msg.role,
    content: msg.content,
  }));
}

// Helper to check if request was aborted
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export async function POST(request: NextRequest) {
  // Get abort signal from request for cancellation support
  const abortSignal = request.signal;
  const requestStartTime = Date.now();
  let llmCallCount = 0;
  let toolCallCount = 0;

  // Helper for timing logs
  const logTiming = (label: string, startTime: number) => {
    const duration = Date.now() - startTime;
    console.log(`[Chat API] ⏱️  ${label}: ${duration}ms`);
    return duration;
  };

  try {
    const body: ChatRequest = await request.json();
    const { messages, isMobile = false, includeMetadata = true, model, shareId } = body;

    const selectedModel = model || DEFAULT_MODEL;
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[Chat API] 🚀 REQUEST STARTED at ${new Date().toISOString()}`);
    console.log(`[Chat API] Model: ${selectedModel}, Mobile: ${isMobile}, Metadata: ${includeMetadata}`);
    console.log(`${'='.repeat(80)}`);
    if (shareId) {
      console.log('[Chat API] shareId provided:', shareId);
    }

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'No messages provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // If shareId is provided, fetch the shared report HTML and prepend as context
    let processedMessages = [...messages];
    if (shareId) {
      const sharedHtml = await fetchSharedReportHtml(shareId);
      if (sharedHtml) {
        console.log('[Chat API] Fetched shared report HTML, length:', sharedHtml.length);
        // Find the last user message and prepend context
        const lastUserMessageIndex = processedMessages.findLastIndex(m => m.role === 'user');
        if (lastUserMessageIndex !== -1) {
          const originalMessage = processedMessages[lastUserMessageIndex].content;
          const template = getPrompt('user-shared-report-context.md').replace(/^# .*\n+/, '');
          processedMessages[lastUserMessageIndex] = {
            ...processedMessages[lastUserMessageIndex],
            content: composePrompt(template, {
              'SHARED_HTML': sharedHtml,
              'ORIGINAL_MESSAGE': originalMessage as string,
            }),
          };
        }
      }
    }

    // Read metadata file if requested
    let metadata: string | undefined;
    if (includeMetadata) {
      try {
        const metadataPath = join(process.cwd(), 'eastlake_metadata.md');
        metadata = readFileSync(metadataPath, 'utf-8');
        console.log('[Chat API] Loaded metadata file, length:', metadata.length);
      } catch (error) {
        console.log('[Chat API] Metadata file not found, continuing without it');
      }
    } else {
      console.log('[Chat API] Metadata disabled by user');
    }

    // Create a fresh Anthropic client for this request to avoid stream conflicts
    const anthropic = createAnthropicClient();

    // Create MCP client and get tools
    let mcpClient;
    let mcpTools: Tool[] = [];
    try {
      mcpClient = await createMcpClient();
      mcpTools = await getToolsForClaude(mcpClient);
      console.log(`[Chat API] Got ${mcpTools.length} tools from MCP server`);
    } catch (error) {
      console.error('[Chat API] Failed to connect to MCP server:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return new Response(JSON.stringify({ error: `Failed to connect to MotherDuck: ${errorMessage}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Filter out list_databases tool and combine with our custom chart tool
    const filteredMcpTools = mcpTools.filter(tool => tool.name !== 'list_databases');
    const tools: Tool[] = [...filteredMcpTools, chartTool, mapTool];
    // For blended mode data gathering, only use database tools (no chart/map generation)
    const dataGatheringTools: Tool[] = [...filteredMcpTools];

    // Check if we're in blended mode
    const isBlendedMode = selectedModel === 'blended';

    // Create streaming response
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        // Helper to send SSE events
        const send = (event: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        try {
          let anthropicMessages = convertToAnthropicMessages(processedMessages);

          // ========== BLENDED MODE ==========
          if (isBlendedMode) {
            console.log('[Chat API] Starting BLENDED mode - Phase 1: Gemini data gathering');
            send({ type: 'text', content: 'Gathering data with Gemini...\n\n' });

            // Phase 1: Gemini gathers data
            let geminiMessages = convertToAnthropicMessages(processedMessages);
            let collectedData = '';
            let continueGathering = true;
            let gatherIteration = 0;
            let geminiRetryCount = 0;
            let geminiNeedsRetry = false;

            // Metadata tracking for saved HTML (blended mode)
            const blendedUserQuestion = messages[messages.length - 1]?.content || '';
            const blendedSqlQueries: Array<{ sql: string; result?: string }> = [];
            const blendedIntermediateOutput: string[] = [];

            while (continueGathering) {
              // Check for cancellation before each iteration
              if (isAborted(abortSignal)) {
                console.log('[Chat API] Request aborted by client during Gemini data gathering');
                send({ type: 'cancelled' });
                controller.close();
                if (mcpClient) await closeMcpClient(mcpClient);
                return;
              }

              geminiNeedsRetry = false;
              gatherIteration++;
              llmCallCount++;

              const dataGatheringSystemPrompt = getDataGatheringPrompt(metadata);
              console.log(`\n${'─'.repeat(60)}`);
              console.log(`[Chat API] 📤 BLENDED PHASE 1 - GEMINI LLM CALL #${llmCallCount} (iteration ${gatherIteration})`);
              console.log(`${'─'.repeat(60)}`);

              // Log system prompt (first iteration only)
              if (gatherIteration === 1) {
                console.log(`[Chat API] 📋 SYSTEM PROMPT (${dataGatheringSystemPrompt.length} chars):`);
                console.log(dataGatheringSystemPrompt.slice(0, 2000) + (dataGatheringSystemPrompt.length > 2000 ? '\n... [truncated]' : ''));
              }

              // Log messages
              console.log(`[Chat API] 💬 MESSAGES (${geminiMessages.length} total):`);
              for (const msg of geminiMessages) {
                const contentStr = typeof msg.content === 'string'
                  ? msg.content
                  : JSON.stringify(msg.content, null, 2);
                const truncated = contentStr.length > 1000 ? contentStr.slice(0, 1000) + '\n... [truncated]' : contentStr;
                console.log(`[Chat API]   [${msg.role}]: ${truncated}`);
              }

              const geminiLlmStartTime = Date.now();
              console.log(`[Chat API] ⏳ Starting Gemini LLM call at ${new Date().toISOString()}`);

              const geminiResponse = await anthropic.messages.create({
                model: GEMINI_MODEL,
                max_tokens: 8192,
                system: dataGatheringSystemPrompt,
                tools: dataGatheringTools,
                messages: geminiMessages,
                stream: true,
              });

              const assistantContentBlocks: ContentBlock[] = [];
              let currentToolUse: { id: string; name: string; input: string } | null = null;
              let currentTextContent = '';
              let hasToolUse = false;

              try {
                for await (const event of geminiResponse) {
                  if (event.type === 'content_block_start') {
                    if (event.content_block.type === 'tool_use') {
                      if (currentTextContent) {
                        // Text that precedes a tool call is reasoning - stream it as normal text
                        // (same as head-to-head mode so frontend handles it consistently)
                        send({ type: 'text', content: currentTextContent });
                        assistantContentBlocks.push({ type: 'text', text: currentTextContent, citations: [] });
                        currentTextContent = '';
                      }
                      currentToolUse = {
                        id: event.content_block.id,
                        name: event.content_block.name,
                        input: '',
                      };
                      hasToolUse = true;
                    }
                  } else if (event.type === 'content_block_delta') {
                    if (event.delta.type === 'text_delta') {
                      currentTextContent += event.delta.text;
                      // Don't stream text here - only stream when we know it precedes a tool call
                    } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
                      currentToolUse.input += event.delta.partial_json;
                    }
                  } else if (event.type === 'content_block_stop') {
                    if (currentToolUse) {
                      let parsedInput = {};
                      try {
                        parsedInput = JSON.parse(currentToolUse.input || '{}');
                      } catch {
                        parsedInput = {};
                      }
                      assistantContentBlocks.push({
                        type: 'tool_use',
                        id: currentToolUse.id,
                        name: currentToolUse.name,
                        input: parsedInput,
                      });
                      currentToolUse = null;
                    } else if (currentTextContent) {
                      assistantContentBlocks.push({ type: 'text', text: currentTextContent, citations: [] });
                    }
                  }
                }
              } catch (streamError) {
                console.error('[Chat API] Blended Gemini stream error:', streamError);

                // Check if this is a retryable error
                if (isRetryableError(streamError) && geminiRetryCount < MAX_RETRIES) {
                  geminiRetryCount++;
                  console.log(`[Chat API] Blended Gemini retryable error, attempt ${geminiRetryCount}/${MAX_RETRIES}. Retrying...`);
                  send({ type: 'text', content: `\n[Retrying Gemini ${geminiRetryCount}/${MAX_RETRIES}...]\n` });
                  await sleep(RETRY_DELAY_MS * geminiRetryCount);
                  geminiNeedsRetry = true;
                  continue; // Retry this iteration
                }

                const errMsg = streamError instanceof Error ? streamError.message : 'Stream error';
                send({ type: 'error', message: `Gemini error: ${errMsg}` });
                send({ type: 'done' });
                return; // Exit cleanly
              }

              // If we retried, skip the rest of this iteration
              if (geminiNeedsRetry) {
                continue;
              }

              // Log Gemini LLM response completion
              const geminiLlmDuration = logTiming(`Gemini LLM call #${llmCallCount}`, geminiLlmStartTime);
              const geminiResponseText = assistantContentBlocks.filter(b => b.type === 'text').map(b => (b as {text: string}).text).join('\n');
              console.log(`[Chat API] 📥 GEMINI RESPONSE #${llmCallCount} (${geminiResponseText.length} chars, ${geminiLlmDuration}ms):`);
              console.log(geminiResponseText.slice(0, 1000) + (geminiResponseText.length > 1000 ? '\n... [truncated]' : ''));

              // Capture all text from Gemini (including text before tool calls)
              for (const block of assistantContentBlocks) {
                if (block.type === 'text' && block.text) {
                  collectedData += block.text + '\n';
                  blendedIntermediateOutput.push(block.text);
                }
              }

              if (hasToolUse) {
                const toolUseBlocks = assistantContentBlocks.filter(block => block.type === 'tool_use');
                console.log(`\n[Chat API] 🔧 GEMINI TOOL CALLS: ${toolUseBlocks.length} tool(s) to execute`);

                // Send tool_start events to show progress (include SQL if available)
                for (const block of toolUseBlocks) {
                  if (block.type === 'tool_use') {
                    const input = block.input as Record<string, unknown>;
                    const sql = input?.sql as string | undefined;
                    send({ type: 'tool_start', tool: block.name, sql: sql || undefined });
                  }
                }

                // Execute tools in parallel
                const toolResultPromises = toolUseBlocks.map(async (block) => {
                  if (block.type !== 'tool_use') return null;
                  toolCallCount++;
                  const toolStartTime = Date.now();
                  const input = block.input as Record<string, unknown>;

                  console.log(`[Chat API] 🔧 GEMINI TOOL START #${toolCallCount}: ${block.name}`);
                  console.log(`[Chat API]    Input: ${JSON.stringify(input, null, 2).slice(0, 500)}${JSON.stringify(input).length > 500 ? '...' : ''}`);

                  const validation = validateToolAccess(block.name, input);
                  if (!validation.allowed) {
                    logTiming(`Tool ${block.name} (denied)`, toolStartTime);
                    console.log(`[Chat API] 🔧 GEMINI TOOL END #${toolCallCount}: ${block.name} - ACCESS DENIED`);
                    return {
                      type: 'tool_result' as const,
                      tool_use_id: block.id,
                      content: validation.message || 'Access denied',
                      is_error: true,
                    };
                  }

                  try {
                    const sql = input?.sql as string | undefined;
                    const toolResult = await executeTool(mcpClient!, block.name, input);
                    const toolDuration = logTiming(`Tool ${block.name}`, toolStartTime);

                    // Log tool result
                    console.log(`[Chat API] 🔧 GEMINI TOOL END #${toolCallCount}: ${block.name} (${toolDuration}ms, ${toolResult.length} chars)`);
                    console.log(`[Chat API]    Output: ${toolResult.slice(0, 500)}${toolResult.length > 500 ? '... [truncated]' : ''}`);

                    // Collect tool results for passing to Opus
                    collectedData += `\n**Tool: ${block.name}**\nInput: ${JSON.stringify(block.input)}\nResult: ${toolResult}\n`;
                    // Track SQL queries for metadata (blended mode)
                    if (sql && block.name === 'query') {
                      blendedSqlQueries.push({ sql, result: toolResult });
                    }
                    return {
                      type: 'tool_result' as const,
                      tool_use_id: block.id,
                      content: toolResult,
                    };
                  } catch (error) {
                    const toolDuration = logTiming(`Tool ${block.name} (error)`, toolStartTime);
                    console.error(`[Chat API] 🔧 GEMINI TOOL ERROR #${toolCallCount}: ${block.name} (${toolDuration}ms)`, error);
                    return {
                      type: 'tool_result' as const,
                      tool_use_id: block.id,
                      content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                      is_error: true,
                    };
                  }
                });

                const toolResults = (await Promise.all(toolResultPromises)).filter((r) => r !== null) as ToolResultBlockParam[];

                // Send tool_end events
                for (const block of toolUseBlocks) {
                  if (block.type === 'tool_use') {
                    send({ type: 'tool_end', tool: block.name });
                  }
                }

                geminiMessages = [
                  ...geminiMessages,
                  { role: 'assistant', content: assistantContentBlocks },
                  { role: 'user', content: toolResults },
                ];
              } else {
                continueGathering = false;
              }
            }

            console.log(`\n[Chat API] ✅ BLENDED PHASE 1 COMPLETE - Data collected: ${collectedData.length} chars`);

            // Check for cancellation before Opus phase
            if (isAborted(abortSignal)) {
              console.log('[Chat API] Request aborted by client before Opus report generation');
              send({ type: 'cancelled' });
              controller.close();
              if (mcpClient) await closeMcpClient(mcpClient);
              return;
            }

            console.log(`\n${'─'.repeat(60)}`);
            console.log('[Chat API] 📤 BLENDED PHASE 2 - OPUS REPORT GENERATION');
            console.log(`${'─'.repeat(60)}`);
            send({ type: 'text', content: '\nGenerating report with Claude Opus...\n\n' });

            // Phase 2: Opus generates the report
            const userQuestion = messages[messages.length - 1]?.content || '';
            const opusTemplate = getPrompt('user-blended-opus-input.md').replace(/^# .*\n+/, '');
            const opusUserMessage = composePrompt(opusTemplate, {
              'USER_QUESTION': userQuestion,
              'COLLECTED_DATA': collectedData,
            });
            const opusMessages: MessageParam[] = [
              {
                role: 'user',
                content: opusUserMessage,
              },
            ];

            const reportGenSystemPrompt = getReportGenerationPrompt(isMobile);
            console.log(`[Chat API] 📋 OPUS SYSTEM PROMPT (${reportGenSystemPrompt.length} chars):`);
            console.log(reportGenSystemPrompt.slice(0, 2000) + (reportGenSystemPrompt.length > 2000 ? '\n... [truncated]' : ''));
            console.log(`[Chat API] 💬 OPUS USER MESSAGE (${opusUserMessage.length} chars):`);
            console.log(opusUserMessage.slice(0, 2000) + (opusUserMessage.length > 2000 ? '\n... [truncated]' : ''));

            let opusRetryCount = 0;
            let opusSuccess = false;

            let opusFullResponse = '';

            while (!opusSuccess && opusRetryCount <= MAX_RETRIES) {
              // Check for cancellation before each Opus attempt
              if (isAborted(abortSignal)) {
                console.log('[Chat API] Request aborted by client during Opus generation');
                send({ type: 'cancelled' });
                controller.close();
                if (mcpClient) await closeMcpClient(mcpClient);
                return;
              }

              llmCallCount++;
              const opusLlmStartTime = Date.now();
              console.log(`[Chat API] ⏳ Starting Opus LLM call #${llmCallCount} at ${new Date().toISOString()}`);

              try {
                opusFullResponse = ''; // Reset on retry
                const opusResponse = await anthropic.messages.create({
                  model: OPUS_MODEL,
                  max_tokens: 16384,
                  system: reportGenSystemPrompt,
                  messages: opusMessages,
                  stream: true,
                });

                // Stream Opus's response to the user
                for await (const event of opusResponse) {
                  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    opusFullResponse += event.delta.text;
                    send({ type: 'text', content: event.delta.text });
                  }
                }

                const opusLlmDuration = logTiming(`Opus LLM call #${llmCallCount}`, opusLlmStartTime);
                console.log(`[Chat API] 📥 OPUS RESPONSE #${llmCallCount} (${opusFullResponse.length} chars, ${opusLlmDuration}ms)`);
                console.log(opusFullResponse.slice(0, 1000) + (opusFullResponse.length > 1000 ? '\n... [truncated]' : ''));

                opusSuccess = true;
              } catch (opusError) {
                console.error('[Chat API] Blended Opus stream error:', opusError);

                if (isRetryableError(opusError) && opusRetryCount < MAX_RETRIES) {
                  opusRetryCount++;
                  console.log(`[Chat API] Blended Opus retryable error, attempt ${opusRetryCount}/${MAX_RETRIES}. Retrying...`);
                  send({ type: 'text', content: `\n[Retrying Opus ${opusRetryCount}/${MAX_RETRIES}...]\n` });
                  await sleep(RETRY_DELAY_MS * opusRetryCount);
                  continue;
                }

                const errMsg = opusError instanceof Error ? opusError.message : 'Stream error';
                send({ type: 'error', message: `Opus error: ${errMsg}` });
                send({ type: 'done' });
                controller.close();
                if (mcpClient) {
                  await closeMcpClient(mcpClient);
                }
                return;
              }
            }

            // Check for HTML content and save it
            if (containsHtml(opusFullResponse)) {
              const htmlContent = extractHtmlContent(opusFullResponse);
              if (htmlContent) {
                const htmlMetadata: HtmlMetadata = {
                  question: blendedUserQuestion,
                  sqlQueries: blendedSqlQueries,
                  intermediateOutput: blendedIntermediateOutput,
                  model: 'blended (Gemini + Opus)',
                  timestamp: new Date().toISOString(),
                  isMobile,
                };
                const contentId = await saveHtmlContent(htmlContent, htmlMetadata);
                if (contentId) {
                  send({ type: 'content_saved', contentId });
                  console.log('[Chat API] Blended mode: Saved HTML content with ID:', contentId);
                }
              }
            }

            send({ type: 'done' });
            controller.close();

            // Log blended mode completion summary
            const totalDuration = Date.now() - requestStartTime;
            console.log(`\n${'='.repeat(80)}`);
            console.log(`[Chat API] ✅ BLENDED MODE REQUEST COMPLETED at ${new Date().toISOString()}`);
            console.log(`[Chat API] 📊 Summary: ${llmCallCount} LLM calls, ${toolCallCount} tool calls`);
            console.log(`[Chat API] ⏱️  Total duration: ${totalDuration}ms (${(totalDuration / 1000).toFixed(2)}s)`);
            console.log(`${'='.repeat(80)}\n`);

            if (mcpClient) {
              await closeMcpClient(mcpClient);
            }
            return;
          }

          // ========== STANDARD MODE (non-blended) ==========

          // Metadata tracking for saved HTML
          const userQuestion = messages[messages.length - 1]?.content || '';

          // Apply standalone user message template (only if not already processed by shareId)
          if (!shareId) {
            const lastUserIndex = anthropicMessages.findLastIndex(m => m.role === 'user');
            if (lastUserIndex !== -1) {
              const lastUserContent = anthropicMessages[lastUserIndex].content;
              const originalQuestion = typeof lastUserContent === 'string'
                ? lastUserContent
                : (lastUserContent as Array<{type: string; text?: string}>).find(b => b.type === 'text')?.text || '';

              // Build conversation context from previous messages (if any)
              let conversationContext = '';
              if (messages.length > 1) {
                const previousMessages = messages.slice(0, -1);
                const contextSummary = previousMessages
                  .filter(m => m.role === 'user' || m.role === 'assistant')
                  .slice(-4) // Last 4 messages for context
                  .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : '[complex content]'}`)
                  .join('\n');
                if (contextSummary) {
                  conversationContext = `**Conversation Context:**\n${contextSummary}\n`;
                }
              }

              const standaloneTemplate = getPrompt('user-standalone-query.md').replace(/^# .*\n+/, '');
              const wrappedMessage = composePrompt(standaloneTemplate, {
                'USER_QUESTION': originalQuestion,
                'CONVERSATION_CONTEXT': conversationContext,
              });

              anthropicMessages[lastUserIndex] = {
                ...anthropicMessages[lastUserIndex],
                content: wrappedMessage,
              };
            }
          }

          // Loop to handle tool use
          let continueLoop = true;
          let isFirstResponse = true;
          let loopIteration = 0;
          let retryCount = 0;
          let needsRetry = false;
          const sqlQueries: Array<{ sql: string; result?: string }> = [];
          const intermediateOutput: string[] = [];

          while (continueLoop) {
            // Check for cancellation before each iteration
            if (isAborted(abortSignal)) {
              console.log('[Chat API] Request aborted by client during standard mode');
              send({ type: 'cancelled' });
              controller.close();
              if (mcpClient) await closeMcpClient(mcpClient);
              return;
            }

            needsRetry = false;
            loopIteration++;
            llmCallCount++;
            // Add newline separator between responses (after tool use)
            if (!isFirstResponse) {
              send({ type: 'text', content: '\n\n' });
            }
            isFirstResponse = false;

            // Log the prompt being sent
            const systemPrompt = getSystemPrompt(isMobile, metadata);
            console.log(`\n${'─'.repeat(60)}`);
            console.log(`[Chat API] 📤 LLM CALL #${llmCallCount} (iteration ${loopIteration})`);
            console.log(`${'─'.repeat(60)}`);

            // Log system prompt (first iteration only, truncated)
            if (loopIteration === 1) {
              console.log(`[Chat API] 📋 SYSTEM PROMPT (${systemPrompt.length} chars):`);
              console.log(systemPrompt.slice(0, 2000) + (systemPrompt.length > 2000 ? '\n... [truncated]' : ''));
            }

            // Log all messages
            console.log(`[Chat API] 💬 MESSAGES (${anthropicMessages.length} total):`);
            for (const msg of anthropicMessages) {
              const contentStr = typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify(msg.content, null, 2);
              const truncated = contentStr.length > 1000 ? contentStr.slice(0, 1000) + '\n... [truncated]' : contentStr;
              console.log(`[Chat API]   [${msg.role}]: ${truncated}`);
            }

            const llmStartTime = Date.now();
            console.log(`[Chat API] ⏳ Starting LLM call at ${new Date().toISOString()}`);

            const response = await anthropic.messages.create({
              model: selectedModel,
              max_tokens: 16384,
              system: systemPrompt,
              tools: tools,
              messages: anthropicMessages,
              stream: true,
            });

            // Collect all content blocks from the streaming response
            const assistantContentBlocks: ContentBlock[] = [];
            let currentToolUse: { id: string; name: string; input: string } | null = null;
            let currentTextContent = '';
            let hasToolUse = false;
            let fullResponseText = ''; // For logging

            try {
              for await (const event of response) {
                if (event.type === 'content_block_start') {
                  if (event.content_block.type === 'tool_use') {
                    if (currentTextContent) {
                      assistantContentBlocks.push({ type: 'text', text: currentTextContent, citations: [] });
                      currentTextContent = '';
                    }
                    currentToolUse = {
                      id: event.content_block.id,
                      name: event.content_block.name,
                      input: '',
                    };
                    hasToolUse = true;
                  } else if (event.content_block.type === 'text') {
                    currentTextContent = '';
                  }
                } else if (event.type === 'content_block_delta') {
                  if (event.delta.type === 'text_delta') {
                    currentTextContent += event.delta.text;
                    fullResponseText += event.delta.text; // Capture for logging
                    send({ type: 'text', content: event.delta.text });
                  } else if (event.delta.type === 'input_json_delta' && currentToolUse) {
                    currentToolUse.input += event.delta.partial_json;
                  }
                } else if (event.type === 'content_block_stop') {
                  if (currentToolUse) {
                    let parsedInput = {};
                    try {
                      parsedInput = JSON.parse(currentToolUse.input || '{}');
                    } catch {
                      parsedInput = {};
                    }
                    assistantContentBlocks.push({
                      type: 'tool_use',
                      id: currentToolUse.id,
                      name: currentToolUse.name,
                      input: parsedInput,
                    });
                    currentToolUse = null;
                  } else if (currentTextContent) {
                    assistantContentBlocks.push({ type: 'text', text: currentTextContent, citations: [] });
                    currentTextContent = '';
                  }
                }
              }
            } catch (streamError) {
              console.error('[Chat API] Stream error during iteration:', streamError);

              // Check if this is a retryable error
              if (isRetryableError(streamError) && retryCount < MAX_RETRIES) {
                retryCount++;
                console.log(`[Chat API] Retryable error detected, attempt ${retryCount}/${MAX_RETRIES}. Retrying in ${RETRY_DELAY_MS}ms...`);
                send({ type: 'text', content: `\n[Retrying request ${retryCount}/${MAX_RETRIES}...]\n` });
                await sleep(RETRY_DELAY_MS * retryCount); // Exponential backoff
                needsRetry = true;
                break; // Break out of stream iteration to retry
              }

              const errMsg = streamError instanceof Error ? streamError.message : 'Stream error';
              try {
                send({ type: 'error', message: errMsg });
                send({ type: 'done' });
              } catch (enqueueError) {
                console.error('[Chat API] Failed to send error to client:', enqueueError);
              }
              try {
                controller.close();
              } catch { /* already closed */ }
              return; // Exit the stream cleanly
            }

            // If we need to retry, skip the rest of this iteration
            if (needsRetry) {
              continue;
            }

            // Log LLM response completion
            const llmDuration = logTiming(`LLM call #${llmCallCount} completed`, llmStartTime);
            console.log(`[Chat API] 📥 RESPONSE #${llmCallCount} (${fullResponseText.length} chars, ${llmDuration}ms):`);
            const responseLines = fullResponseText.split('\n').slice(0, 50);
            console.log(responseLines.join('\n'));
            if (fullResponseText.split('\n').length > 50) {
              console.log(`[Chat API] ... (${fullResponseText.split('\n').length - 50} more lines)`);
            }

            // If there were tool uses, execute them in parallel
            if (hasToolUse) {
              const toolUseBlocks = assistantContentBlocks.filter(block => block.type === 'tool_use');
              console.log(`\n[Chat API] 🔧 TOOL CALLS: ${toolUseBlocks.length} tool(s) to execute`);

              // Send all tool_start events with SQL if available
              for (const block of toolUseBlocks) {
                if (block.type === 'tool_use') {
                  const input = block.input as Record<string, unknown>;
                  const sql = input?.sql as string | undefined;
                  send({ type: 'tool_start', tool: block.name, sql: sql || undefined });
                }
              }

              // Execute all tools in parallel
              const toolResultPromises = toolUseBlocks.map(async (block) => {
                if (block.type !== 'tool_use') return null;
                toolCallCount++;
                const toolStartTime = Date.now();
                const input = block.input as Record<string, unknown>;

                console.log(`[Chat API] 🔧 TOOL START #${toolCallCount}: ${block.name}`);
                console.log(`[Chat API]    Input: ${JSON.stringify(input, null, 2).slice(0, 500)}${JSON.stringify(input).length > 500 ? '...' : ''}`);

                try {
                  if (block.name === 'generate_chart') {
                    const chartSpec = block.input as Record<string, unknown>;
                    send({ type: 'chart', spec: chartSpec });
                    const result = 'Chart generated and displayed to user.';
                    logTiming(`Tool ${block.name}`, toolStartTime);
                    console.log(`[Chat API] 🔧 TOOL END #${toolCallCount}: ${block.name} - ${result}`);
                    return {
                      type: 'tool_result' as const,
                      tool_use_id: block.id,
                      content: result,
                    };
                  } else if (block.name === 'generate_map') {
                    const mapSpec = block.input as Record<string, unknown>;
                    send({ type: 'map', spec: mapSpec });
                    const result = 'Map generated and displayed to user.';
                    logTiming(`Tool ${block.name}`, toolStartTime);
                    console.log(`[Chat API] 🔧 TOOL END #${toolCallCount}: ${block.name} - ${result}`);
                    return {
                      type: 'tool_result' as const,
                      tool_use_id: block.id,
                      content: result,
                    };
                  } else {
                    // Validate database access before executing tool
                    const validation = validateToolAccess(block.name, input);
                    if (!validation.allowed) {
                      logTiming(`Tool ${block.name} (denied)`, toolStartTime);
                      console.log(`[Chat API] 🔧 TOOL END #${toolCallCount}: ${block.name} - ACCESS DENIED: ${validation.message}`);
                      return {
                        type: 'tool_result' as const,
                        tool_use_id: block.id,
                        content: validation.message || 'Access denied',
                        is_error: true,
                      };
                    }

                    const sql = input?.sql as string | undefined;
                    const toolResult = await executeTool(mcpClient!, block.name, input);
                    const toolDuration = logTiming(`Tool ${block.name}`, toolStartTime);

                    // Log tool result (truncated)
                    const resultPreview = toolResult.length > 1000 ? toolResult.slice(0, 1000) + '... [truncated]' : toolResult;
                    console.log(`[Chat API] 🔧 TOOL END #${toolCallCount}: ${block.name} (${toolDuration}ms, ${toolResult.length} chars)`);
                    console.log(`[Chat API]    Output: ${resultPreview}`);

                    // Track SQL queries for metadata
                    if (sql && block.name === 'query') {
                      sqlQueries.push({ sql, result: toolResult });
                    }
                    return {
                      type: 'tool_result' as const,
                      tool_use_id: block.id,
                      content: toolResult,
                    };
                  }
                } catch (error) {
                  const toolDuration = logTiming(`Tool ${block.name} (error)`, toolStartTime);
                  console.error(`[Chat API] 🔧 TOOL ERROR #${toolCallCount}: ${block.name} (${toolDuration}ms)`, error);
                  return {
                    type: 'tool_result' as const,
                    tool_use_id: block.id,
                    content: `Error executing tool: ${error instanceof Error ? error.message : 'Unknown error'}`,
                    is_error: true,
                  };
                }
              });

              const toolResults = (await Promise.all(toolResultPromises)).filter((r) => r !== null) as ToolResultBlockParam[];

              // Send all tool_end events
              for (const block of toolUseBlocks) {
                if (block.type === 'tool_use') {
                  console.log('[Chat API] Sending tool_end event for:', block.name);
                  send({ type: 'tool_end', tool: block.name });
                }
              }

              // Capture intermediate text output before continuing
              if (fullResponseText.trim()) {
                intermediateOutput.push(fullResponseText);
              }

              // Continue conversation with assistant's tool_use and user's tool_result
              anthropicMessages = [
                ...anthropicMessages,
                { role: 'assistant', content: assistantContentBlocks },
                { role: 'user', content: toolResults },
              ];
            } else {
              // No more tool use - check for HTML or markdown content and save it
              if (containsHtml(fullResponseText)) {
                const htmlContent = extractHtmlContent(fullResponseText);
                if (htmlContent) {
                  const htmlMetadata: HtmlMetadata = {
                    question: userQuestion,
                    sqlQueries,
                    intermediateOutput,
                    model: selectedModel,
                    timestamp: new Date().toISOString(),
                    isMobile,
                  };
                  const contentId = await saveHtmlContent(htmlContent, htmlMetadata);
                  if (contentId) {
                    send({ type: 'content_saved', contentId });
                    console.log('[Chat API] Saved HTML content with ID:', contentId);
                  }
                }
              } else if (fullResponseText.trim() && userQuestion.toLowerCase().includes('motherduck')) {
                // Markdown response (motherduck style) - convert to HTML and save
                const markdownMetadata: HtmlMetadata = {
                  question: userQuestion,
                  sqlQueries,
                  intermediateOutput,
                  model: selectedModel,
                  timestamp: new Date().toISOString(),
                  isMobile,
                };
                const htmlFromMarkdown = markdownToHtml(fullResponseText, markdownMetadata);
                const contentId = await saveHtmlContent(htmlFromMarkdown, markdownMetadata);
                if (contentId) {
                  send({ type: 'content_saved', contentId });
                  console.log('[Chat API] Saved markdown-to-HTML content with ID:', contentId);
                }
              }
              continueLoop = false;
            }
          }

          send({ type: 'done' });
          controller.close();

          // Log request completion summary
          const totalDuration = Date.now() - requestStartTime;
          console.log(`\n${'='.repeat(80)}`);
          console.log(`[Chat API] ✅ REQUEST COMPLETED at ${new Date().toISOString()}`);
          console.log(`[Chat API] 📊 Summary: ${llmCallCount} LLM calls, ${toolCallCount} tool calls`);
          console.log(`[Chat API] ⏱️  Total duration: ${totalDuration}ms (${(totalDuration / 1000).toFixed(2)}s)`);
          console.log(`${'='.repeat(80)}\n`);
        } catch (error) {
          console.error('[Chat API] Stream error:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error('[Chat API] Error details:', errorMessage);
          send({ type: 'error', message: `Error: ${errorMessage}` });
          controller.close();

          // Log request failure
          const totalDuration = Date.now() - requestStartTime;
          console.log(`\n${'='.repeat(80)}`);
          console.log(`[Chat API] ❌ REQUEST FAILED at ${new Date().toISOString()}`);
          console.log(`[Chat API] ⏱️  Total duration: ${totalDuration}ms`);
          console.log(`${'='.repeat(80)}\n`);
        } finally {
          if (mcpClient) {
            await closeMcpClient(mcpClient);
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (error) {
    console.error(`[Chat API] Error:`, error);
    return new Response(JSON.stringify({ error: 'Failed to process chat request' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
