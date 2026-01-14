import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

// Model configurations
const SONNET_MODEL = 'claude-sonnet-4-20250514';
const HAIKU_MODEL = 'claude-haiku-4-20250514';
const OPUS_MODEL = 'claude-opus-4-20250514';

interface SuggestionsRequest {
  question: string;
  context: string; // Narration, SQL queries, or summary of the answer
  model?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: SuggestionsRequest = await request.json();
    const { question, context, model } = body;

    if (!question || !context) {
      return NextResponse.json(
        { error: 'Missing required fields: question and context' },
        { status: 400 }
      );
    }

    // Select model - default to same as chat, but configurable
    let selectedModel = SONNET_MODEL;
    if (model === 'opus') {
      selectedModel = OPUS_MODEL;
    } else if (model === 'haiku') {
      selectedModel = HAIKU_MODEL;
    } else if (model === 'sonnet') {
      selectedModel = SONNET_MODEL;
    }

    const anthropic = new Anthropic();

    const systemPrompt = `You are a helpful assistant that generates follow-up questions based on a data analysis conversation. Your task is to suggest 4 insightful follow-up questions that would help the user understand the data better or explore related aspects.

Guidelines:
- Questions should be specific and actionable
- Questions should build on what was already discussed
- Questions should help uncover deeper insights or related patterns
- Keep questions concise (under 15 words each)
- Focus on business value and actionable insights
- Vary the types of questions (trends, comparisons, breakdowns, anomalies)

Respond with ONLY a JSON array of 4 strings, no other text. Example:
["What is the trend over time?", "How does this compare to last year?", "Which region contributes most?", "Are there any outliers?"]`;

    const userPrompt = `Based on this data analysis conversation, suggest 4 follow-up questions:

**Original Question:**
${question}

**Analysis Context:**
${context}

Respond with only a JSON array of 4 question strings.`;

    const response = await anthropic.messages.create({
      model: selectedModel,
      max_tokens: 500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // Extract text content from response
    const textBlock = response.content.find(block => block.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error('No text response from model');
    }

    // Parse the JSON array from the response
    const responseText = textBlock.text.trim();

    // Try to extract JSON array from the response
    let suggestions: string[] = [];
    try {
      // First try direct parse
      suggestions = JSON.parse(responseText);
    } catch {
      // Try to find JSON array in the response
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        suggestions = JSON.parse(jsonMatch[0]);
      }
    }

    // Validate we have an array of strings
    if (!Array.isArray(suggestions) || suggestions.length === 0) {
      throw new Error('Invalid response format');
    }

    // Ensure we have exactly 4 suggestions, trim if more
    suggestions = suggestions.slice(0, 4);

    return NextResponse.json({ suggestions });
  } catch (error) {
    console.error('[Suggestions API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to generate suggestions' },
      { status: 500 }
    );
  }
}
