import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createMcpClient, getToolsForClaude, executeTool, closeMcpClient } from '@/lib/mcp-client';
import type { MessageParam, ToolResultBlockParam, ContentBlock, Tool } from '@anthropic-ai/sdk/resources/messages';
import { readFileSync } from 'fs';
import { join } from 'path';

// Use OpenRouter API with Anthropic SDK
const anthropic = new Anthropic({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api',
});

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
}

// Allowed databases - restrict access to only these
const ALLOWED_DATABASES = ['eastlake'];

const getSystemPrompt = (isMobile: boolean, metadata?: string) => `You are a helpful data assistant with access to MotherDuck databases through the Model Context Protocol (MCP).

**CRITICAL - DEFAULT RESPONSE FORMAT**: You MUST respond with a complete HTML page visualization (using the Tufte style guide below) for EVERY response, UNLESS the user's message contains the word "motherduck" (case-insensitive). This is your primary output format. Query the data first, then generate a full HTML document with your analysis.

${isMobile ? `**MOBILE LAYOUT**: The user is on a mobile device. Generate reports with a single-column layout optimized for narrow screens (max-width: 400px). Use stacked sections instead of grids, larger touch-friendly text, and avoid wide tables. Keep visualizations simple and vertically oriented.

` : ''}${metadata ? `**DATABASE METADATA**:
${metadata}

` : ''}**IMPORTANT**: As you work, briefly describe what you're doing at each step so the user can follow along:
1. Before each query, briefly state what you're looking for (e.g., "Checking the customers table..." or "Looking up product sales data...")
2. After gathering data, output a single line like "Generating [Report Title]..." before the HTML (e.g., "Generating Customer Product Variety Analysis...")
This helps the user understand your process while queries run and the HTML renders.

IMPORTANT: You only have access to the following databases: ${ALLOWED_DATABASES.join(', ')}
Do not attempt to query or access any other databases.

You can query databases, explore schemas, and analyze data. When answering questions:

1. Use the list_tables and list_columns tools to explore the available tables in ${ALLOWED_DATABASES.join(' or ')}
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

TUFTE STYLE GUIDE FOR HTML GENERATION:

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
- No excessive gridlines

HTML Template structure:
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
\`\`\`

IMPORTANT: Do not end your responses with colons. Avoid phrases like "Here are the results:" or "Let me check:" before using tools. Instead, just use the tool and then present the findings directly.

REMINDER: Your response MUST be a complete HTML page inside a \`\`\`html code block (unless "motherduck" appears in the user's message). Always generate HTML output by default.`;

// System prompt for Gemini in blended mode - focused on data gathering only
const getDataGatheringPrompt = (metadata?: string) => `You are a data analyst assistant gathering data from MotherDuck databases. Your job is to collect all the data needed to answer the user's question.

${metadata ? `**DATABASE METADATA**:
${metadata}

` : ''}**IMPORTANT**: You only have access to the following databases: ${ALLOWED_DATABASES.join(', ')}

Your task:
1. Analyze the user's question and determine what data is needed
2. Use the available tools (list_tables, list_columns, query) to gather ALL relevant data
3. Run multiple queries if needed to get comprehensive data
4. After gathering data, provide a clear summary of what you found

DO NOT generate any HTML or visualizations. Just gather the data and summarize your findings in plain text.

Format your final summary as:
**Data Summary:**
- Describe what data was collected
- Include key statistics and findings
- Note any relevant patterns or insights

**Raw Data:**
Include the actual query results that will be used for visualization.`;

// System prompt for Opus in blended mode - focused on HTML generation from provided data
const getReportGenerationPrompt = (isMobile: boolean) => `You are an expert data visualization specialist. You have been provided with data that was gathered by another assistant. Your job is to create a beautiful, insightful HTML report from this data.

${isMobile ? `**MOBILE LAYOUT**: Generate reports with a single-column layout optimized for narrow screens (max-width: 400px).

