'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
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

// Collapsible tool use section component
function ToolUseSection({ toolName, toolText, isActive, isStreaming }: { toolName: string; toolText: string; isActive?: boolean; isStreaming?: boolean }) {
  const [isManuallyExpanded, setIsManuallyExpanded] = useState<boolean | null>(null);
  const wasActive = useRef(isActive);
  const wasStreaming = useRef(isStreaming);

  // Auto-collapse when transitioning from active to inactive, but only if not streaming
  useEffect(() => {
    if (wasActive.current && !isActive && !isStreaming) {
      setIsManuallyExpanded(false);
    }
    // Also collapse when streaming ends
    if (wasStreaming.current && !isStreaming && !isActive) {
      setIsManuallyExpanded(false);
    }
    wasActive.current = isActive;
    wasStreaming.current = isStreaming;
  }, [isActive, isStreaming]);

  const getToolDisplayName = (name: string) => {
    if (name === 'database_ops') return 'Queried database';
    const toolNames: Record<string, string> = {
      'query': 'Queried database',
      'list_tables': 'Listed tables',
      'list_columns': 'Listed columns',
      'search_catalog': 'Searched catalog',
    };
    return toolNames[name] || `Used ${name}`;
  };

  // Show expanded if active, streaming, or manually expanded (manual toggle overrides)
  const showExpanded = isManuallyExpanded !== null ? isManuallyExpanded : (isActive || isStreaming);

  return (
    <div className={`tool-use-section ${isActive ? 'tool-use-active' : ''}`}>
      <button
        className="tool-use-toggle"
        onClick={() => setIsManuallyExpanded(!showExpanded)}
      >
        <span className="tool-use-icon">{showExpanded ? '▼' : '▶'}</span>
        <span className="tool-use-label">{getToolDisplayName(toolName)}</span>
        {isActive && <span className="tool-use-spinner" />}
      </button>
      {showExpanded && toolText && (
        <div className="tool-use-content">
          {toolText}
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
  type: 'text' | 'chart' | 'tool_use' | 'map' | 'html' | 'streaming_html';
  text?: string;
  chart?: ChartSpec;
  map?: MapSpec;
  html?: string;
  htmlChunks?: string;  // For streaming HTML
  isComplete?: boolean; // For streaming HTML completion state
  toolName?: string;
  toolText?: string;
  isActive?: boolean;
}

interface Message {
  role: 'user' | 'assistant';
  content: string | MessageContent[];
}

const EXAMPLE_PROMPTS = [
  'What products do we sell, and how have they performed?',
  'Which customers buy the largest variety of products?',
  'Analyze sales by region and show a map with details.',
];

export default function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isToolRunning, setIsToolRunning] = useState<string | null>(null);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const userHasScrolledUp = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const storageKey = 'mcp_chat_history';

  // Load messages from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setMessages(parsed);
        }
      } catch (e) {
        console.error('Failed to parse saved chat history:', e);
      }
    }
  }, []);

  // Save messages to localStorage when they change
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(storageKey, JSON.stringify(messages));
    }
  }, [messages]);

  // Check if user is near the bottom of the chat
  const isNearBottom = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return true;
    const threshold = 100;
    return container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  }, []);

  // Handle scroll events to track if user scrolled up
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      userHasScrolledUp.current = !isNearBottom();
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [isNearBottom]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (!userHasScrolledUp.current) {
      // Use auto (instant) scroll during loading to avoid conflicts with manual scrolling
      // Use smooth scroll only when loading completes
      messagesEndRef.current?.scrollIntoView({ behavior: isLoading ? 'auto' : 'smooth' });
    }
  }, [messages, isLoading]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Helper to convert messages to API format
  const messagesToApiFormat = (msgs: Message[]) => {
    return msgs.map(msg => ({
      role: msg.role,
      content: typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter(c => c.type === 'text' && c.text)
            .map(c => c.text)
            .join('') || '[visualization response]',
    })).filter(msg => msg.content);
  };

  const sendMessage = useCallback(async (messageText?: string) => {
    const text = messageText || inputValue.trim();
    if (!text || isLoading) return;

    userHasScrolledUp.current = false;

    const userMessage: Message = { role: 'user', content: text };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInputValue('');
    setIsLoading(true);

    // Add placeholder for assistant response
    setMessages(prev => [...prev, { role: 'assistant', content: [] }]);

    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    try {
      // Detect if user is on mobile
      const isMobile = window.innerWidth <= 768;

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messagesToApiFormat(newMessages),
          isMobile,
          includeMetadata,
        }),
        signal: abortControllerRef.current.signal,
      });

      if (!response.ok) {
        throw new Error('Failed to send message');
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let currentContent: MessageContent[] = [];
      let currentText = '';
      let pendingToolName = ''; // Track which tool just ran
      let isStreamingHtml = false; // Track if we're in HTML streaming mode
      let htmlStreamStart = -1; // Where HTML starts in the full text
      let beforeHtmlText = ''; // Text before HTML started

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
                if (DEBUG_HTML_DETECTION) console.log('[Stream] text event, content length:', data.content.length, 'total currentText:', currentText.length + data.content.length);

                // If a tool just ran and we have NEW substantial content,
                // move the OLD currentText to tool_use section
                if (pendingToolName && data.content.trim()) {
                  const isDbTool = DATABASE_TOOLS.includes(pendingToolName);

                  if (isDbTool && currentText.trim()) {
                    const existingDbOpsIndex = currentContent.findIndex(
                      c => c.type === 'tool_use' && c.toolName === 'database_ops'
                    );

                    if (existingDbOpsIndex >= 0) {
                      const existingBlock = currentContent[existingDbOpsIndex];
                      const newToolText = existingBlock.toolText
                        ? existingBlock.toolText + '\n\n' + currentText.trim()
                        : currentText.trim();
                      currentContent = [
                        ...currentContent.slice(0, existingDbOpsIndex),
                        { ...existingBlock, toolText: newToolText, isActive: true },
                        ...currentContent.slice(existingDbOpsIndex + 1),
                      ];
                    } else {
                      currentContent = [
                        ...currentContent,
                        { type: 'tool_use', toolName: 'database_ops', toolText: currentText.trim(), isActive: true },
                      ];
                    }
                  }

                  // Start fresh with new text
                  currentText = data.content;
                  pendingToolName = '';
                } else if (pendingToolName) {
                  // Tool ran but new content is just whitespace - append but don't move yet
                  currentText += data.content;
                } else {
                  // No tool ran, just append
                  currentText += data.content;
                }

                // Detect if HTML is starting in the stream
                if (!isStreamingHtml) {
                  const htmlDetection = detectHtmlStart(currentText);
                  if (htmlDetection.hasHtml) {
                    isStreamingHtml = true;
                    htmlStreamStart = htmlDetection.htmlStart;
                    beforeHtmlText = htmlDetection.beforeText;
                    if (DEBUG_HTML_DETECTION) console.log('[Stream] HTML detected at position:', htmlStreamStart, 'beforeText:', beforeHtmlText.slice(0, 100));
                  }
                }

                const preservedContent = currentContent.filter(c => c.type === 'chart' || c.type === 'tool_use' || c.type === 'map' || c.type === 'html' || c.type === 'streaming_html');

                if (isStreamingHtml) {
                  // Show streaming HTML frame with the HTML portion
                  const htmlChunks = currentText.slice(htmlStreamStart);
                  const contentBlocks: MessageContent[] = [...preservedContent];
                  if (beforeHtmlText) {
                    contentBlocks.push({ type: 'text', text: beforeHtmlText });
                  }
                  contentBlocks.push({ type: 'streaming_html', htmlChunks, isComplete: false });

                  setMessages(prev => {
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                      role: 'assistant',
                      content: contentBlocks,
                    };
                    return updated;
                  });
                } else {
                  setMessages(prev => {
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                      role: 'assistant',
                      content: [...preservedContent, { type: 'text', text: currentText }],
                    };
                    return updated;
                  });
                }
              } else if (data.type === 'done') {
                if (DEBUG_HTML_DETECTION) console.log('[Stream] done event received');

                // Clear pending tool name
                pendingToolName = '';

                // Mark all active tool_use sections as inactive when stream ends
                currentContent = currentContent.map(c =>
                  c.type === 'tool_use' && c.isActive ? { ...c, isActive: false } : c
                );

                // Handle final content - either streaming HTML completion or normal text
                if (DEBUG_HTML_DETECTION) console.log('[Done] currentText length:', currentText.length);
                if (DEBUG_HTML_DETECTION) console.log('[Done] currentContent types:', currentContent.map(c => c.type));
                if (DEBUG_HTML_DETECTION) console.log('[Done] isStreamingHtml:', isStreamingHtml);

                if (isStreamingHtml) {
                  // We were streaming HTML - mark it as complete
                  const htmlChunks = currentText.slice(htmlStreamStart);
                  const preservedContent = currentContent.filter(c => c.type === 'chart' || c.type === 'tool_use' || c.type === 'map');
                  const contentBlocks: MessageContent[] = [...preservedContent];
                  if (beforeHtmlText) {
                    contentBlocks.push({ type: 'text', text: beforeHtmlText });
                  }
                  // Keep as streaming_html but mark complete - this triggers the iframe to close the document
                  contentBlocks.push({ type: 'streaming_html', htmlChunks, isComplete: true });

                  setMessages(prev => {
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                      role: 'assistant',
                      content: contentBlocks,
                    };
                    return updated;
                  });
                } else {
                  // Normal text handling
                  const finalBlocks: MessageContent[] = [];
                  if (currentText) {
                    if (DEBUG_HTML_DETECTION) {
                      console.log('[HTML Detection] Checking text (full):', currentText);
                      console.log('[HTML Detection] Text includes ```html:', currentText.includes('```html'));
                      console.log('[HTML Detection] Text includes <!DOCTYPE:', currentText.toLowerCase().includes('<!doctype'));
                      console.log('[HTML Detection] isHtmlContent result:', isHtmlContent(currentText));
                    }
                    if (isHtmlContent(currentText)) {
                      const parts = extractHtmlParts(currentText);
                      if (DEBUG_HTML_DETECTION) {
                        console.log('[HTML Detection] extractHtmlParts result:', parts ? 'found' : 'null');
                        if (parts) console.log('[HTML Detection] HTML length:', parts.html.length);
                      }
                      if (parts) {
                        if (parts.beforeText) {
                          finalBlocks.push({ type: 'text', text: parts.beforeText });
                        }
                        finalBlocks.push({ type: 'html', html: parts.html });
                        if (parts.afterText) {
                          finalBlocks.push({ type: 'text', text: parts.afterText });
                        }
                      } else {
                        finalBlocks.push({ type: 'text', text: currentText });
                      }
                    } else {
                      finalBlocks.push({ type: 'text', text: currentText });
                    }
                  }

                  const finalContent = finalBlocks.length > 0
                    ? [...currentContent, ...finalBlocks]
                    : currentContent;
                  setMessages(prev => {
                    const updated = [...prev];
                    updated[updated.length - 1] = {
                      role: 'assistant',
                      content: finalContent,
                    };
                    return updated;
                  });
                }
              }
              else if (data.type === 'chart') {
                currentContent = [
                  ...currentContent.filter(c => c.type === 'chart' || c.type === 'tool_use' || c.type === 'map' || c.type === 'html' || c.type === 'streaming_html'),
                  { type: 'text', text: currentText },
                  { type: 'chart', chart: data.spec },
                ];
                currentText = '';
                setMessages(prev => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: 'assistant',
                    content: currentContent,
                  };
                  return updated;
                });
              } else if (data.type === 'map') {
                currentContent = [
                  ...currentContent.filter(c => c.type === 'chart' || c.type === 'tool_use' || c.type === 'map' || c.type === 'html' || c.type === 'streaming_html'),
                  { type: 'text', text: currentText },
                  { type: 'map', map: data.spec },
                ];
                currentText = '';
                setMessages(prev => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: 'assistant',
                    content: currentContent,
                  };
                  return updated;
                });
              } else if (data.type === 'tool_start') {
                const isDbTool = DATABASE_TOOLS.includes(data.tool);

                // Just mark that a tool is running - currentText stays visible
                // It will be moved to tool_use when NEW text arrives
                pendingToolName = data.tool;

                // Update tool running state
                setIsToolRunning(data.tool);

                // Create/update tool_use block (just for activity indicator)
                if (isDbTool) {
                  const existingDbOpsIndex = currentContent.findIndex(
                    c => c.type === 'tool_use' && c.toolName === 'database_ops'
                  );
                  if (existingDbOpsIndex < 0) {
                    currentContent = [
                      ...currentContent,
                      { type: 'tool_use', toolName: 'database_ops', toolText: '', isActive: true },
                    ];
                  } else {
                    currentContent = [
                      ...currentContent.slice(0, existingDbOpsIndex),
                      { ...currentContent[existingDbOpsIndex], isActive: true },
                      ...currentContent.slice(existingDbOpsIndex + 1),
                    ];
                  }
                }

                // Keep showing current text as regular text at the bottom
                const preservedContent = currentContent.filter(c => c.type === 'chart' || c.type === 'tool_use' || c.type === 'map' || c.type === 'html' || c.type === 'streaming_html');
                setMessages(prev => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: 'assistant',
                    content: currentText
                      ? [...preservedContent, { type: 'text', text: currentText }]
                      : preservedContent,
                  };
                  return updated;
                });
              } else if (data.type === 'tool_end') {
                setIsToolRunning(null);
              } else if (data.type === 'error') {
                setMessages(prev => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: 'assistant',
                    content: data.message || 'Sorry, an error occurred. Please try again.',
                  };
                  return updated;
                });
              }
            } catch {
              // Skip invalid JSON lines
            }
          }
        }
      }
    } catch (error) {
      // Don't show error message if request was aborted (e.g., user cleared chat)
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      console.error('Chat error:', error);
      setMessages(prev => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: 'assistant',
          content: 'Sorry, I encountered an error. Please try again.',
        };
        return updated;
      });
    } finally {
      setIsLoading(false);
      setIsToolRunning(null);
      abortControllerRef.current = null;
    }
  }, [inputValue, isLoading, messages]);

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
    setMessages([]);
    setIsLoading(false);
    setIsToolRunning(null);
    localStorage.removeItem(storageKey);
  };

  const handleExampleClick = (example: string) => {
    sendMessage(example);
  };

  return (
    <div className="chat-container">
      <header className="chat-header">
        <div className="chat-header-left">
                    <div>
            <div className="chat-title">Maude</div>
            <div className="chat-subtitle">Ask questions of business data in MotherDuck using a Claude-like interface.</div>
          </div>
        </div>
        {messages.length > 0 && (
          <button className="chat-clear" onClick={clearHistory}>
            Clear Chat
          </button>
        )}
      </header>

      <div className="chat-messages" ref={messagesContainerRef}>
        {messages.length === 0 ? (
          <div className="chat-welcome">
                        <h2><span className="welcome-full">Welcome to Maude</span><span className="welcome-short">Welcome</span></h2>
            <p>We've hooked up this interface to Claude and MotherDuck using the MotherDuck MCP Server. You have access to business data for a fictitious business, Eastlake, which manufactures and sells products to businesses. Start asking it some questions.</p>
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
                onChange={(e) => setIncludeMetadata(e.target.checked)}
              />
              <span className="toggle-slider"></span>
              <span className="toggle-label">Include metadata in prompt</span>
            </label>
          </div>
        ) : (
          messages.map((msg, idx) => {
            // Check if message has content
            const hasContent = typeof msg.content === 'string'
              ? msg.content.length > 0
              : msg.content.length > 0 && msg.content.some(block =>
                  (block.type === 'text' && block.text) ||
                  (block.type === 'chart' && block.chart) ||
                  (block.type === 'map' && block.map) ||
                  (block.type === 'html' && block.html) ||
                  (block.type === 'streaming_html' && block.htmlChunks) ||
                  (block.type === 'tool_use' && block.toolName && (block.toolText || block.isActive))
                );

            // Skip rendering empty messages
            if (!hasContent) return null;

            const ContentWrapper = msg.role === 'assistant' ? MaxWidthContainer : 'div';

            // Check if message contains HTML content (including streaming)
            const hasHtml = typeof msg.content !== 'string' && msg.content.some(block =>
              (block.type === 'html' && block.html) ||
              (block.type === 'streaming_html' && block.htmlChunks)
            );

            // Check if message is currently streaming HTML (not yet complete)
            const isStreamingHtml = typeof msg.content !== 'string' && msg.content.some(block =>
              block.type === 'streaming_html' && block.htmlChunks && !block.isComplete
            );

            return (
              <div key={idx} className={`chat-message chat-message-${msg.role}${hasHtml ? ' has-html' : ''}`}>
                <ContentWrapper className="chat-message-content">
                  {typeof msg.content === 'string' ? (
                    msg.role === 'assistant' ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{msg.content}</ReactMarkdown>
                    ) : (
                      msg.content
                    )
                  ) : (
                    msg.content.map((block, blockIdx) => {
                      if (block.type === 'text' && block.text) {
                        // Filter out HTML code blocks from text display
                        const displayText = filterHtmlFromText(block.text);
                        if (!displayText) return null;
                        return <ReactMarkdown key={blockIdx} remarkPlugins={[remarkGfm]} components={markdownComponents}>{displayText}</ReactMarkdown>;
                      }
                      if (block.type === 'chart' && block.chart) {
                        return <ChatChart key={blockIdx} spec={block.chart} />;
                      }
                      if (block.type === 'map' && block.map) {
                        return <ChatMap key={blockIdx} spec={block.map} />;
                      }
                      if (block.type === 'html' && block.html) {
                        return <HtmlFrame key={blockIdx} html={block.html} />;
                      }
                      if (block.type === 'streaming_html' && block.htmlChunks) {
                        return <StreamingHtmlFrame key={blockIdx} htmlChunks={block.htmlChunks} isComplete={block.isComplete || false} />;
                      }
                      if (block.type === 'tool_use' && block.toolName && (block.toolText || block.isActive)) {
                        return <ToolUseSection key={blockIdx} toolName={block.toolName} toolText={block.toolText || ''} isActive={block.isActive} isStreaming={isStreamingHtml} />;
                      }
                      return null;
                    })
                  )}
                </ContentWrapper>
              </div>
            );
          })
        )}
        {isLoading && (
          <div className="chat-loading-indicator">
            <span className="chat-loading-dot" />
            <span className="chat-loading-text">
              {isToolRunning ? 'Querying data' : 'Thinking'}
            </span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className={`chat-input-area${messages.length === 0 ? ' welcome' : ''}`}>
        <input
          ref={inputRef}
          type="text"
          className="chat-input"
          placeholder="Ask a question about your data..."
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isLoading}
        />
        <button
          className="chat-send"
          onClick={() => sendMessage()}
          disabled={isLoading || !inputValue.trim()}
          aria-label="Send message"
        >
          →
        </button>
      </div>
    </div>
  );
}
