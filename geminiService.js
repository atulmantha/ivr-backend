function buildGeminiPrompt({ personalization, userInput }) {
  return `${personalization.aiSystemContext}\n\nCustomer says: ${userInput}\n\nRespond briefly and helpfully for a voice IVR flow.`;
}

async function generateGeminiReply(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

  if (!apiKey) {
    return 'I can help you with your request. Please tell me what you need.';
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
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

  return text || 'I can help with that. Could you share a bit more detail?';
}

module.exports = { buildGeminiPrompt, generateGeminiReply };
