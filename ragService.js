const GEMINI_GENERATE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const GEMINI_EMBED_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent";

const EMBEDDING_DIMS = 768;

async function generateEmbedding(text) {
  const input = String(text || "").trim();
  if (!input) return null;

  const key = process.env.GEMINI_API_KEY;
  const res = await fetch(`${GEMINI_EMBED_URL}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text: input }], role: "user" },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: EMBEDDING_DIMS,
    }),
  });

  if (!res.ok) throw new Error(`Gemini embed API ${res.status}`);
  const data = await res.json();
  const values = data.embedding?.values;

  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Empty embedding returned.");
  }

  return values;
}

async function searchKnowledge(supabase, embedding) {
  if (!Array.isArray(embedding) || embedding.length === 0) return [];

  const { data, error } = await supabase.rpc("match_knowledge", {
    query_embedding: embedding,
    match_count: 3,
  });

  if (error) {
    if (error.code !== "PGRST202") {
      console.warn("Knowledge search error:", error.message);
    }
    return [];
  }

  return (data || []).map((r) => r.content).filter(Boolean);
}

async function generateGreeting(customerName, tier = "Regular") {
  const name = String(customerName || "").trim();
  if (!name) return null;

  const prompt = [
    `You are a call center agent greeting a ${tier} tier customer at the start of a support call.`,
    `Customer name: ${name}`,
    "",
    "Write a warm, professional opening greeting for the agent to say.",
    "Rules:",
    "- Maximum 2 sentences.",
    "- Use the customer's first name.",
    "- Do NOT mention any company name.",
    "- Keep it natural and conversational — not robotic.",
    "- Voice-friendly: short, clear sentences.",
    "Return only the greeting text — no labels, no quotes, no preamble.",
  ].join("\n");

  const key = process.env.GEMINI_API_KEY;
  try {
    const res = await fetch(`${GEMINI_GENERATE_URL}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 80, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API ${res.status}`);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    return text || `Hello ${name}, thank you for calling. How can I assist you today?`;
  } catch {
    return `Hello ${name}, thank you for calling. How can I assist you today?`;
  }
}

async function generateSuggestedReply(
  userInput,
  contextChunks,
  tier = "Regular",
  customerData = null,
  emotion = "calm",
  conversationHistory = []
) {
  const context = contextChunks.length > 0 ? contextChunks.join("\n\n") : null;

  const accountLines = [];
  if (customerData?.name)           accountLines.push(`Customer name: ${customerData.name}`);
  if (customerData?.tier)           accountLines.push(`Tier: ${customerData.tier}`);
  if (customerData?.billingContext) accountLines.push(`Recent bills:\n${customerData.billingContext}`);
  const accountSection = accountLines.length > 0
    ? `Customer account information:\n${accountLines.join("\n")}`
    : null;

  const isAngry = emotion === "angry" || emotion === "frustrated";
  const isConfused = emotion === "confused";
  let toneInstruction;
  if (isAngry) {
    toneInstruction = [
      `IMPORTANT — The customer is ${emotion}. Open with a sincere empathy statement such as:`,
      `"I completely understand your frustration, and I sincerely apologize for any inconvenience caused."`,
      `"I'm truly sorry you're going through this — let me resolve it for you right away."`,
      `Then immediately give the concrete answer or resolution. Do not over-apologize — one empathy line, then the answer.`,
    ].join("\n");
  } else if (isConfused) {
    toneInstruction = "The customer seems confused. Be reassuring and patient. Walk through the answer step by step in plain language.";
  } else {
    toneInstruction = "Use a warm, professional, and helpful tone throughout.";
  }

  const historySection = conversationHistory.length > 0
    ? `Recent conversation (oldest first):\n${conversationHistory
        .map((m) => `${m.role === "user" ? "Customer" : "Agent"}: ${m.content}`)
        .join("\n")}`
    : null;

  const customerFirstName = (customerData?.name || "").split(" ")[0] || null;

  const prompt = [
    `You are coaching a call center agent handling a ${tier} tier customer.`,
    `Customer emotion: ${emotion}`,
    "",
    historySection || "",
    `The customer's LATEST question: "${userInput}"`,
    "",
    accountSection || "",
    context
      ? `Retrieved account / knowledge base data:\n${context}`
      : "No specific account data found in the knowledge base.",
    "",
    toneInstruction,
    "",
    "Write the exact words the agent should say to the customer.",
    "Rules:",
    "- Answer ONLY the customer's LATEST question. Do NOT repeat or re-state information that was already given earlier in the conversation above.",
    "- Do NOT start with 'Hello', 'Hi', or any greeting — go straight to addressing the concern.",
    "- Give a clear, helpful answer in 2-4 sentences. Include all relevant figures, dates, or details from the data above — do not be vague.",
    "- If the data contains specific values (amounts, dates, usage figures, charges), quote them explicitly.",
    "- If the customer asked about something (e.g. energy consumption, specific charges) and that information is NOT in the data above, say so clearly and offer to escalate or investigate further — do NOT substitute an answer about something else.",
    "- NEVER say 'I will look that up', 'let me check', or 'one moment' if the data is already present above — use it directly.",
    customerFirstName
      ? `- Use the customer's first name (${customerFirstName}) at most ONCE in the reply, only if it sounds natural. Do not use it in every sentence.`
      : "- Do not address the customer by name.",
    "Return only the agent's reply text — no labels, no quotes, no preamble.",
  ].filter((line) => line !== "").join("\n");

  const key = process.env.GEMINI_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  let res;
  try {
    res = await fetch(`${GEMINI_GENERATE_URL}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`Gemini API ${res.status}`);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

async function generateClosingMessage(customerName, tier = "Regular", conversationTranscript, originalIssue) {
  const name = String(customerName || "").trim();
  const firstName = name.split(" ")[0] || null;

  const prompt = [
    `You are a call center agent wrapping up a support call with a ${tier} tier customer.`,
    name ? `Customer name: ${name}` : "",
    originalIssue ? `The customer originally called about: ${originalIssue}` : "",
    conversationTranscript ? `Conversation so far:\n${conversationTranscript}` : "",
    "",
    "Based on the customer conversation and resolved issue, generate a short professional closing message for the agent to say.",
    "The message should:",
    "- Acknowledge the issue resolution",
    "- Thank the customer for contacting support",
    "- Ask if they need any further help",
    "- End politely and professionally",
    "",
    "Rules:",
    "- 2–3 sentences maximum.",
    firstName ? `- Address the customer by first name (${firstName}).` : "- Do not address the customer by name.",
    "- Voice-friendly: warm and natural, not robotic.",
    "- Do NOT mention any company name.",
    "Return only the closing message text — no labels, no quotes, no preamble.",
  ].filter(Boolean).join("\n");

  const key = process.env.GEMINI_API_KEY;
  const fallback = firstName
    ? `I'm glad we could get that resolved for you, ${firstName}. Thank you so much for contacting us — is there anything else I can help you with today?`
    : "I'm glad we could resolve that for you. Thank you for contacting support — is there anything else I can help you with today?";

  try {
    const res = await fetch(`${GEMINI_GENERATE_URL}?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 120, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API ${res.status}`);
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

module.exports = { generateEmbedding, searchKnowledge, generateSuggestedReply, generateGreeting, generateClosingMessage };
