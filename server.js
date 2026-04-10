const express = require("express");
const { randomUUID } = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GEMINI_API_KEY,
  APP_BASE_URL,
  PORT
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
  throw new Error(
    "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or GEMINI_API_KEY. Update .env using .env.example."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const chatModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    maxOutputTokens: 1024,
    temperature: 0.5
  }
});
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
  const firstThree = sentences.slice(0, 3).join(" ").trim();
  return firstThree || normalized;
}

function looksIncompleteResponse(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) {
    return true;
  }

  const danglingEndings = [" a", " an", " the", " or", " and", " to", " of", " for"];
  return value.length < 20 || danglingEndings.some((end) => value.endsWith(end));
}

function twimlSay(message) {
  return `
    <Response>
      <Say>${escapeXml(message)}</Say>
    </Response>
  `;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function getProcessActionUrl(req, callId) {
  const base = (APP_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
  const url = new URL(`${base}/api/twilio/process`);
  if (callId) {
    url.searchParams.set("call_id", callId);
  }
  return url.toString();
}

function shouldUseRag(query) {
  const text = String(query || "").toLowerCase();
  const defaultKeywords = [
    "office",
    "hours",
    "support",
    "policy",
    "billing",
    "refund",
    "account",
    "password",
    "service",
    "product",
    "plan"
  ];
  const extraKeywords = String(process.env.RAG_KEYWORDS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const keywords = [...new Set([...defaultKeywords, ...extraKeywords])];
  return keywords.some((keyword) => text.includes(keyword));
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

async function getAIResponseWithTimeout(query, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await getAIResponse(query, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutHandle);
  }
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
      console.warn("Supabase RPC 'match_knowledge' not found. Continuing without RAG context.");
      return [];
    }
    console.warn(`Vector search failed. Continuing without RAG context: ${error.message}`);
    return [];
  }

  return (data || [])
    .map((row) => row.content)
    .filter(Boolean)
    .slice(0, 3);
}

async function getContextForQuery(query) {
  if (!shouldUseRag(query)) {
    return [];
  }

  const timeoutMs = Number(process.env.RAG_CONTEXT_TIMEOUT_MS) || 2500;
  const ragPromise = (async () => {
    const embedding = await generateEmbedding(query);
    return searchSimilar(embedding);
  })();

  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => resolve([]), timeoutMs);
  });

  return Promise.race([ragPromise, timeoutPromise]);
}

async function getAIResponse(query, options = {}) {
  const cleanedQuery = String(query || "").trim();
  if (!cleanedQuery) {
    return "I did not catch that. Please tell me your issue again.";
  }

  let contextChunks = [];
  try {
    contextChunks = await getContextForQuery(cleanedQuery);
  } catch (error) {
    console.warn(`Embedding/search unavailable, using general response only: ${error.message}`);
  }

  const context = contextChunks.length > 0
    ? contextChunks.join("\n\n")
    : "No relevant context found.";

  const prompt = [
    "You are a voice assistant.",
    "Use the provided context if it is relevant and helpful.",
    "If the context is missing or unrelated, answer from general knowledge.",
    "For real-time questions (like current weather), answer with a brief best-effort response and mention it may change.",
    "Always return complete, natural sentences. Do not end mid-phrase.",
    "",
    `Question: ${cleanedQuery}`,
    `Context: ${context || "No context available"}`,
    "",
    "Return a clear conversational answer suitable for voice."
  ].join("\n");

  const result = await chatModel.generateContent(prompt, options);
  let rawText = result?.response?.text?.() || "";

  if (looksIncompleteResponse(rawText)) {
    const repairPrompt = [
      "Rewrite this as a complete, natural voice response in 1-2 sentences.",
      `Original: ${rawText || cleanedQuery}`
    ].join("\n");
    const repairResult = await chatModel.generateContent(repairPrompt, options);
    rawText = repairResult?.response?.text?.() || rawText;
  }

  return toVoiceFriendlyResponse(rawText);
}

app.post("/api/twilio/voice", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    const welcomeMessage = "Welcome to AI support.";
    const callId = randomUUID();
    const processActionUrl = getProcessActionUrl(req, callId);

    const { error } = await supabase.from("calls").insert({ id: callId });
    if (error) {
      console.error("Failed to store call:", error.message);
    }
    const { error: welcomeInsertError } = await supabase.from("messages").insert({
      call_id: callId,
      role: "assistant",
      content: welcomeMessage
    });
    if (welcomeInsertError) {
      console.error("Failed to store welcome message:", welcomeInsertError.message);
    }

    res.send(`
      <Response>
        <Say>${escapeXml(welcomeMessage)}</Say>
        <Gather input="speech" action="${escapeXml(processActionUrl)}" method="POST">
          <Say>Please tell me your issue.</Say>
        </Gather>
      </Response>
    `);
  } catch (error) {
    console.error("Voice route error:", error.message);
    res.send(twimlSay("We are having trouble right now. Please try again shortly."));
  }
});

app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

app.post("/api/twilio/process", async (req, res) => {
  res.set("Content-Type", "text/xml");

  try {
    console.log("🔥 /api/twilio/process hit");
    console.log("Twilio body:", req.body);
    console.log("Twilio query:", req.query);

    const userInput = String(req.body.SpeechResult || "No speech detected").trim();
    const incomingCallId = String(req.query.call_id || "").trim();
    const callId = isUuid(incomingCallId) ? incomingCallId : randomUUID();

    if (!isUuid(incomingCallId)) {
      console.warn("Missing/invalid call_id query param. Generated fallback call_id.");
      const { error: fallbackCallError } = await supabase.from("calls").insert({ id: callId });
      if (fallbackCallError) {
        console.error("Failed to create fallback call row:", fallbackCallError.message);
      }
    }

    const userMessage = {
      call_id: callId,
      role: "user",
      content: userInput
    };

    const { error: userInsertError } = await supabase.from("messages").insert(userMessage);
    if (userInsertError) {
      console.error("Failed to store user message:", userInsertError.message);
    }

    let aiResponse = "Sorry, I couldn't process your request. Please try again.";
    try {
      const timeoutMs = Number(process.env.AI_TIMEOUT_MS) || 15000;
      const result = await getAIResponseWithTimeout(userInput, timeoutMs);
      if (result) {
        aiResponse = result;
      }
    } catch (error) {
      console.error("AI error:", error);
    }

    const assistantMessage = {
      call_id: callId,
      role: "assistant",
      content: aiResponse
    };

    const { error: assistantInsertError } = await supabase.from("messages").insert(assistantMessage);
    if (assistantInsertError) {
      console.error("Failed to store assistant message:", assistantInsertError.message);
    }

    const nextActionUrl = getProcessActionUrl(req, callId);
    res.send(`
      <Response>
        <Say>${escapeXml(aiResponse)}</Say>
        <Gather input="speech" action="${escapeXml(nextActionUrl)}" method="POST" timeout="10" speechTimeout="auto">
          <Say>What else can I help with?</Say>
        </Gather>
        <Say>I did not hear anything. Thanks for calling. Goodbye.</Say>
      </Response>
    `);
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
