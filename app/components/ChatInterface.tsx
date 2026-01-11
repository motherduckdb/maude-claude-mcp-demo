'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Sparkline, { parseSparklineData } from './Sparkline';
import ChatChart, { ChartSpec } from './ChatChart';
import HtmlFrame, { StreamingHtmlFrame, isHtmlContent, extractHtmlParts } from './HtmlFrame';

// Debug flag for HTML detection logging
const DEBUG_HTML_DETECTION = false;
const DEBUG_TOOL_TEXT = false;

// Detect if streaming text contains the start of HTML content with actual renderable content
function detectHtmlStart(text: string): { hasHtml: boolean; htmlStart: number; beforeText: string } {
  const lowerText = text.toLowerCase();

  // Check for ```html code block with actual content after it
  const htmlCodeBlockStart = text.indexOf('```html');
  if (htmlCodeBlockStart !== -1) {
    // Find where the actual HTML content starts (after ```html and newline)
    const contentStart = text.indexOf('\n', htmlCodeBlockStart);
    if (contentStart !== -1) {
      const afterMarker = text.slice(contentStart + 1);
      // Wait until we have at least <!DOCTYPE or <html tag
      if (afterMarker.toLowerCase().includes('<!doctype') || afterMarker.toLowerCase().includes('<html')) {
        return {
          hasHtml: true,
          htmlStart: htmlCodeBlockStart,
          beforeText: text.slice(0, htmlCodeBlockStart).trim()
        };
      }
    }
    // Not enough content yet
    return { hasHtml: false, htmlStart: -1, beforeText: '' };
  }

  // Check for raw <!DOCTYPE html start
  const doctypeStart = lowerText.indexOf('<!doctype html');
  if (doctypeStart !== -1) {
    return {
      hasHtml: true,
      htmlStart: doctypeStart,
      beforeText: text.slice(0, doctypeStart).trim()
    };
  }

  // Check for raw <html start
  const htmlTagStart = lowerText.indexOf('<html');
  if (htmlTagStart !== -1) {
    return {
      hasHtml: true,
      htmlStart: htmlTagStart,
      beforeText: text.slice(0, htmlTagStart).trim()
    };
  }

  return { hasHtml: false, htmlStart: -1, beforeText: '' };
}

