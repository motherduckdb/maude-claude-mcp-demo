# Maude - MCP Data Assistant

A conversational data analysis interface that connects to MotherDuck databases through the Model Context Protocol (MCP). Built with Next.js and deployable to Vercel.

## Features

### Model Modes

| Mode | Description | Models Used |
|------|-------------|-------------|
| **Standalone** | Single model handles data gathering and report generation | Gemini Flash, Opus, or other OpenRouter models |
| **Blended** | Two-phase approach: one model gathers data, another generates reports | Gemini Flash (data) + Claude Opus (report) |
| **Head-to-Head** | Compare responses from multiple models side-by-side | Any combination of available models |

### Data Visualization

- **HTML Reports**: Tufte-style visualizations rendered in iframes
- **Interactive Charts**: Line, bar, pie, and XmR charts via Recharts
- **Interactive Maps**: Geographic visualizations with Leaflet
- **Sparklines**: Inline mini-charts in markdown tables
- **Markdown**: Standard markdown with GitHub-flavored extensions

### Sharing

- **Shareable Reports**: HTML reports can be shared via unique URLs
- **30-day Expiration**: Shared reports expire after 30 days
- **Follow-up Questions**: Users can ask follow-up questions from shared reports
- **Context Preservation**: Follow-up questions include the original report as context

### Other Features

- **Mobile Support**: Responsive layout with mobile-optimized reports
- **Metadata Caching**: Database schema metadata for faster queries
- **Request Cancellation**: Clear chat stops backend model execution
- **Retry Logic**: Automatic retries for transient API errors

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend                              │
│  Next.js React App (ChatInterface.tsx)                      │
└─────────────────────┬───────────────────────────────────────┘
                      │ SSE Stream
┌─────────────────────▼───────────────────────────────────────┐
│                     API Route                                │
│  /api/chat/route.ts                                         │
│  - Prompt composition from markdown files                   │
│  - Model orchestration (standalone/blended)                 │
│  - Tool execution                                           │
│  - HTML content storage                                     │
└─────────────────────┬───────────────────────────────────────┘
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
┌───────────────────┐    ┌─────────────────────┐
│   OpenRouter      │    │   MCP Server        │
│   (LLM APIs)      │    │   (MotherDuck)      │
│   - Gemini        │    │   - query           │
│   - Claude        │    │   - list_tables     │
│   - Others        │    │   - list_columns    │
└───────────────────┘    └─────────────────────┘
```

## Prompt System

All prompts are stored as markdown files in the `prompts/` directory for easy maintenance.

### System Prompts

| File | Mode | Purpose |
|------|------|---------|
| `standalone-system-prompt.md` | Standalone (any model) | Full instructions for data gathering AND report generation |
| `blended-data-gathering-prompt.md` | Blended (Gemini) | Instructions for gathering data only, no HTML generation |
| `blended-report-generation-prompt.md` | Blended (Opus) | Instructions for generating HTML reports from provided data |

### Shared Components (included in system prompts)

| File | Used By | Purpose |
|------|---------|---------|
| `database-rules.md` | All modes | Database access restrictions, data validation, compliance rules |
| `narration-database.md` | Standalone, Blended Gemini | Instructions to narrate database operations for user visibility |
| `narration-report.md` | Standalone, Blended Opus | Instructions to announce report generation |
| `tufte-style-guide.md` | Standalone, Blended Opus | Edward Tufte-inspired design principles for HTML reports |
| `html-template.md` | Standalone, Blended Opus | Base HTML/CSS template for reports |

### User Message Templates

| File | When Used | Purpose |
|------|-----------|---------|
| `user-shared-report-context.md` | Follow-up from shared report | Wraps user question with original report HTML as context |
| `user-blended-opus-input.md` | Blended mode Phase 2 | Formats collected data for Opus to generate report |

### Placeholder Tokens

Prompts use `{{PLACEHOLDER}}` syntax for dynamic content:

| Token | Description |
|-------|-------------|
| `{{DATABASE_METADATA}}` | Schema metadata from `eastlake_metadata.md` |
| `{{MOBILE_LAYOUT_INSTRUCTIONS}}` | Mobile-specific layout instructions (when applicable) |
| `{{ALLOWED_DATABASES}}` | List of permitted databases |
| `{{NARRATION_DATABASE}}` | Database narration instructions |
| `{{NARRATION_REPORT}}` | Report narration instructions |
| `{{TUFTE_STYLE_GUIDE}}` | Tufte style guide content |
| `{{HTML_TEMPLATE}}` | HTML template content |
| `{{SCHEMA_EXPLORATION_STEP}}` | Dynamic instruction based on metadata availability |

## Database

### PostgreSQL (via Neon)

Stores shared HTML reports:

```sql
CREATE TABLE shares (
  id VARCHAR(255) PRIMARY KEY,
  html_content TEXT NOT NULL,
  model VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);
```

### MotherDuck (via MCP)

Analytics database accessed through the Model Context Protocol. Currently restricted to the `eastlake` database.

## Environment Variables

```bash
# OpenRouter API (for LLM access)
OPENROUTER_API_KEY=sk-or-...

# MotherDuck (for MCP database access)
MOTHERDUCK_TOKEN=...

# PostgreSQL (for shared reports storage)
PLANETSCALE_DATABASE_URL=postgresql://...
```

## Development

```bash
# Install dependencies
npm install

# Initialize database (first time only)
npm run db:init

# Start development server
npm run dev

# Build for production
npm run build
```

## Deployment

The app is configured for Vercel deployment with GitHub integration. Push to `main` to deploy.

```bash
# Manual deployment
npx vercel deploy --prod
```

## Project Structure

```
├── app/
│   ├── api/
│   │   ├── chat/route.ts      # Main chat API endpoint
│   │   └── db/route.ts        # Database operations
│   ├── components/
│   │   └── ChatInterface.tsx  # Main chat UI component
│   ├── share/[id]/route.ts    # Shared report viewer
│   ├── globals.css            # Global styles
│   ├── layout.tsx             # Root layout
│   └── page.tsx               # Home page
├── lib/
│   ├── mcp-client.ts          # MCP client for MotherDuck
│   └── planetscale.ts         # PostgreSQL client
├── prompts/                   # All prompt markdown files
├── scripts/
│   └── init-db.ts             # Database initialization
├── eastlake_metadata.md       # Database schema metadata
└── tufte_style_guide.md       # Design reference
```

## License

Private - MotherDuck
