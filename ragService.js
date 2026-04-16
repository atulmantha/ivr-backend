const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

const replyModel = genAI.getGenerativeModel({
  model: "gemini-2.0-flash-lite",
  generationConfig: { maxOutputTokens: 150, temperature: 0.3 },
});

async function generateEmbedding(text) {
  const input = String(text || "").trim();
  if (!input) return null;

  const result = await embeddingModel.embedContent(input);
  const values = result?.embedding?.values;

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

async function generateSuggestedReply(userInput, contextChunks, tier = "Regular") {
  const context =
    contextChunks.length > 0
      ? contextChunks.join("\n\n")
      : null;

  const prompt = [
    `You are coaching a call center agent. A ${tier} tier customer said:`,
    `"${userInput}"`,
    "",
    context
      ? `Relevant knowledge base context:\n${context}`
      : "No specific knowledge base context found.",
    "",
    "Write the exact words the agent should say in response.",
    "1-2 sentences. Professional, empathetic, and direct.",
    "Return only the reply text — no labels, no quotes.",
  ].join("\n");

  const result = await replyModel.generateContent(prompt);
  return (result?.response?.text?.() || "").trim();
}

module.exports = { generateEmbedding, searchKnowledge, generateSuggestedReply };
