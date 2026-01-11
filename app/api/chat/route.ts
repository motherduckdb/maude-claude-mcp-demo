import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createMcpClient, getToolsForClaude, executeTool, closeMcpClient } from '@/lib/mcp-client';
import type { MessageParam, ToolResultBlockParam, ContentBlock, Tool } from '@anthropic-ai/sdk/resources/messages';
import { readFileSync } from 'fs';
import { join } from 'path';
import { query } from '@/lib/planetscale';

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

// Save HTML content to database and return ID
async function saveHtmlContent(html: string, metadata?: HtmlMetadata): Promise<string | null> {
  try {
    const id = generateContentId();
    const htmlWithMetadata = metadata ? injectMetadataComments(html, metadata) : html;
    const model = metadata?.model || null;
    await query(
      `INSERT INTO shares (id, html_content, model, created_at, expires_at)
       VALUES ($1, $2, $3, NOW(), NOW() + INTERVAL '30 days')`,
      [id, htmlWithMetadata, model]
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

// Shared prompt components to keep instructions consistent across modes
const DATABASE_RULES = `IMPORTANT: You only have access to the following databases: ${ALLOWED_DATABASES.join(', ')}
Do not attempt to query or access any other databases.

CRITICAL: All data in your responses (names, places, companies, products, dates, numbers) must come ONLY from actual SQL query results returned by the MotherDuck MCP server Eastlake dataset. Never invent, fabricate, or hallucinate any data values.`;

const NARRATION_INSTRUCTIONS = `**CRITICAL - NARRATE YOUR DATABASE WORK**: Before EACH database operation, you MUST describe what you're about to do. This is mandatory:
- Before listing tables: "Exploring available tables in the database..."
- Before checking columns: "Checking the structure of [table_name] table..."
- Before running a query: "Querying [brief description]..." and show the SQL query you'll run
- After getting results: Briefly note what you found (e.g., "Found 15 customers with orders...")
- Before generating HTML: "Generating [Report Title]..." (e.g., "Generating Customer Analysis Report...")

This narration is essential so users can follow your progress while queries run.`;

const getMobileLayoutInstructions = (isMobile: boolean) => isMobile ? `**MOBILE LAYOUT**: The user is on a mobile device. Generate reports with a single-column layout optimized for narrow screens (max-width: 400px). Use stacked sections instead of grids, larger touch-friendly text, and avoid wide tables. Keep visualizations simple and vertically oriented.

` : '';

const getMetadataSection = (metadata?: string) => metadata ? `**DATABASE METADATA**:
${metadata}

` : '';

// Instructions to use metadata instead of schema exploration (only when metadata is provided)
const getMetadataUsageInstructions = (metadata?: string) => metadata ? `**USE THE PROVIDED METADATA**: The DATABASE METADATA section above contains complete table schemas. DO NOT use list_tables or list_columns tools - you already have all table and column information. Go directly to running SQL queries.

` : '';

const TUFTE_STYLE_GUIDE = `TUFTE STYLE GUIDE FOR HTML GENERATION:

Core Philosophy:
1. Maximize data-ink ratio — Every pixel should convey information. Remove chartjunk and decorative elements.
2. Small multiples — Use consistent visual encoding across repeated elements for easy comparison.
3. Integrate text and data — Weave narrative prose with inline statistics.
4. High information density — Pack maximum insight into minimum space.

Typography:
- Use Google Fonts: Source Sans Pro for numbers, system serif (Palatino, Georgia) for text
- Big numbers: 42px, letter-spacing: -1px
- Section headers: 11px uppercase, letter-spacing: 1.5px
- Body: 14px, line-height: 1.6
- Tables: 12px body, 10px headers

Color Palette:
- Background: #fffff8 (warm cream, Tufte signature)
- Text: #111 (primary), #666 (secondary), #999 (tertiary)
- Accent: #a00 (burgundy - use sparingly for emphasis)
- Lines/borders: #ccc
- Bars: #888 (grayscale)

Layout:
- padding: 40px 60px, max-width: 1200px
- Use CSS Grid: 4-col for KPIs, 2-col for main content, 3-col for details
- Section spacing: 28px between major sections

Components to use:
- Big numbers with small labels for KPIs
- Inline bar charts in tables (div with percentage width)
- SVG sparklines with area fill and accent dot on final point
- Horizontal bar rows for year-over-year comparisons
- Tables with right-aligned numeric columns using tabular-nums

Anti-patterns (avoid):
- No pie charts (use tables with inline bars)
- No 3D effects, gradients for decoration
- No colored section backgrounds
- No chart borders/frames
- No excessive gridlines`;

const HTML_TEMPLATE = `HTML Template structure:
\`\`\`html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link href="https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@400;600&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: Palatino, Georgia, serif;
            background: #fffff8;
            padding: 40px 60px;
            max-width: 1200px;
            margin: 0 auto;
            color: #111;
        }
        .num { font-family: 'Source Sans Pro', sans-serif; font-variant-numeric: tabular-nums; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 32px; }
        .grid-2 { display: grid; grid-template-columns: 2fr 1fr; gap: 40px; }
        .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #999; border-bottom: 1px solid #ccc; padding-bottom: 4px; margin-bottom: 12px; }
        .big-number { font-size: 42px; letter-spacing: -1px; line-height: 1; }
        .big-number-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { text-align: left; font-weight: 400; color: #999; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; padding: 4px 8px 4px 0; border-bottom: 1px solid #ccc; }
        td { padding: 5px 8px 5px 0; border-bottom: 1px solid #eee; }
        .bar-container { background: #f0f0f0; height: 12px; width: 100px; }
        .bar { background: #888; height: 100%; }
        .highlight { background: rgba(160,0,0,0.08); padding: 0 3px; }
        .accent { color: #a00; }
    </style>
</head>
<body>
    <!-- KPI row, main content, detail sections -->
</body>
</html>
\`\`\``;

const getSystemPrompt = (isMobile: boolean, metadata?: string) => `You are a helpful data assistant with access to MotherDuck databases through the Model Context Protocol (MCP).

**CRITICAL - DEFAULT RESPONSE FORMAT**: You MUST respond with a complete HTML page visualization (using the Tufte style guide below) for EVERY response, UNLESS the user's message contains the word "motherduck" (case-insensitive). This is your primary output format. Query the data first, then generate a full HTML document with your analysis.

${getMobileLayoutInstructions(isMobile)}${getMetadataSection(metadata)}${getMetadataUsageInstructions(metadata)}${NARRATION_INSTRUCTIONS}

${DATABASE_RULES}

When answering questions:
1. ${metadata ? 'Review the DATABASE METADATA above' : 'Use list_tables and list_columns tools'} to understand available tables and columns
2. Use the query tool to run SQL queries against the data
3. Format numbers and dates in a readable way
4. Present results as a complete HTML visualization (unless "motherduck" is in the prompt)

CHARTS: You can generate charts to visualize data using the generate_chart tool. After querying data, consider creating a chart when:
- The user asks about trends over time (use line chart)
- The user asks for comparisons between categories (use bar chart)
- The user asks about proportions or distributions (use pie chart)
- The user asks about process stability or statistical variation (use xmr chart)

When generating charts:
- Keep data to a reasonable number of points (10-20 for line/bar/xmr, 5-8 for pie)
- Use clear, descriptive titles
- For time series, format dates as short strings (e.g., "Jan 1", "Dec 15")

SPARKLINES: When displaying tabular data with time-series values (like revenue over time per customer), you can embed mini sparkline charts directly in table cells. To create a sparkline, use this syntax in a table cell:
  sparkline(value1,value2,value3,...)

CRITICAL SPARKLINE RULE: Sparklines MUST have EXACTLY 6 data points. No more, no less. When querying data for sparklines, always aggregate to exactly 6 time periods (e.g., 6 months, 6 quarters, or 6 evenly-spaced samples). This is a hard requirement for performance.

Example table with sparklines (note: exactly 6 values each):
| Customer | Total Revenue | Trend |
|----------|---------------|-------|
| Acme Inc | $45,000 | sparkline(12,15,18,21,24,26) |
| Beta Corp | $32,000 | sparkline(8,7,9,11,12,14) |

Use sparklines when:
- Showing trends alongside summary data in tables
- Comparing patterns across multiple entities (customers, products, regions)
- The user asks for "trends" or "over time" data in a tabular format

The sparkline values should be the actual numeric data points (not formatted with currency symbols). Use simple integers when possible (e.g., divide by 1000 for thousands). Remember: EXACTLY 6 data points per sparkline.

MAPS: You can generate interactive maps using the generate_map tool when data has geographic information. Use maps when:
- The user asks about regional or geographic analysis
- Data includes cities, states, countries, or coordinates
- The user explicitly asks for a map visualization
- Analyzing sales, customers, or orders by location

When generating maps:
- Each data point needs: lat (latitude), lng (longitude), label (location name), value (numeric value for marker size)
- Optionally include details object with additional key-value pairs to show in the popup
- Use valueLabel to describe what the value represents (e.g., "Revenue", "Orders")
- For US data, common city coordinates can be approximated or queried if available
- Keep data points reasonable (20-50 locations max for readability)

Example map data format:
{
  "title": "Sales by Region",
  "valueLabel": "Revenue",
  "data": [
    {"lat": 40.7128, "lng": -74.0060, "label": "New York", "value": 125000, "details": {"Orders": 450, "Customers": 120}},
    {"lat": 34.0522, "lng": -118.2437, "label": "Los Angeles", "value": 98000, "details": {"Orders": 320, "Customers": 95}}
  ]
}

Always explain your findings clearly and offer to provide more detail if needed.

HTML VISUALIZATIONS: When asked for detailed analysis, dashboards, or rich visualizations, generate a complete HTML page following the Tufte style guide below. Return the HTML inside a markdown code block with the html language tag. The HTML will be rendered in an iframe.

IMPORTANT: When generating HTML responses, do NOT use our custom tools (generate_chart, generate_map, sparkline() syntax). Instead, use standard HTML/CSS/JavaScript techniques:
- SVG for sparklines and charts (inline SVG paths)
- CSS for bar charts (div elements with percentage widths)
- Any standard JavaScript charting libraries if needed (Chart.js, D3.js, etc.)
- The HTML should be fully self-contained and render independently in an iframe.

${TUFTE_STYLE_GUIDE}

${HTML_TEMPLATE}

IMPORTANT: Do not end your responses with colons. Avoid phrases like "Here are the results:" or "Let me check:" before using tools. Instead, just use the tool and then present the findings directly.

REMINDER: Your response MUST be a complete HTML page inside a \`\`\`html code block (unless "motherduck" appears in the user's message). Always generate HTML output by default.`;

// System prompt for Gemini in blended mode - focused on data gathering only
const getDataGatheringPrompt = (metadata?: string) => `You are a data analyst assistant gathering data from MotherDuck databases. Your job is to collect all the data needed to answer the user's question.

${getMetadataSection(metadata)}${getMetadataUsageInstructions(metadata)}${DATABASE_RULES}

${NARRATION_INSTRUCTIONS}

Your task:
1. ${metadata ? 'Review the DATABASE METADATA above' : 'Use list_tables and list_columns tools'} to understand available tables and columns
2. Write and execute SQL queries using the query tool to gather the data needed
3. Run multiple queries if needed to get comprehensive data
4. After gathering data, provide a clear summary of what you found

${metadata ? 'DO NOT waste time exploring schema - use the metadata provided. ' : ''}DO NOT generate any HTML or visualizations. Just gather the data and summarize your findings in plain text.

Format your final summary as:
**Data Summary:**
- Describe what data was collected
- Include key statistics and findings
- Note any relevant patterns or insights

**Raw Data:**
Include the actual query results that will be used for visualization.`;

// System prompt for Opus in blended mode - focused on HTML generation from provided data
const getReportGenerationPrompt = (isMobile: boolean) => `You are an expert data visualization specialist. You have been provided with data that was gathered by another assistant. Your job is to create a beautiful, insightful HTML report from this data.

${getMobileLayoutInstructions(isMobile)}Generate a complete HTML page following the Tufte style guide:

${TUFTE_STYLE_GUIDE}

${HTML_TEMPLATE}

Return ONLY the complete HTML page inside a \`\`\`html code block. Include insightful analysis woven into the visualization.`;

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

export async function POST(request: NextRequest) {
  try {
    const body: ChatRequest = await request.json();
    const { messages, isMobile = false, includeMetadata = true, model, shareId } = body;

    const selectedModel = model || DEFAULT_MODEL;
    console.log('[Chat API] Request started via OpenRouter, model:', selectedModel);
    console.log('[Chat API] includeMetadata:', includeMetadata);
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
          processedMessages[lastUserMessageIndex] = {
            ...processedMessages[lastUserMessageIndex],
            content: `[Context: The user is asking a follow-up question about a previously generated report. The full HTML of that report is provided below for context.]

=== PREVIOUS REPORT HTML ===
${sharedHtml}
=== END PREVIOUS REPORT ===

[User's follow-up question]:
${originalMessage}`
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
              geminiNeedsRetry = false;
              gatherIteration++;
              console.log(`[Chat API] Blended Phase 1 - Iteration ${gatherIteration}`);

              const geminiResponse = await anthropic.messages.create({
                model: GEMINI_MODEL,
                max_tokens: 8192,
                system: getDataGatheringPrompt(metadata),
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

              // Capture all text from Gemini (including text before tool calls)
              for (const block of assistantContentBlocks) {
                if (block.type === 'text' && block.text) {
                  collectedData += block.text + '\n';
                  blendedIntermediateOutput.push(block.text);
                }
              }

              if (hasToolUse) {
                const toolUseBlocks = assistantContentBlocks.filter(block => block.type === 'tool_use');

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

                  const validation = validateToolAccess(block.name, block.input as Record<string, unknown>);
                  if (!validation.allowed) {
                    return {
                      type: 'tool_result' as const,
                      tool_use_id: block.id,
                      content: validation.message || 'Access denied',
                      is_error: true,
                    };
                  }

                  try {
                    const input = block.input as Record<string, unknown>;
                    const sql = input?.sql as string | undefined;
                    const toolResult = await executeTool(mcpClient!, block.name, input);
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

            console.log('[Chat API] Blended Phase 1 complete. Data collected:', collectedData.length, 'chars');
            console.log('[Chat API] Starting BLENDED mode - Phase 2: Opus report generation');
            send({ type: 'text', content: '\nGenerating report with Claude Opus...\n\n' });

            // Phase 2: Opus generates the report
            const userQuestion = messages[messages.length - 1]?.content || '';
            const opusMessages: MessageParam[] = [
              {
                role: 'user',
                content: `**User's Question:** ${userQuestion}

**Collected Data:**
${collectedData}

Please create a comprehensive HTML visualization report based on this data.`,
              },
            ];

            let opusRetryCount = 0;
            let opusSuccess = false;

            let opusFullResponse = '';

            while (!opusSuccess && opusRetryCount <= MAX_RETRIES) {
              try {
                opusFullResponse = ''; // Reset on retry
                const opusResponse = await anthropic.messages.create({
                  model: OPUS_MODEL,
                  max_tokens: 16384,
                  system: getReportGenerationPrompt(isMobile),
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
            if (mcpClient) {
              await closeMcpClient(mcpClient);
            }
            return;
          }

          // ========== STANDARD MODE (non-blended) ==========

          // Loop to handle tool use
          let continueLoop = true;
          let isFirstResponse = true;
          let loopIteration = 0;
          let retryCount = 0;
          let needsRetry = false;

          // Metadata tracking for saved HTML
          const userQuestion = messages[messages.length - 1]?.content || '';
          const sqlQueries: Array<{ sql: string; result?: string }> = [];
          const intermediateOutput: string[] = [];

          while (continueLoop) {
            needsRetry = false;
            loopIteration++;
            // Add newline separator between responses (after tool use)
            if (!isFirstResponse) {
              send({ type: 'text', content: '\n\n' });
            }
            isFirstResponse = false;

            // Log the prompt being sent
            console.log(`\n[Chat API] === PROMPT ${loopIteration} ===`);
            for (const msg of anthropicMessages) {
              const contentPreview = typeof msg.content === 'string'
                ? msg.content.slice(0, 500)
                : JSON.stringify(msg.content).slice(0, 500);
              console.log(`[Chat API] ${msg.role}: ${contentPreview}${contentPreview.length >= 500 ? '...' : ''}`);
            }

            const response = await anthropic.messages.create({
              model: selectedModel,
              max_tokens: 16384,
              system: getSystemPrompt(isMobile, metadata),
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

            // Log first 50 lines of response
            const responseLines = fullResponseText.split('\n').slice(0, 50);
            console.log(`[Chat API] === RESPONSE ${loopIteration} (first 50 lines) ===`);
            console.log(responseLines.join('\n'));
            if (fullResponseText.split('\n').length > 50) {
              console.log(`[Chat API] ... (${fullResponseText.split('\n').length - 50} more lines)`);
            }

            // If there were tool uses, execute them in parallel
            if (hasToolUse) {
              const toolUseBlocks = assistantContentBlocks.filter(block => block.type === 'tool_use');

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

                try {
                  if (block.name === 'generate_chart') {
                    const chartSpec = block.input as Record<string, unknown>;
                    send({ type: 'chart', spec: chartSpec });
                    return {
                      type: 'tool_result' as const,
                      tool_use_id: block.id,
                      content: 'Chart generated and displayed to user.',
                    };
                  } else if (block.name === 'generate_map') {
                    const mapSpec = block.input as Record<string, unknown>;
                    send({ type: 'map', spec: mapSpec });
                    return {
                      type: 'tool_result' as const,
                      tool_use_id: block.id,
                      content: 'Map generated and displayed to user.',
                    };
                  } else {
                    // Validate database access before executing tool
                    const input = block.input as Record<string, unknown>;
                    const validation = validateToolAccess(block.name, input);
                    if (!validation.allowed) {
                      return {
                        type: 'tool_result' as const,
                        tool_use_id: block.id,
                        content: validation.message || 'Access denied',
                        is_error: true,
                      };
                    }

                    const sql = input?.sql as string | undefined;
                    const toolResult = await executeTool(mcpClient!, block.name, input);
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
                  console.error(`[Chat API] Tool execution error:`, error);
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
              // No more tool use - check for HTML content and save it
              if (containsHtml(fullResponseText)) {
                const htmlContent = extractHtmlContent(fullResponseText);
                if (htmlContent) {
                  const htmlMetadata: HtmlMetadata = {
                    question: userQuestion,
                    sqlQueries,
                    intermediateOutput,
                    model: selectedModel,
                    timestamp: new Date().toISOString(),
                  };
                  const contentId = await saveHtmlContent(htmlContent, htmlMetadata);
                  if (contentId) {
                    send({ type: 'content_saved', contentId });
                    console.log('[Chat API] Saved HTML content with ID:', contentId);
                  }
                }
              }
              continueLoop = false;
            }
          }

          send({ type: 'done' });
          controller.close();
        } catch (error) {
          console.error('[Chat API] Stream error:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error('[Chat API] Error details:', errorMessage);
          send({ type: 'error', message: `Error: ${errorMessage}` });
          controller.close();
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
