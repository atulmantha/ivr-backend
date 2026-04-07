const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GEMINI_API_KEY,
  PORT
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
  throw new Error(
    "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or GEMINI_API_KEY. Update .env using .env.example."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const chatModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

const requestedPort = Number(PORT) || 3000;
const hasExplicitPort = Boolean(PORT);

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toVoiceFriendlyResponse(text) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "I could not find that right now. Please try again.";
  }

  const sentences = normalized.match(/[^.!?]+[.!?]?/g) || [];
  const firstTwo = sentences.slice(0, 2).join(" ").trim();
  return firstTwo || normalized.slice(0, 220);
}

function twimlSay(message) {
  return `
    <Response>
      <Say>${escapeXml(message)}</Say>
    </Response>
  `;
}

async function generateEmbedding(text) {
  const input = String(text || "").trim();
  if (!input) {
    return null;
  }

  const result = await embeddingModel.embedContent(input);
  const embedding = result?.embedding?.values;

  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("Failed to generate embedding from Gemini.");
  }

  return embedding;
}

async function searchSimilar(queryEmbedding) {
  if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    return [];
  }

  const { data, error } = await supabase.rpc("match_knowledge", {
    query_embedding: queryEmbedding,
    match_count: 3
  });

  if (error) {
    if (error.code === "PGRST202") {
      throw new Error(
        "Supabase RPC 'match_knowledge' not found. Create it with ORDER BY embedding <-> query_embedding LIMIT 3."
      );
    }
    throw new Error(`Vector search failed: ${error.message}`);
  }

  return (data || [])
    .map((row) => row.content)
    .filter(Boolean)
    .slice(0, 3);
}

async function getAIResponse(query) {
  const cleanedQuery = String(query || "").trim();
  if (!cleanedQuery) {
    return "I did not catch that. Please tell me your issue again.";
  }

  const embedding = await generateEmbedding(cleanedQuery);
  const contextChunks = await searchSimilar(embedding);
  const context = contextChunks.length > 0
    ? contextChunks.join("\n\n")
    : "No relevant context found.";

  const prompt = [
    "Answer using the following context:",
    context,
    "",
    `User question: ${cleanedQuery}`,
    "",
    "Give a short spoken response.",
    "Keep it conversational and no more than 2 sentences."
  ].join("\n");

  const result = await chatModel.generateContent(prompt);
  const rawText = result?.response?.text?.() || "";

  return toVoiceFriendlyResponse(rawText);
}

app.post("/api/twilio/voice", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const { error } = await supabase.from("calls").insert({});
    if (error) {
      console.error("Failed to store call:", error.message);
    }

    res.send(`
      <Response>
        <Say>Welcome to AI support.</Say>
        <Gather input="speech" action="/api/twilio/process" method="POST">
          <Say>Please tell me your issue.</Say>
        </Gather>
      </Response>
    `);
  } catch (error) {
    console.error("Voice route error:", error.message);
    res.send(twimlSay("We are having trouble right now. Please try again shortly."));
  }
});

app.post("/api/twilio/process", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const userInput = String(req.body.SpeechResult || "").trim();

    const { error: userInsertError } = await supabase.from("messages").insert({
      role: "user",
      content: userInput
    });
    if (userInsertError) {
      console.error("Failed to store user message:", userInsertError.message);
    }

    const aiResponse = await getAIResponse(userInput);

    const { error: assistantInsertError } = await supabase.from("messages").insert({
      role: "assistant",
      content: aiResponse
    });
    if (assistantInsertError) {
      console.error("Failed to store assistant message:", assistantInsertError.message);
    }

    res.send(twimlSay(aiResponse));
  } catch (error) {
    console.error("Process route error:", error.message);
    res.send(twimlSay("I hit a small issue. Please ask again in a moment."));
  }
});

function startServer(port) {
  const server = app.listen(port, () => console.log(`Server running on ${port}`));

  server.on("error", (error) => {
    if (error.code !== "EADDRINUSE") {
      throw error;
    }

    if (hasExplicitPort) {
      console.error(
        `Port ${port} is already in use. Stop the other process or set a different PORT in .env.`
      );
      process.exit(1);
    }

    const nextPort = port + 1;
    console.warn(`Port ${port} is busy. Retrying on ${nextPort}...`);
    startServer(nextPort);
  });
}

if (require.main === module) {
  startServer(requestedPort);
}

module.exports = {
  app,
  startServer,
  generateEmbedding,
  searchSimilar,
  getAIResponse
};