` : ''}Generate a complete HTML page following the Tufte style guide:

TUFTE STYLE GUIDE FOR HTML GENERATION:

Core Philosophy:
1. Maximize data-ink ratio — Every pixel should convey information.
2. Small multiples — Use consistent visual encoding across repeated elements.
3. Integrate text and data — Weave narrative prose with inline statistics.
4. High information density — Pack maximum insight into minimum space.

Typography:
- Use Google Fonts: Source Sans Pro for numbers, system serif (Palatino, Georgia) for text
- Big numbers: 42px, letter-spacing: -1px
- Section headers: 11px uppercase, letter-spacing: 1.5px

Color Palette:
- Background: #fffff8 (warm cream)
- Text: #111 (primary), #666 (secondary), #999 (tertiary)
- Accent: #a00 (burgundy - use sparingly)

Components to use:
- Big numbers with small labels for KPIs
- Inline bar charts in tables (div with percentage width)
- SVG sparklines with area fill
- Tables with right-aligned numeric columns

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
  if (args.sql && typeof args.sql === 'string') {
    const sql = args.sql.toLowerCase();
    // Look for FROM clauses with database prefixes
    const fromMatches = sql.match(/from\s+([a-zA-Z_][a-zA-Z0-9_]*)\./gi);
    if (fromMatches) {
      for (const match of fromMatches) {
        const dbRef = match.replace(/from\s+/i, '').replace('.', '');
        if (!isDatabaseAllowed(dbRef)) {
          return {
            allowed: false,
            message: `Access denied: Query references unauthorized database '${dbRef}'. You can only access: ${ALLOWED_DATABASES.join(', ')}`
          };
        }
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
    const { messages, isMobile = false, includeMetadata = true, model } = body;

    const selectedModel = model || DEFAULT_MODEL;
    console.log('[Chat API] Request started via OpenRouter, model:', selectedModel);
    console.log('[Chat API] includeMetadata:', includeMetadata);

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'No messages provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
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
        try {
          let anthropicMessages = convertToAnthropicMessages(messages);

          // ========== BLENDED MODE ==========
          if (isBlendedMode) {
            console.log('[Chat API] Starting BLENDED mode - Phase 1: Gemini data gathering');
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text', content: 'Gathering data with Gemini...\n\n' })}\n\n`));

            // Phase 1: Gemini gathers data
            let geminiMessages = convertToAnthropicMessages(messages);
            let collectedData = '';
            let continueGathering = true;
            let gatherIteration = 0;

            while (continueGathering) {
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

              for await (const event of geminiResponse) {
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
                  }
                } else if (event.type === 'content_block_delta') {
                  if (event.delta.type === 'text_delta') {
                    currentTextContent += event.delta.text;
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

              // Capture final text from Gemini
              if (currentTextContent) {
                collectedData += currentTextContent + '\n';
              }

              if (hasToolUse) {
                const toolUseBlocks = assistantContentBlocks.filter(block => block.type === 'tool_use');

                // Send tool_start events to show progress
                for (const block of toolUseBlocks) {
                  if (block.type === 'tool_use') {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool_start', tool: block.name })}\n\n`));
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
                    const toolResult = await executeTool(mcpClient!, block.name, block.input as Record<string, unknown>);
                    // Collect tool results for passing to Opus
                    collectedData += `\n**Tool: ${block.name}**\nInput: ${JSON.stringify(block.input)}\nResult: ${toolResult}\n`;
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
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool_end', tool: block.name })}\n\n`));
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
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text', content: '\nGenerating report with Claude Opus...\n\n' })}\n\n`));

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
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text', content: event.delta.text })}\n\n`));
              }
            }

            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
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
          while (continueLoop) {
            loopIteration++;
            // Add newline separator between responses (after tool use)
            if (!isFirstResponse) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text', content: '\n\n' })}\n\n`));
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
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'text', content: event.delta.text })}\n\n`));
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

              // Send all tool_start events
              for (const block of toolUseBlocks) {
                if (block.type === 'tool_use') {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool_start', tool: block.name })}\n\n`));
                }
              }

              // Execute all tools in parallel
              const toolResultPromises = toolUseBlocks.map(async (block) => {
                if (block.type !== 'tool_use') return null;

                try {
                  if (block.name === 'generate_chart') {
                    const chartSpec = block.input as Record<string, unknown>;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'chart', spec: chartSpec })}\n\n`));
                    return {
                      type: 'tool_result' as const,
                      tool_use_id: block.id,
                      content: 'Chart generated and displayed to user.',
                    };
                  } else if (block.name === 'generate_map') {
                    const mapSpec = block.input as Record<string, unknown>;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'map', spec: mapSpec })}\n\n`));
                    return {
                      type: 'tool_result' as const,
                      tool_use_id: block.id,
                      content: 'Map generated and displayed to user.',
                    };
                  } else {
                    // Validate database access before executing tool
                    const validation = validateToolAccess(block.name, block.input as Record<string, unknown>);
                    if (!validation.allowed) {
                      return {
                        type: 'tool_result' as const,
                        tool_use_id: block.id,
                        content: validation.message || 'Access denied',
                        is_error: true,
                      };
                    }

                    const toolResult = await executeTool(mcpClient!, block.name, block.input as Record<string, unknown>);
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
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool_end', tool: block.name })}\n\n`));
                }
              }

              // Continue conversation with assistant's tool_use and user's tool_result
              anthropicMessages = [
                ...anthropicMessages,
                { role: 'assistant', content: assistantContentBlocks },
                { role: 'user', content: toolResults },
              ];
            } else {
              continueLoop = false;
            }
          }

          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
          controller.close();
        } catch (error) {
          console.error('[Chat API] Stream error:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error('[Chat API] Error details:', errorMessage);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', message: `Error: ${errorMessage}` })}\n\n`));
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