// Helper to remove HTML code blocks from text for display during streaming
function filterHtmlFromText(text: string): string {
  // Remove ```html ... ``` blocks
  let filtered = text.replace(/```html\s*[\s\S]*?```/g, '');
  // Remove plain ``` blocks that contain HTML
  filtered = filtered.replace(/```\s*<!doctype[\s\S]*?```/gi, '');
  filtered = filtered.replace(/```\s*<html[\s\S]*?```/gi, '');
  // Remove incomplete HTML code blocks (still streaming)
  filtered = filtered.replace(/```html\s*[\s\S]*$/g, '');
  filtered = filtered.replace(/```\s*<!doctype[\s\S]*$/gi, '');
  filtered = filtered.replace(/```\s*<html[\s\S]*$/gi, '');
  // Remove raw HTML documents (complete)
  filtered = filtered.replace(/<!DOCTYPE html[\s\S]*<\/html>/gi, '');
  filtered = filtered.replace(/<html[\s\S]*<\/html>/gi, '');
  // Remove incomplete raw HTML (still streaming)
  filtered = filtered.replace(/<!DOCTYPE html[\s\S]*$/gi, '');
  filtered = filtered.replace(/<html[\s\S]*$/gi, '');
  return filtered.trim();
}
import dynamic from 'next/dynamic';
import type { MapSpec } from './ChatMap';

// Dynamically import ChatMap to avoid SSR issues with Leaflet
const ChatMap = dynamic(() => import('./ChatMap'), { ssr: false });

// Database tools that should be grouped together
const DATABASE_TOOLS = ['query', 'list_tables', 'list_columns', 'search_catalog', 'list_databases'];

// Component that maintains its maximum width
function MaxWidthContainer({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const maxWidthRef = useRef<number>(0);

  useEffect(() => {
    if (ref.current) {
      const currentWidth = ref.current.scrollWidth;
      if (currentWidth > maxWidthRef.current) {
        maxWidthRef.current = currentWidth;
      }
      ref.current.style.minWidth = `${maxWidthRef.current}px`;
    }
  });

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}


// Content segment type for interspersed text and SQL
type ContentSegment = { type: 'text'; content: string } | { type: 'sql'; content: string };

// Parse content into ordered segments of text and SQL
function parseContentSegments(text: string): ContentSegment[] {
  const segments: ContentSegment[] = [];

  // Split by SQL code blocks, keeping the delimiters
  // This regex captures: ```sql...``` blocks
  const parts = text.split(/(```sql[\s\S]*?```|```(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|--)[^`]*```)/gi);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Check if this part is a SQL block
    const sqlMatch = trimmed.match(/^```sql\s*([\s\S]*?)```$/i) ||
                     trimmed.match(/^```((?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|--)[^`]*)```$/i);

    if (sqlMatch) {
      const sql = sqlMatch[1].trim();
      if (sql) {
        segments.push({ type: 'sql', content: sql });
      }
    } else {
      // It's text content - clean up extra newlines
      const textContent = trimmed.replace(/\n{3,}/g, '\n\n').trim();
      if (textContent) {
        segments.push({ type: 'text', content: textContent });
      }
    }
  }

  // Debug logging
  if (segments.length > 0) {
    console.log('[parseContentSegments] Input length:', text.length, 'Segments:', segments.map(s => `${s.type}(${s.content.length})`).join(', '));
  }

  return segments;
}

// Helper to extract SQL statements from text (kept for backward compatibility)
function extractSqlStatements(text: string): { textWithoutSql: string; sqlStatements: string[] } {
  const segments = parseContentSegments(text);
  const sqlStatements = segments.filter(s => s.type === 'sql').map(s => s.content);
  const textWithoutSql = segments.filter(s => s.type === 'text').map(s => s.content).join('\n\n');
  return { textWithoutSql, sqlStatements };
}

// Filter SQL from text for display
function filterSqlFromText(text: string): string {
  const { textWithoutSql } = extractSqlStatements(text);

  // Clean up excessive blank lines (more than 2 consecutive newlines -> 2)
  let cleaned = textWithoutSql.replace(/\n{3,}/g, '\n\n');
  // Remove leading/trailing whitespace
  cleaned = cleaned.trim();

  return cleaned;
}


// Individual SQL statement collapsible component
function SqlStatementSection({ sql, keyPrefix, defaultExpanded = false, expansionState, onToggleExpansion }: {
  sql: string;
  keyPrefix: string;
  defaultExpanded?: boolean;
  expansionState?: Record<string, boolean>;
  onToggleExpansion?: (key: string) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);

  // Use external state if provided, otherwise fall back to local state
  const expansionKey = `sql-${keyPrefix}`;
  const isExpanded = expansionState ? (expansionState[expansionKey] ?? defaultExpanded) : localExpanded;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onToggleExpansion) {
      onToggleExpansion(expansionKey);
    } else {
      setLocalExpanded(!localExpanded);
    }
  };

  return (
    <div className="sql-statement-section">
      <button
        className="sql-toggle"
        onClick={handleToggle}
      >
        <span className="sql-toggle-icon">{isExpanded ? '▼' : '▶'}</span>
        <span className="sql-toggle-label">SQL statement executed</span>
      </button>
      {isExpanded && (
        <pre key={keyPrefix} className="sql-code">{sql}</pre>
      )}
    </div>
  );
}

// Intermediate output section (for blended mode)
function IntermediateOutputSection({ source, content, expansionKey, expansionState, onToggleExpansion }: {
  source: string;
  content: string;
  expansionKey?: string;
  expansionState?: Record<string, boolean>;
  onToggleExpansion?: (key: string) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);

  const getLabel = (src: string) => {
    if (src === 'gemini') return 'Intermediate Output from Gemini';
    return `Intermediate Output from ${src}`;
  };

  // Use external state if provided, otherwise fall back to local state
  const stateKey = expansionKey || `intermediate-${source}`;
  const isExpanded = expansionState ? (expansionState[stateKey] ?? false) : localExpanded;

  const handleToggle = () => {
    if (onToggleExpansion) {
      onToggleExpansion(stateKey);
    } else {
      setLocalExpanded(!localExpanded);
    }
  };

  return (
    <div className="intermediate-output-section">
      <button
        className="intermediate-output-toggle"
        onClick={handleToggle}
      >
        <span className="intermediate-output-icon">{isExpanded ? '▼' : '▶'}</span>
        <span className="intermediate-output-label">{getLabel(source)}</span>
      </button>
      {isExpanded && (
        <div className="intermediate-output-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

// Collapsible tool use section component
function ToolUseSection({ toolName, toolText, isActive, isStreaming, keyPrefix, expansionState, onToggleExpansion }: {
  toolName: string;
  toolText: string;
  isActive?: boolean;
  isStreaming?: boolean;
  keyPrefix?: string;
  expansionState?: Record<string, boolean>;
  onToggleExpansion?: (key: string) => void;
}) {
  const [localManuallyExpanded, setLocalManuallyExpanded] = useState<boolean | null>(null);
  const wasActive = useRef(isActive);
  const wasStreaming = useRef(isStreaming);

  // Parse content into ordered segments (text and SQL interspersed)
  const segments = parseContentSegments(toolText);

  const expansionKey = `tool-${keyPrefix || toolName}`;

  // Auto-collapse when transitioning from active to inactive, but only if not streaming
  useEffect(() => {
    if (wasActive.current && !isActive && !isStreaming) {
      if (onToggleExpansion && expansionState?.[expansionKey]) {
        onToggleExpansion(expansionKey); // Collapse via external state
      } else {
        setLocalManuallyExpanded(false);
      }
    }
    // Also collapse when streaming ends
    if (wasStreaming.current && !isStreaming && !isActive) {
      if (onToggleExpansion && expansionState?.[expansionKey]) {
        onToggleExpansion(expansionKey); // Collapse via external state
      } else {
        setLocalManuallyExpanded(false);
      }
    }
    wasActive.current = isActive;
    wasStreaming.current = isStreaming;
  }, [isActive, isStreaming, onToggleExpansion, expansionState, expansionKey]);

  const getToolDisplayName = (name: string) => {
    if (name === 'database_ops' || name === 'chain_of_thought') return 'Chain-of-thought';
    const toolNames: Record<string, string> = {
      'query': 'Chain-of-thought',
      'list_tables': 'Chain-of-thought',
      'list_columns': 'Chain-of-thought',
      'search_catalog': 'Chain-of-thought',
    };
    return toolNames[name] || `Used ${name}`;
  };

  // Check if there's any content to show when expanded
  const hasContent = segments.length > 0;

  // Determine manual expansion state from external or local source
  const isManuallyExpanded = expansionState ? (expansionState[expansionKey] ?? null) : localManuallyExpanded;

  // Show expanded if active, streaming, or manually expanded (manual toggle overrides)
  // Only auto-expand if there's content to show
  const showExpanded = hasContent && (isManuallyExpanded !== null ? isManuallyExpanded : (isActive || isStreaming));

  const handleToggle = () => {
    if (!hasContent) return;
    if (onToggleExpansion) {
      onToggleExpansion(expansionKey);
    } else {
      setLocalManuallyExpanded(!showExpanded);
    }
  };

  return (
    <div className={`tool-use-section ${isActive ? 'tool-use-active' : ''}`}>
      <button
        className="tool-use-toggle"
        onClick={handleToggle}
        style={{ cursor: hasContent ? 'pointer' : 'default' }}
      >
        <span className="tool-use-icon">{hasContent ? (showExpanded ? '▼' : '▶') : '•'}</span>
        <span className="tool-use-label">{getToolDisplayName(toolName)}</span>
        {isActive && <span className="tool-use-spinner" />}
      </button>
      {showExpanded && (
        <div className="tool-use-content">
          {segments.map((segment, idx) => (
            segment.type === 'text' ? (
              <div key={`${keyPrefix || 'seg'}-text-${idx}`} className="tool-use-text">{segment.content}</div>
            ) : (
              <SqlStatementSection
                key={`${keyPrefix || 'seg'}-sql-${idx}`}
                sql={segment.content}
                keyPrefix={`${keyPrefix || 'seg'}-sql-${idx}`}
                expansionState={expansionState}
                onToggleExpansion={onToggleExpansion}
              />
            )
          ))}
        </div>
      )}
    </div>
  );
}

// Helper to extract text content from React children recursively
function extractTextContent(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (!children) return '';
  if (Array.isArray(children)) {
    return children.map(extractTextContent).join('');
  }
  if (typeof children === 'object' && 'props' in children) {
    return extractTextContent((children as React.ReactElement).props.children);
  }
  return '';
}

// Custom markdown components for rendering sparklines in table cells
const markdownComponents: Components = {
  td: ({ children, ...props }) => {
    // Extract all text content from the cell
    const text = extractTextContent(children).trim();

    // Check if it's a complete sparkline syntax
    const sparklineData = parseSparklineData(text);
    if (sparklineData) {
      return (
        <td {...props}>
          <Sparkline data={sparklineData} />
        </td>
      );
    }

    // Hide incomplete sparkline syntax during streaming (starts with sparkline but not complete)
    if (text.match(/^sparkline\([^)]*$/)) {
      return (
        <td {...props}>
          <span className="sparkline-loading" />
        </td>
      );
    }

    return <td {...props}>{children}</td>;
  },
};

interface MessageContent {
  type: 'text' | 'chart' | 'tool_use' | 'map' | 'html' | 'streaming_html' | 'intermediate_output' | 'shared_report';
  text?: string;
  chart?: ChartSpec;
  map?: MapSpec;
  html?: string;
  htmlChunks?: string;  // For streaming HTML
  isComplete?: boolean; // For streaming HTML completion state
  contentId?: string;   // Server-side content ID for sharing
  toolName?: string;
  toolText?: string;
  isActive?: boolean;
  intermediateSource?: string;  // For intermediate output (e.g., 'gemini')
  intermediateContent?: string; // For intermediate output content
  shareId?: string;     // For shared report reference
}

interface Message {
  role: 'user' | 'assistant';
  content: string | MessageContent[];
}

// Helper to filter visualization content (charts, maps, intermediate output)
const getVisualizations = (content: MessageContent[]): MessageContent[] =>
  content.filter(c => c.type === 'chart' || c.type === 'map' || c.type === 'intermediate_output');

// Helper to filter visualization content plus HTML
const getVisualizationsAndHtml = (content: MessageContent[]): MessageContent[] =>
  content.filter(c =>
    c.type === 'chart' || c.type === 'map' || c.type === 'intermediate_output' ||
    c.type === 'html' || c.type === 'streaming_html'
  );

const EXAMPLE_PROMPTS = [
  'What products do we sell, and how have they performed?',
  'Which customers buy the largest variety of products?',
  'Analyze sales by region and show a map with details.',
];

const MODEL_OPTIONS = [
  { id: 'gemini', name: 'Gemini 3 Flash', model: 'google/gemini-3-flash-preview', appName: 'Mash', subtitle: 'Gemini-like' },
  { id: 'opus', name: 'Claude Opus 4.5', model: 'anthropic/claude-opus-4.5', appName: 'Maude', subtitle: 'Claude-like' },
  { id: 'blended', name: 'Blended (Gemini + Opus)', model: 'blended', appName: 'Quacker', subtitle: 'Best of both' },
  { id: 'head-to-head', name: 'Head-to-Head', model: 'head-to-head', appName: 'Quacker', subtitle: 'Compare all models' },
];

// Models to run in head-to-head mode
const HEAD_TO_HEAD_MODELS = [
  { id: 'gemini', name: 'Gemini', model: 'google/gemini-3-flash-preview' },
  { id: 'opus', name: 'Claude Opus', model: 'anthropic/claude-opus-4.5' },
  { id: 'blended', name: 'Blended', model: 'blended' },
];

// Helper to convert messages to API format (pure function, outside component)
const messagesToApiFormat = (msgs: Message[]) => {
  return msgs.map(msg => ({
    role: msg.role,
    content: typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .map(c => {
            // Extract text from text blocks
            if (c.type === 'text' && c.text) return c.text;
            // Extract text from chain_of_thought blocks (contains the actual response)
            if (c.type === 'tool_use' && c.toolName === 'chain_of_thought' && c.toolText) {
              return c.toolText;
            }
            // Extract HTML content (contains reports/visualizations with data)
            if (c.type === 'html' && c.html) return c.html;
            if (c.type === 'streaming_html' && c.htmlChunks) return c.htmlChunks;
            return '';
          })
          .filter(Boolean)
          .join('\n\n') || '[visualization response]',
  })).filter(msg => msg.content);
};

export default function ChatInterface() {
  const searchParams = useSearchParams();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isToolRunning, setIsToolRunning] = useState<string | null>(null);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [selectedModel, setSelectedModel] = useState(MODEL_OPTIONS[0].id);
  const [sharedReportId, setSharedReportId] = useState<string | null>(null);
  const hasProcessedUrlParams = useRef(false);

  // Head-to-head mode state - tracks full conversation per model
  const [headToHeadMessages, setHeadToHeadMessages] = useState<Record<string, Message[]>>({});
  const [headToHeadLoading, setHeadToHeadLoading] = useState<Record<string, boolean>>({});
  const [headToHeadToolRunning, setHeadToHeadToolRunning] = useState<Record<string, string | null>>({});
  const [activeTab, setActiveTab] = useState(HEAD_TO_HEAD_MODELS[0].id);
  const headToHeadAbortControllers = useRef<Record<string, AbortController>>({});

  // Message queue for submitting while a response is in progress (supports multiple queued messages)
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  // Ref to access queue synchronously (kept in sync via useEffect)
  const messageQueueRef = useRef<string[]>([]);
  // Flag to prevent processing multiple queue items simultaneously (standard mode)
  const isProcessingQueueRef = useRef(false);
  // Per-model queue processing for head-to-head mode
  const headToHeadQueueIndexRef = useRef<Record<string, number>>({});
  // Per-model processing flags to prevent double processing
  const headToHeadProcessingRef = useRef<Record<string, boolean>>({});
  // Ref to track latest headToHeadMessages for queue processing
  const headToHeadMessagesRef = useRef<Record<string, Message[]>>({});
  headToHeadMessagesRef.current = headToHeadMessages;

  const currentModelConfig = MODEL_OPTIONS.find(m => m.id === selectedModel) || MODEL_OPTIONS[0];
  const isHeadToHead = selectedModel === 'head-to-head';
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const tabScrollPositions = useRef<Record<string, number>>({});
  const expansionStates = useRef<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Ref to track latest messages (avoids stale closure issues with queued messages)
  const messagesRef = useRef<Message[]>(messages);
  messagesRef.current = messages;

  const storageKey = 'mcp_chat_history';
  const [isHydrated, setIsHydrated] = useState(false);

  // Load all state from localStorage on mount (client-side only to avoid hydration mismatch)
  useEffect(() => {
    // Load standard mode messages
    const savedMessages = localStorage.getItem(storageKey);
    if (savedMessages) {
      try {
        const parsed = JSON.parse(savedMessages);
        if (Array.isArray(parsed)) {
          setMessages(parsed);
        }
      } catch (e) {
        console.error('Failed to parse saved chat history:', e);
      }
    }

    // Load selected model
    const savedModel = localStorage.getItem('mcp_selected_model');
    if (savedModel && MODEL_OPTIONS.some(m => m.id === savedModel)) {
      setSelectedModel(savedModel);
    }

    // Load head-to-head messages
    const savedH2H = localStorage.getItem('mcp_head_to_head_history');
    if (savedH2H) {
      try {
        const parsed = JSON.parse(savedH2H);
        if (typeof parsed === 'object' && parsed !== null) {
          setHeadToHeadMessages(parsed);
        }
      } catch (e) {
        console.error('Failed to parse saved head-to-head history:', e);
      }
    }

    // Load active tab
    const savedTab = localStorage.getItem('mcp_active_tab');
    if (savedTab && HEAD_TO_HEAD_MODELS.some(m => m.id === savedTab)) {
      setActiveTab(savedTab);
    }

    // Load metadata preference
    const savedMetadata = localStorage.getItem('mcp_include_metadata');
    if (savedMetadata !== null) {
      setIncludeMetadata(savedMetadata === 'true');
    }

    // Mark as hydrated to show UI
    setIsHydrated(true);
  }, []);

  // Handle URL params from shared report links
  useEffect(() => {
    if (hasProcessedUrlParams.current) return;

    const question = searchParams.get('q');
    const shareId = searchParams.get('shareId');
    const modelParam = searchParams.get('model');

    if (shareId) {
      hasProcessedUrlParams.current = true;

      // Set question in input if provided
      if (question) {
        setInputValue(question);
      }

      // Store share ID (will be sent to API to fetch full context)
      setSharedReportId(shareId);

      // Set model based on URL param - map from model string to id
      if (modelParam) {
        const modelOption = MODEL_OPTIONS.find(m => m.model === modelParam);
        if (modelOption) {
          setSelectedModel(modelOption.id);
          localStorage.setItem('selectedModel', modelOption.id);
        }
      }

      // Add the shared report as an initial message to show in chat
      setMessages([{
        role: 'assistant',
        content: [{ type: 'shared_report', shareId }]
      }]);

      // Clear URL params without triggering navigation
      window.history.replaceState({}, '', window.location.pathname);

      // Focus the input
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [searchParams]);

  // Save messages to localStorage when they change (skip if empty to preserve loaded state)
  const prevMessagesRef = useRef<string>('');
  useEffect(() => {
    // Only save if we have messages and content has changed
    if (messages.length > 0) {
      const serialized = JSON.stringify(messages);
      if (serialized !== prevMessagesRef.current) {
        localStorage.setItem(storageKey, serialized);
        prevMessagesRef.current = serialized;
      }
    }
  }, [messages]);

  // Save head-to-head messages to localStorage when they change
  const prevH2HRef = useRef<string>('');
  useEffect(() => {
    const hasMessages = Object.values(headToHeadMessages).some(msgs => msgs.length > 0);
    const serialized = JSON.stringify(headToHeadMessages);
    // Only save if changed and has content
    if (hasMessages && serialized !== prevH2HRef.current) {
      localStorage.setItem('mcp_head_to_head_history', serialized);
    }
    prevH2HRef.current = serialized;
  }, [headToHeadMessages]);

  // Helper to save user preferences (called from onChange handlers)
  const saveSelectedModel = useCallback((model: string) => {
    setSelectedModel(model);
    localStorage.setItem('mcp_selected_model', model);
  }, []);

  // Track when we're switching tabs to prevent auto-scroll interference
  const isRestoringScroll = useRef(false);

  const saveActiveTab = useCallback((tab: string) => {
    // Save current scroll position before switching
    const container = messagesContainerRef.current;
    if (container) {
      tabScrollPositions.current[activeTab] = container.scrollTop;
    }

    // Mark that we're restoring scroll to prevent auto-scroll interference
    isRestoringScroll.current = true;

    // Restore scroll position immediately (before React re-renders)
    // This minimizes flicker by setting scroll before display changes
    if (container && tabScrollPositions.current[tab] !== undefined) {
      container.scrollTop = tabScrollPositions.current[tab];
    }

    setActiveTab(tab);
    localStorage.setItem('mcp_active_tab', tab);

    // Allow auto-scroll again after a brief delay
    setTimeout(() => {
      isRestoringScroll.current = false;
    }, 50);
  }, [activeTab]);

  const saveIncludeMetadata = useCallback((include: boolean) => {
    setIncludeMetadata(include);
    localStorage.setItem('mcp_include_metadata', String(include));
  }, []);

  // Force re-render counter for expansion state changes
  const [, forceExpansionUpdate] = useState(0);

  // Toggle expansion state for collapsible sections (persists across tab switches)
  const toggleExpansion = useCallback((key: string) => {
    expansionStates.current[key] = !expansionStates.current[key];
    forceExpansionUpdate(n => n + 1);
  }, []);

  // Auto-scroll during streaming, but only if already at/near bottom
  // This way if user scrolls up, they stay scrolled up
  const lastScrollHeight = useRef(0);
  useEffect(() => {
    // Skip auto-scroll when restoring scroll position after tab switch
    if (isRestoringScroll.current) return;

    const container = messagesContainerRef.current;
    if (!container) return;

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const wasAtBottom = distanceFromBottom < 150;
    const contentGrew = container.scrollHeight > lastScrollHeight.current;

    // Only auto-scroll if we were already at/near bottom
    if (wasAtBottom && contentGrew) {
      container.scrollTop = container.scrollHeight;
    }

    lastScrollHeight.current = container.scrollHeight;
  }, [messages, headToHeadMessages]);

  // Always scroll to bottom when user sends a NEW message
  const prevMessageCount = useRef(0);
  useEffect(() => {
    const currentCount = messages.length + Object.values(headToHeadMessages).reduce((sum, msgs) => sum + msgs.length, 0);
    if (currentCount > prevMessageCount.current) {
      const container = messagesContainerRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    }
    prevMessageCount.current = currentCount;
  }, [messages, headToHeadMessages]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Helper function to run a single model stream (used in head-to-head mode)
  const runModelStream = useCallback(async (
    modelId: string,
    modelName: string,
    apiMessages: { role: string; content: string }[],
    isMobile: boolean,
    abortSignal: AbortSignal,
    onUpdate: (content: MessageContent[]) => void,
    onToolStart: (tool: string) => void,
    onToolEnd: () => void,
    onDone: () => void,
    onError: (error: string) => void,
    shareId?: string | null,
  ) => {
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          isMobile,
          includeMetadata,
          model: modelName,
          ...(shareId && { shareId }),
        }),
        signal: abortSignal,
      });

      if (!response.ok) throw new Error('Failed to send message');

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let currentContent: MessageContent[] = [];
      let currentText = '';
      let pendingToolName = '';
      let pendingSql = ''; // SQL waiting to be committed after explanatory text
      let isStreamingHtml = false;
      let htmlStreamStart = -1;
      let beforeHtmlText = '';
      let hadToolUses = false; // Track if there were actual database tool uses
      let savedContentId = ''; // Server-side content ID for sharing HTML

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === 'text') {
                // If we had a pending tool, clear it now that text is arriving
                if (pendingToolName && data.content.trim()) {
                  pendingToolName = '';
                }
                currentText += data.content;

                if (!isStreamingHtml) {
                  const htmlDetection = detectHtmlStart(currentText);
                  if (htmlDetection.hasHtml) {
                    isStreamingHtml = true;
                    htmlStreamStart = htmlDetection.htmlStart;
                    beforeHtmlText = htmlDetection.beforeText;
                  }
                }

                // Get non-text content (charts, maps, html, intermediate_output)
                const otherContent = getVisualizationsAndHtml(currentContent);

                // Find or create chain_of_thought block
                const cotIndex = currentContent.findIndex(c => c.type === 'tool_use' && c.toolName === 'chain_of_thought');
                let cotBlock = cotIndex >= 0 ? currentContent[cotIndex] : null;

                if (isStreamingHtml) {
                  const htmlChunks = currentText.slice(htmlStreamStart);
                  const contentBlocks: MessageContent[] = [...otherContent];
                  // Show beforeHtmlText in chain_of_thought block during streaming
                  if (beforeHtmlText || (cotBlock?.toolText)) {
                    const displayCotText = (cotBlock?.toolText || '') + beforeHtmlText;
                    contentBlocks.unshift({
                      type: 'tool_use',
                      toolName: 'chain_of_thought',
                      toolText: displayCotText,
                      isActive: true
                    });
                  }
                  contentBlocks.push({ type: 'streaming_html', htmlChunks, isComplete: false });
                  onUpdate(contentBlocks);
                } else {
                  // Display chain_of_thought block with committed content + current streaming text
                  const committedText = cotBlock?.toolText || '';
                  const displayCot: MessageContent = {
                    type: 'tool_use',
                    toolName: 'chain_of_thought',
                    toolText: committedText + currentText,
                    isActive: true
                  };
                  // Ensure cotBlock exists in currentContent for tracking
                  if (cotIndex < 0 && currentText.trim()) {
                    // Create cotBlock in currentContent (toolText stays empty - currentText is uncommitted)
                    currentContent = [...currentContent, {
                      type: 'tool_use',
                      toolName: 'chain_of_thought',
                      toolText: '',
                      isActive: true
                    }];
                  } else if (cotIndex >= 0) {
                    currentContent = [
                      ...currentContent.slice(0, cotIndex),
                      { ...currentContent[cotIndex], isActive: true },
                      ...currentContent.slice(cotIndex + 1),
                    ];
                  }
                  onUpdate([displayCot, ...otherContent]);
                }
              } else if (data.type === 'done') {
                console.log(`[${modelId}] done - currentContent:`, currentContent.map(c => c.type), 'currentText length:', currentText.length);
                currentContent = currentContent.map(c =>
                  c.type === 'tool_use' && c.isActive ? { ...c, isActive: false } : c
                );
                if (isStreamingHtml) {
                  const htmlChunks = currentText.slice(htmlStreamStart);
                  const otherContent = getVisualizations(currentContent);
                  const cotBlock = currentContent.find(c => c.type === 'tool_use' && c.toolName === 'chain_of_thought');
                  const contentBlocks: MessageContent[] = [];
                  // Include beforeHtmlText in chain_of_thought block (not as separate text)
                  if (beforeHtmlText || (cotBlock?.toolText)) {
                    const finalCotText = (cotBlock?.toolText || '') + beforeHtmlText;
                    contentBlocks.push({
                      type: 'tool_use',
                      toolName: 'chain_of_thought',
                      toolText: finalCotText,
                      isActive: false
                    });
                  }
                  contentBlocks.push(...otherContent);
                  contentBlocks.push({ type: 'streaming_html', htmlChunks, isComplete: true, contentId: savedContentId || undefined });
                  onUpdate(contentBlocks);
                } else if (currentText) {
                  if (isHtmlContent(currentText)) {
                    const parts = extractHtmlParts(currentText);
                    if (parts) {
                      const finalBlocks: MessageContent[] = [];
                      const cotBlock = currentContent.find(c => c.type === 'tool_use' && c.toolName === 'chain_of_thought');
                      // Include beforeText in chain_of_thought block
                      if (parts.beforeText || (cotBlock?.toolText)) {
                        const finalCotText = (cotBlock?.toolText || '') + parts.beforeText;
                        finalBlocks.push({
                          type: 'tool_use',
                          toolName: 'chain_of_thought',
                          toolText: finalCotText,
                          isActive: false
                        });
                      }
                      finalBlocks.push(...getVisualizations(currentContent));
                      finalBlocks.push({ type: 'html', html: parts.html, contentId: savedContentId || undefined });
                      if (parts.afterText) finalBlocks.push({ type: 'text', text: parts.afterText });
                      onUpdate(finalBlocks);
                    } else {
                      const cotBlock = currentContent.find(c => c.type === 'tool_use' && c.toolName === 'chain_of_thought');
                      const finalBlocks: MessageContent[] = [];
                      const finalText = (cotBlock?.toolText || '') + currentText;
                      // If no tool uses, render as inline text; otherwise use chain_of_thought
                      if (hadToolUses) {
                        finalBlocks.push({ type: 'tool_use', toolName: 'chain_of_thought', toolText: finalText, isActive: false });
                      } else if (finalText.trim()) {
                        finalBlocks.push({ type: 'text', text: finalText });
                      }
                      finalBlocks.push(...getVisualizations(currentContent));
                      onUpdate(finalBlocks);
                    }
                  } else {
                    // Final content: if no tool uses, render as inline text
                    const cotBlock = currentContent.find(c => c.type === 'tool_use' && c.toolName === 'chain_of_thought');
                    const finalBlocks: MessageContent[] = [];
                    const finalText = (cotBlock?.toolText || '') + currentText;
                    if (hadToolUses) {
                      finalBlocks.push({ type: 'tool_use', toolName: 'chain_of_thought', toolText: finalText, isActive: false });
                    } else if (finalText.trim()) {
                      finalBlocks.push({ type: 'text', text: finalText });
                    }
                    finalBlocks.push(...getVisualizations(currentContent));
                    console.log(`[${modelId}] finalBlocks:`, finalBlocks.map(b => ({ type: b.type, toolName: (b as any).toolName, textLen: (b as any).toolText?.length || (b as any).text?.length })));
                    onUpdate(finalBlocks);
                  }
                } else if (currentContent.length > 0) {
                  // Ensure any tool_use blocks are sent even if no final text
                  onUpdate(currentContent.map(c => c.type === 'tool_use' ? { ...c, isActive: false } : c));
                }
                onDone();
              } else if (data.type === 'content_saved') {
                // Server saved HTML content - store the ID for sharing
                savedContentId = data.contentId;
                console.log(`[${modelId}] Content saved with ID:`, savedContentId);
                // Update any existing html/streaming_html blocks with the contentId
                currentContent = currentContent.map(c =>
                  (c.type === 'html' || c.type === 'streaming_html')
                    ? { ...c, contentId: savedContentId }
                    : c
                );
              } else if (data.type === 'cancelled') {
                // Request was cancelled by the user
                console.log(`[${modelId}] Request cancelled by user`);
                // Keep any content collected so far but mark as complete
                currentContent = currentContent.map(c =>
                  c.type === 'tool_use' && c.isActive ? { ...c, isActive: false } : c
                );
                if (currentText.trim()) {
                  currentContent.push({ type: 'text', text: currentText + '\n\n*(Cancelled)*' });
                } else if (currentContent.length === 0) {
                  currentContent.push({ type: 'text', text: '*(Cancelled)*' });
                }
                onUpdate(currentContent);
                onDone();
              } else if (data.type === 'tool_start') {
                pendingToolName = data.tool;
                onToolStart(data.tool);
                const isDbTool = DATABASE_TOOLS.includes(data.tool);
                if (isDbTool) {
                  hadToolUses = true;
                }
                if (isDbTool && data.sql) {
                  // Commit any pre-SQL text first, then add SQL
                  const cotIndex = currentContent.findIndex(c => c.type === 'tool_use' && c.toolName === 'chain_of_thought');
                  // Include any previous pending SQL, then current text, then new SQL
                  let newToolText = '';
                  if (pendingSql) {
                    newToolText += `\`\`\`sql\n${pendingSql}\n\`\`\`\n`;
                  }
                  if (currentText.trim()) {
                    newToolText += currentText.trim() + '\n';
                  }
                  newToolText += `\`\`\`sql\n${data.sql}\n\`\`\`\n`;

                  if (cotIndex >= 0) {
                    const existingBlock = currentContent[cotIndex];
                    currentContent = [
                      ...currentContent.slice(0, cotIndex),
                      { ...existingBlock, toolText: (existingBlock.toolText || '') + newToolText, isActive: true },
                      ...currentContent.slice(cotIndex + 1),
                    ];
                  } else {
                    currentContent = [...currentContent, {
                      type: 'tool_use',
                      toolName: 'chain_of_thought',
                      toolText: newToolText,
                      isActive: true
                    }];
                  }
                  currentText = '';
                  pendingSql = ''; // SQL is now committed

                  // Update UI
                  const otherContent = getVisualizationsAndHtml(currentContent);
                  const cotBlock = currentContent.find(c => c.type === 'tool_use' && c.toolName === 'chain_of_thought');
                  onUpdate([cotBlock!, ...otherContent]);
                }
              } else if (data.type === 'tool_end') {
                onToolEnd();
              } else if (data.type === 'chart') {
                currentContent = [...currentContent.filter(c => c.type !== 'text'), { type: 'text', text: currentText }, { type: 'chart', chart: data.spec }];
                currentText = '';
                onUpdate(currentContent);
              } else if (data.type === 'map') {
                currentContent = [...currentContent.filter(c => c.type !== 'text'), { type: 'text', text: currentText }, { type: 'map', map: data.spec }];
                currentText = '';
                onUpdate(currentContent);
              } else if (data.type === 'intermediate_text') {
                // Streaming text from intermediate phase (e.g., Gemini gathering data in blended mode)
                // Add to chain_of_thought so it shows with SQL queries
                const cotIndex = currentContent.findIndex(c => c.type === 'tool_use' && c.toolName === 'chain_of_thought');
                if (cotIndex >= 0) {
                  currentContent = [
                    ...currentContent.slice(0, cotIndex),
                    {
                      ...currentContent[cotIndex],
                      toolText: (currentContent[cotIndex].toolText || '') + data.content,
                      isActive: true
                    },
                    ...currentContent.slice(cotIndex + 1)
                  ];
                } else {
                  currentContent = [...currentContent, {
                    type: 'tool_use',
                    toolName: 'chain_of_thought',
                    toolText: data.content,
                    isActive: true
                  }];
                }
                onUpdate([...currentContent]);
              } else if (data.type === 'intermediate_output') {
                // Final intermediate output (replaces streaming content)
                console.log(`[${modelId}] Received intermediate_output, content length:`, data.content?.length);
                currentContent = [
                  ...currentContent.filter(c => !(c.type === 'intermediate_output' && c.intermediateSource === data.source)),
                  {
                    type: 'intermediate_output',
                    intermediateSource: data.source,
                    intermediateContent: data.content
                  }
                ];
                console.log(`[${modelId}] currentContent after intermediate_output:`, currentContent.map(c => c.type));
                onUpdate([...currentContent]);
              } else if (data.type === 'error') {
                onError(data.message || 'An error occurred');
              }
            } catch { /* Skip invalid JSON */ }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      onError(error instanceof Error ? error.message : 'An error occurred');
    }
  }, [includeMetadata]);

  // Helper to send a message to a single model in head-to-head mode
  const sendMessageToSingleModel = useCallback(async (
    modelConfig: { id: string; name: string; model: string },
    messageText: string
  ) => {
    const isMobile = window.innerWidth <= 768;
    const userMessage: Message = { role: 'user', content: messageText };

    // Use a promise to get the current messages after state update
    // This avoids race conditions with stale ref values
    const currentModelMessages = await new Promise<Message[]>((resolve) => {
      setHeadToHeadMessages(prev => {
        const msgs = prev[modelConfig.id] || [];
        // Schedule resolve after this state update
        setTimeout(() => resolve(msgs), 0);
        // Add user message + assistant placeholder
        return {
          ...prev,
          [modelConfig.id]: [...msgs, userMessage, { role: 'assistant', content: [] }]
        };
      });
    });

    // Set loading state for this model
    setHeadToHeadLoading(prev => ({ ...prev, [modelConfig.id]: true }));

    // Create abort controller
    headToHeadAbortControllers.current[modelConfig.id] = new AbortController();

    // Get API messages (now includes the latest response from previous question)
    const modelMessages = [...currentModelMessages, userMessage];
    const apiMessages = messagesToApiFormat(modelMessages);

    await runModelStream(
      modelConfig.id,
      modelConfig.model,
      apiMessages,
      isMobile,
      headToHeadAbortControllers.current[modelConfig.id].signal,
      (content) => setHeadToHeadMessages(prev => {
        const msgs = [...(prev[modelConfig.id] || [])];
        if (msgs.length > 0) {
          msgs[msgs.length - 1] = { role: 'assistant', content };
        }
        return { ...prev, [modelConfig.id]: msgs };
      }),
      (tool) => setHeadToHeadToolRunning(prev => ({ ...prev, [modelConfig.id]: tool })),
      () => setHeadToHeadToolRunning(prev => ({ ...prev, [modelConfig.id]: null })),
      () => {
        setHeadToHeadLoading(prev => ({ ...prev, [modelConfig.id]: false }));
        // Don't call processQueueForModel here - it's handled by the .finally() in processQueueForModel
      },
      (error) => {
        setHeadToHeadMessages(prev => {
          const msgs = [...(prev[modelConfig.id] || [])];
          if (msgs.length > 0) {
            msgs[msgs.length - 1] = { role: 'assistant', content: [{ type: 'text', text: `Error: ${error}` }] };
          }
          return { ...prev, [modelConfig.id]: msgs };
        });
        setHeadToHeadLoading(prev => ({ ...prev, [modelConfig.id]: false }));
        // Don't call processQueueForModel here - it's handled by the .finally() in processQueueForModel
      },
    );
  }, [runModelStream]);

  // Keep messageQueueRef in sync with state
  useEffect(() => {
    messageQueueRef.current = messageQueue;
  }, [messageQueue]);

  // Ref to hold the latest processQueueForModel function (avoids stale closure in recursive calls)
  const processQueueForModelRef = useRef<(modelConfig: { id: string; name: string; model: string }) => void>(() => {});

  // Process next queued message for a specific model in head-to-head mode
  const processQueueForModel = useCallback((modelConfig: { id: string; name: string; model: string }) => {
    // Prevent double processing for this model
    if (headToHeadProcessingRef.current[modelConfig.id]) {
      return;
    }

    // Get current queue index for this model - do this SYNCHRONOUSLY
    const currentIndex = headToHeadQueueIndexRef.current[modelConfig.id] || 0;
    const currentQueue = messageQueueRef.current;

    // Check if there's anything to process
    if (currentIndex >= currentQueue.length) {
      return;
    }

    // Set processing flag and increment index IMMEDIATELY (synchronously)
    headToHeadProcessingRef.current[modelConfig.id] = true;
    headToHeadQueueIndexRef.current[modelConfig.id] = currentIndex + 1;

    const nextMessage = currentQueue[currentIndex];

    // Send to this model with delay to allow DOM/state to settle
    setTimeout(() => {
      sendMessageToSingleModel(modelConfig, nextMessage).finally(() => {
        // Clear processing flag after send completes
        headToHeadProcessingRef.current[modelConfig.id] = false;
        // Check for more queued items using ref to get latest function
        processQueueForModelRef.current(modelConfig);
      });
    }, 150);
  }, [sendMessageToSingleModel]);

  // Keep the ref updated with latest function
  processQueueForModelRef.current = processQueueForModel;

  const sendMessage = useCallback(async (messageText?: string) => {
    const text = messageText || inputValue.trim();
    if (!text) return;

    // Check if any model is still loading (for head-to-head) or global loading (standard mode)
    const anyModelLoading = isHeadToHead
      ? Object.values(headToHeadLoading).some(loading => loading)
      : isLoading;

    // If already loading, add message to queue
    if (anyModelLoading) {
      const newQueue = [...messageQueueRef.current, text];
      messageQueueRef.current = newQueue; // Update ref immediately for synchronous access
      setMessageQueue(newQueue);
      setInputValue('');
      return;
    }

    // Include shared context if available (from shared report links)
    // Capture and clear shared report ID for this message
    const currentSharedReportId = sharedReportId;
    if (sharedReportId) {
      setSharedReportId(null);
    }

    const userMessage: Message = { role: 'user', content: text };
    // Use ref to get latest messages (avoids stale closure with queued messages)
    const currentMessages = messagesRef.current;
    const newMessages = [...currentMessages, userMessage];
    setMessages(newMessages);
    setInputValue('');
    setIsLoading(true);

    // Head-to-head mode: run all models in parallel
    if (isHeadToHead) {
      const isMobile = window.innerWidth <= 768;

      // Reset per-model queue indices and processing flags (new direct message resets queue tracking)
      headToHeadQueueIndexRef.current = {};
      headToHeadProcessingRef.current = {};

      // Capture current messages for each model before updating state
      const currentMessages: Record<string, Message[]> = {};
      HEAD_TO_HEAD_MODELS.forEach(m => {
        currentMessages[m.id] = [...(headToHeadMessages[m.id] || [])];
      });

      // Add user message + assistant placeholder to each model's conversation
      setHeadToHeadMessages(() => {
        const updated: Record<string, Message[]> = {};
        HEAD_TO_HEAD_MODELS.forEach(m => {
          updated[m.id] = [...currentMessages[m.id], userMessage, { role: 'assistant', content: [] }];
        });
        return updated;
      });

      // Set loading state for all models
      setHeadToHeadLoading(Object.fromEntries(HEAD_TO_HEAD_MODELS.map(m => [m.id, true])));
      setHeadToHeadToolRunning({});

      // Create abort controllers for each model
      HEAD_TO_HEAD_MODELS.forEach(m => {
        headToHeadAbortControllers.current[m.id] = new AbortController();
      });

      // Run all models in parallel - each model processes queue independently when done
      HEAD_TO_HEAD_MODELS.forEach(async (modelConfig) => {
        // Get API messages including the new user message
        const modelMessages = [...currentMessages[modelConfig.id], userMessage];
        const apiMessages = messagesToApiFormat(modelMessages);

        await runModelStream(
          modelConfig.id,
          modelConfig.model,
          apiMessages,
          isMobile,
          headToHeadAbortControllers.current[modelConfig.id].signal,
          (content) => setHeadToHeadMessages(prev => {
            const msgs = [...(prev[modelConfig.id] || [])];
            // Update the last message (assistant response)
            if (msgs.length > 0) {
              msgs[msgs.length - 1] = { role: 'assistant', content };
            }
            return { ...prev, [modelConfig.id]: msgs };
          }),
          (tool) => setHeadToHeadToolRunning(prev => ({ ...prev, [modelConfig.id]: tool })),
          () => setHeadToHeadToolRunning(prev => ({ ...prev, [modelConfig.id]: null })),
          () => {
            setHeadToHeadLoading(prev => ({ ...prev, [modelConfig.id]: false }));
            // Process queue for this specific model
            processQueueForModel(modelConfig);
          },
          (error) => {
            setHeadToHeadMessages(prev => {
              const msgs = [...(prev[modelConfig.id] || [])];
              if (msgs.length > 0) {
                msgs[msgs.length - 1] = { role: 'assistant', content: [{ type: 'text', text: `Error: ${error}` }] };
              }
              return { ...prev, [modelConfig.id]: msgs };
            });
            setHeadToHeadLoading(prev => ({ ...prev, [modelConfig.id]: false }));
            // Still process queue on error
            processQueueForModel(modelConfig);
          },
          currentSharedReportId,
        );
      });

      setIsLoading(false);
      return;
    }

    // Standard single-model mode - use same runModelStream as head-to-head
    // Add placeholder for assistant response
    setMessages(prev => [...prev, { role: 'assistant', content: [] }]);

    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    const isMobile = window.innerWidth <= 768;

    await runModelStream(
      'standalone',
      currentModelConfig.model,
      messagesToApiFormat(newMessages),
      isMobile,
      abortControllerRef.current.signal,
      // onUpdate
      (content) => setMessages(prev => {
        const updated = [...prev];
        if (updated.length > 0) {
          updated[updated.length - 1] = { role: 'assistant', content };
        }
        return updated;
      }),
      // onToolStart
      (tool) => setIsToolRunning(tool),
      // onToolEnd
      () => setIsToolRunning(null),
      // onDone
      () => {
        setIsLoading(false);
        setIsToolRunning(null);
        abortControllerRef.current = null;
      },
      // onError
      (error) => {
        setMessages(prev => {
          const updated = [...prev];
          if (updated.length > 0) {
            updated[updated.length - 1] = { role: 'assistant', content: [{ type: 'text', text: `Error: ${error}` }] };
          }
          return updated;
        });
        setIsLoading(false);
        setIsToolRunning(null);
        abortControllerRef.current = null;
      },
      currentSharedReportId,
    )
  }, [inputValue, isLoading, includeMetadata, currentModelConfig, isHeadToHead, headToHeadMessages, headToHeadLoading, runModelStream, processQueueForModel]);

  // Process queued messages when loading completes (standard mode only)
  // Head-to-head mode handles queue processing per-model via processQueueForModel
  useEffect(() => {
    // Skip for head-to-head mode - it handles queue per-model
    if (isHeadToHead) return;

    // Only process if not loading, queue has items, and we're not already processing
    if (!isLoading && messageQueue.length > 0 && !isProcessingQueueRef.current) {
      isProcessingQueueRef.current = true;
      const [nextMessage, ...remainingMessages] = messageQueue;
      setMessageQueue(remainingMessages);
      // Delay to ensure state is fully settled before sending next message
      setTimeout(() => {
        sendMessage(nextMessage);
        // Reset flag after sendMessage has been called (isLoading will be true by then)
        isProcessingQueueRef.current = false;
      }, 100);
    }
  }, [isLoading, messageQueue, sendMessage, isHeadToHead]);

  // Clean up queue in head-to-head mode when all models have processed all items
  useEffect(() => {
    if (!isHeadToHead || messageQueue.length === 0) return;

    // Check if all models have processed all queue items, are done loading, and not processing
    const allModelsIdle = HEAD_TO_HEAD_MODELS.every(m => !headToHeadLoading[m.id]);
    const allModelsNotProcessing = HEAD_TO_HEAD_MODELS.every(m => !headToHeadProcessingRef.current[m.id]);
    const allModelsCaughtUp = HEAD_TO_HEAD_MODELS.every(m =>
      (headToHeadQueueIndexRef.current[m.id] || 0) >= messageQueue.length
    );

    if (allModelsIdle && allModelsNotProcessing && allModelsCaughtUp) {
      // All models have processed all queued messages - clear queue and indices
      messageQueueRef.current = [];
      setMessageQueue([]);
      headToHeadQueueIndexRef.current = {};
      headToHeadProcessingRef.current = {};
    }
  }, [isHeadToHead, messageQueue, headToHeadLoading]);

  // Trigger idle models to process new queue items (when queue grows while a model is idle)
  useEffect(() => {
    if (!isHeadToHead || messageQueue.length === 0) return;

    // Check each model - if it's idle and has unprocessed queue items, trigger it
    HEAD_TO_HEAD_MODELS.forEach(modelConfig => {
      const isIdle = !headToHeadLoading[modelConfig.id];
      const isNotProcessing = !headToHeadProcessingRef.current[modelConfig.id];
      const currentIndex = headToHeadQueueIndexRef.current[modelConfig.id] || 0;
      const hasUnprocessedItems = currentIndex < messageQueue.length;

      if (isIdle && isNotProcessing && hasUnprocessedItems) {
        processQueueForModel(modelConfig);
      }
    });
  }, [isHeadToHead, messageQueue, headToHeadLoading, processQueueForModel]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearHistory = () => {
    // Abort any ongoing API request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    // Abort any ongoing head-to-head requests
    Object.values(headToHeadAbortControllers.current).forEach(controller => {
      controller.abort();
    });
    headToHeadAbortControllers.current = {};

    setMessages([]);
    setHeadToHeadMessages({});
    setHeadToHeadLoading({});
    setHeadToHeadToolRunning({});
    setIsLoading(false);
    setIsToolRunning(null);
    // Clear chat history but keep user preferences (model selection, metadata toggle)
    localStorage.removeItem(storageKey);
    localStorage.removeItem('mcp_head_to_head_history');
  };

  const handleExampleClick = (example: string) => {
    sendMessage(example);
  };

  // Helper to check if a message has content worth rendering
  const hasMessageContent = (msg: Message) => {
    return typeof msg.content === 'string'
      ? msg.content.length > 0
      : msg.content.length > 0 && msg.content.some(block =>
          (block.type === 'text' && block.text) ||
          (block.type === 'chart' && block.chart) ||
          (block.type === 'map' && block.map) ||
          (block.type === 'html' && block.html) ||
          (block.type === 'streaming_html' && block.htmlChunks) ||
          (block.type === 'tool_use' && block.toolName && (block.toolText || block.isActive)) ||
          (block.type === 'intermediate_output' && block.intermediateContent) ||
          (block.type === 'shared_report' && block.shareId)
        );
  };

  // Helper to render a single message
  // keyPrefix is used to ensure unique keys across different tabs in head-to-head mode
  const renderMessage = (msg: Message, idx: number, keyPrefix: string = 'msg') => {
    if (!hasMessageContent(msg)) return null;

    const ContentWrapper = msg.role === 'assistant' ? MaxWidthContainer : 'div';

    const hasHtml = typeof msg.content !== 'string' && msg.content.some(block =>
      (block.type === 'html' && block.html) ||
      (block.type === 'streaming_html' && block.htmlChunks) ||
      (block.type === 'shared_report' && block.shareId)
    );

    const isStreamingHtml = typeof msg.content !== 'string' && msg.content.some(block =>
      block.type === 'streaming_html' && block.htmlChunks && !block.isComplete
    );

    return (
      <div key={`${keyPrefix}-${idx}`} className={`chat-message chat-message-${msg.role}${hasHtml ? ' has-html' : ''}`}>
        <ContentWrapper className="chat-message-content">
          {typeof msg.content === 'string' ? (
            msg.role === 'assistant' ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{msg.content}</ReactMarkdown>
            ) : (
              msg.content
            )
          ) : (
            msg.content.map((block, blockIdx) => {
              const blockKey = `${keyPrefix}-${idx}-${blockIdx}`;
              if (block.type === 'text' && block.text) {
                // Filter out both HTML and SQL from displayed text
                let displayText = filterHtmlFromText(block.text);
                displayText = filterSqlFromText(displayText);
                if (!displayText.trim()) return null;
                return <ReactMarkdown key={blockKey} remarkPlugins={[remarkGfm]} components={markdownComponents}>{displayText}</ReactMarkdown>;
              }
              if (block.type === 'chart' && block.chart) {
                return <ChatChart key={blockKey} spec={block.chart} />;
              }
              if (block.type === 'map' && block.map) {
                return <ChatMap key={blockKey} spec={block.map} />;
              }
              if (block.type === 'html' && block.html) {
                return <HtmlFrame key={blockKey} html={block.html} contentId={block.contentId} />;
              }
              if (block.type === 'streaming_html' && block.htmlChunks) {
                return <StreamingHtmlFrame key={blockKey} htmlChunks={block.htmlChunks} isComplete={block.isComplete || false} contentId={block.contentId} />;
              }
              if (block.type === 'tool_use' && block.toolName) {
                return <ToolUseSection key={blockKey} toolName={block.toolName} toolText={block.toolText || ''} isActive={block.isActive} isStreaming={isStreamingHtml} keyPrefix={blockKey} expansionState={expansionStates.current} onToggleExpansion={toggleExpansion} />;
              }
              if (block.type === 'intermediate_output' && block.intermediateContent) {
                return <IntermediateOutputSection key={blockKey} source={block.intermediateSource || 'unknown'} content={block.intermediateContent} expansionKey={blockKey} expansionState={expansionStates.current} onToggleExpansion={toggleExpansion} />;
              }
              if (block.type === 'shared_report' && block.shareId) {
                return (
                  <div key={blockKey} className="shared-report-frame">
                    <div className="shared-report-label">Previous Report</div>
                    <iframe
                      src={`/share/${block.shareId}?embed=1`}
                      title="Previous report"
                      className="shared-report-iframe"
                    />
                  </div>
                );
              }
              return null;
            })
          )}
        </ContentWrapper>
      </div>
    );
  };

  // Check if there's any conversation to display
  const hasConversation = isHeadToHead
    ? Object.values(headToHeadMessages).some(msgs => msgs.length > 0)
    : messages.length > 0;

  // Apply theme based on selected model
  const themeClass = selectedModel === 'gemini' ? 'theme-gemini' : (selectedModel === 'blended' || selectedModel === 'head-to-head') ? 'theme-quacker' : '';

  // Show minimal loading state until localStorage is loaded to avoid flash
  if (!isHydrated) {
    return <div className="chat-container" style={{ opacity: 0 }} />;
  }

  return (
    <div className={`chat-container ${themeClass}`}>
      <header className="chat-header">
        <div className="chat-header-left">
          <div>
            <div className="chat-title">
              <span key={selectedModel} className="chat-title-animated">{currentModelConfig.appName}</span>
            </div>
            <div className="chat-subtitle">Ask questions of business data in MotherDuck using a {currentModelConfig.subtitle} interface.</div>
          </div>
        </div>
        {hasConversation && (
          <button className="chat-clear" onClick={clearHistory}>
            Clear Chat
          </button>
        )}
      </header>

      <div className="chat-messages" ref={messagesContainerRef}>
        {!hasConversation ? (
          <div className="chat-welcome">
            <h2><span className="welcome-full">Welcome to {currentModelConfig.appName}</span><span className="welcome-short">Welcome</span></h2>
            <p>We've hooked up this interface to MotherDuck using the MotherDuck MCP Server. You have access to business data for a fictitious business, Eastlake, which manufactures and sells products to businesses. Start asking it some questions.</p>
            <div className="chat-examples">
              {EXAMPLE_PROMPTS.map((example, idx) => (
                <button
                  key={idx}
                  className="chat-example"
                  onClick={() => handleExampleClick(example)}
                >
                  {example}
                </button>
              ))}
            </div>
            <label className="metadata-toggle">
              <input
                type="checkbox"
                checked={includeMetadata}
                onChange={(e) => saveIncludeMetadata(e.target.checked)}
              />
              <span className="toggle-slider"></span>
              <span className="toggle-label">Include metadata in prompt</span>
            </label>
            <div className="model-selector">
              <label className="model-selector-label">Model:</label>
              <select
                value={selectedModel}
                onChange={(e) => saveSelectedModel(e.target.value)}
                className="model-dropdown"
              >
                {MODEL_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ) : isHeadToHead ? (
          /* Head-to-head mode: render ALL tabs but only show the active one */
          /* This preserves iframe scroll state when switching tabs */
          <>
            {HEAD_TO_HEAD_MODELS.map((model) => (
              <div
                key={model.id}
                className={`head-to-head-tab-content ${activeTab === model.id ? 'active' : ''}`}
              >
                {(headToHeadMessages[model.id] || []).map((msg, idx) => renderMessage(msg, idx, model.id))}
                {headToHeadLoading[model.id] && (
                  <div className="chat-loading-indicator">
                    <span className="chat-loading-dot" />
                    <span className="chat-loading-text">
                      {headToHeadToolRunning[model.id] ? 'Querying data' : 'Thinking'}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </>
        ) : (
          /* Standard mode: render messages normally */
          <>
            {messages.map((msg, idx) => renderMessage(msg, idx, 'msg'))}
            {isLoading && (
              <div className="chat-loading-indicator">
                <span className="chat-loading-dot" />
                <span className="chat-loading-text">
                  {isToolRunning ? 'Querying data' : 'Thinking'}
                </span>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Head-to-head tabs - fixed above input */}
      {isHeadToHead && hasConversation && (
        <div className="head-to-head-tab-bar">
          {HEAD_TO_HEAD_MODELS.map((model) => (
            <button
              key={model.id}
              className={`head-to-head-tab ${activeTab === model.id ? 'active' : ''} ${headToHeadLoading[model.id] ? 'loading' : ''}`}
              onClick={() => saveActiveTab(model.id)}
            >
              {model.name}
              {headToHeadLoading[model.id] && <span className="tab-spinner" />}
            </button>
          ))}
        </div>
      )}

      {(() => {
        // Calculate remaining queue items based on minimum index processed across models
        let remainingCount = messageQueue.length;
        if (isHeadToHead && messageQueue.length > 0) {
          const minIndex = Math.min(
            ...HEAD_TO_HEAD_MODELS.map(m => headToHeadQueueIndexRef.current[m.id] || 0)
          );
          remainingCount = Math.max(0, messageQueue.length - minIndex);
        }
        return (
          <div className={`chat-input-area${!hasConversation ? ' welcome' : ''}`}>
            {remainingCount > 0 && (
              <div className="queued-message-indicator">
                {remainingCount === 1
                  ? `Next: ${messageQueue[messageQueue.length - remainingCount]?.slice(0, 50) || ''}${(messageQueue[messageQueue.length - remainingCount]?.length || 0) > 50 ? '...' : ''}`
                  : `${remainingCount} questions queued`
                }
              </div>
            )}
            <input
              ref={inputRef}
              type="text"
              className="chat-input"
              placeholder={remainingCount > 0 ? `${remainingCount} queued - type another or wait...` : "Ask a question about your data..."}
              value={inputValue}
              onChange={e => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="chat-send"
              onClick={() => sendMessage()}
              disabled={!inputValue.trim()}
              aria-label="Send message"
            >
              {isLoading && remainingCount === 0 ? '◷' : '→'}
            </button>
          </div>
        );
      })()}
    </div>
  );
}
