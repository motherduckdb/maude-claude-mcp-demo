import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/planetscale';

interface ShareRow {
  id: string;
  html_content: string;
  model: string | null;
  created_at: Date;
  expires_at: Date;
}

// Generate chat overlay HTML with embedded model
function generateChatOverlay(model: string | null): string {
  return `
<style>
  .maude-chat-overlay {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 10000;
    font-family: Georgia, 'Times New Roman', serif;
  }
  .maude-chat-box {
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.15), 0 0 0 1px rgba(0, 0, 0, 0.05);
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 400px;
    max-width: 600px;
  }
  @media (max-width: 640px) {
    .maude-chat-box {
      min-width: calc(100vw - 48px);
      max-width: calc(100vw - 48px);
    }
  }
  .maude-chat-input {
    flex: 1;
    border: none;
    outline: none;
    font-size: 15px;
    font-family: Georgia, 'Times New Roman', serif;
    color: #383838;
    background: transparent;
    padding: 8px 0;
  }
  .maude-chat-input::placeholder {
    color: #999;
  }
  .maude-chat-submit {
    background: #383838;
    color: white;
    border: none;
    border-radius: 10px;
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 500;
    font-family: Georgia, 'Times New Roman', serif;
    cursor: pointer;
    transition: background 0.15s ease;
    white-space: nowrap;
  }
  .maude-chat-submit:hover {
    background: #4a4a4a;
  }
  .maude-chat-submit:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  .maude-chat-icon {
    color: #666;
    flex-shrink: 0;
  }
</style>
<div class="maude-chat-overlay">
  <form class="maude-chat-box" id="maude-chat-form">
    <svg class="maude-chat-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    </svg>
    <input type="text" class="maude-chat-input" id="maude-chat-input" placeholder="Ask questions about this data..." autocomplete="off" />
    <button type="submit" class="maude-chat-submit">Ask</button>
  </form>
</div>
<script>
(function() {
  // Model is embedded from database (works for all shares, old and new)
  var REPORT_MODEL = ${JSON.stringify(model || '')};

  var form = document.getElementById('maude-chat-form');
  var input = document.getElementById('maude-chat-input');

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    var question = input.value.trim();
    if (!question) return;

    // Extract share ID from current URL path (e.g., /share/abc123)
    var pathParts = window.location.pathname.split('/');
    var shareId = pathParts[pathParts.length - 1];

    // Redirect to main app with question, share ID, and model
    var baseUrl = window.location.origin;
    var params = new URLSearchParams();
    params.set('q', question);
    if (shareId) params.set('shareId', shareId);
    if (REPORT_MODEL) params.set('model', REPORT_MODEL);

    window.location.href = baseUrl + '/?' + params.toString();
  });
})();
</script>
`;
}

// Inject chat overlay before </body> or at end of HTML
function injectChatOverlay(html: string, model: string | null): string {
  const chatOverlay = generateChatOverlay(model);
  const bodyCloseIndex = html.toLowerCase().lastIndexOf('</body>');
  if (bodyCloseIndex !== -1) {
    return html.slice(0, bodyCloseIndex) + chatOverlay + html.slice(bodyCloseIndex);
  }
  // If no </body>, append at end
  return html + chatOverlay;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const isEmbed = searchParams.get('embed') === '1';

  try {
    const result = await query<ShareRow>(
      `SELECT id, html_content, model, created_at, expires_at
       FROM shares
       WHERE id = $1 AND expires_at > NOW()`,
      [id]
    );

    if (result.rows.length === 0) {
      return new NextResponse(
        `<!DOCTYPE html>
<html>
<head>
  <title>Not Found</title>
  <style>
    body { font-family: Georgia, serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f8f8f7; }
    .error { text-align: center; color: #383838; }
    h1 { font-size: 48px; margin-bottom: 16px; }
    p { color: #666; }
  </style>
</head>
<body>
  <div class="error">
    <h1>404</h1>
    <p>This share link has expired or does not exist.</p>
  </div>
</body>
</html>`,
        {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        }
      );
    }

    const share = result.rows[0];
    // Only inject chat overlay for standalone view, not embedded
    const finalHtml = isEmbed ? share.html_content : injectChatOverlay(share.html_content, share.model);

    return new NextResponse(finalHtml, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
      },
    });
  } catch (error) {
    console.error('[Share] Error fetching share:', error);

    return new NextResponse(
      `<!DOCTYPE html>
<html>
<head>
  <title>Error</title>
  <style>
    body { font-family: Georgia, serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f8f8f7; }
    .error { text-align: center; color: #383838; }
    h1 { font-size: 48px; margin-bottom: 16px; }
    p { color: #666; }
  </style>
</head>
<body>
  <div class="error">
    <h1>Error</h1>
    <p>Something went wrong. Please try again later.</p>
  </div>
</body>
</html>`,
      {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      }
    );
  }
}
