function buildGeminiPrompt({ personalization, userInput }) {
  return [
    personalization.aiSystemContext,
    `Customer says: ${userInput}`,
    'Reply in 1 short, voice-friendly sentence when possible.',
    'Use plain language and be direct.',
    'Maximum 25 words.',
    'Do not use lists, markdown, or long explanations.',
  ].join('\n\n');
}

function makeConciseReply(text, options = {}) {
  const maxSentences = Number(options.maxSentences) || 2;
  const maxChars = Number(options.maxChars) || 180;

  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return 'I can help with that.';
  }

  const sentences = normalized.match(/[^.!?]+[.!?]?/g) || [normalized];
  let concise = sentences.slice(0, maxSentences).join(' ').trim();

  if (concise.length > maxChars) {
    concise = concise.slice(0, maxChars).trim();
    const lastPunctuation = Math.max(
      concise.lastIndexOf('.'),
      concise.lastIndexOf('!'),
      concise.lastIndexOf('?')
    );

    if (lastPunctuation > 20) {
      concise = concise.slice(0, lastPunctuation + 1).trim();
    } else {
      concise = `${concise.replace(/[,.!?;:\s]+$/, '')}.`;
    }
  }

  return concise;
}

async function generateGeminiReply(prompt, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS) || 3500;

  if (!apiKey) {
    return 'I can help you with your request. Please tell me what you need.';
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          generationConfig: {
            maxOutputTokens: options.maxOutputTokens || 64,
            temperature: options.temperature ?? 0.3,
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API failed with status ${response.status}`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    return makeConciseReply(text || 'I can help with that. Could you share a bit more detail?', {
      maxSentences: options.maxSentences,
      maxChars: options.maxChars,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Gemini API timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

module.exports = { buildGeminiPrompt, generateGeminiReply };
