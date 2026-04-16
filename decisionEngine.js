const { GoogleGenerativeAI } = require("@google/generative-ai");
const { EMOTIONS, normalizeEmotion } = require("./emotionService");
const { normalizeIntent, isHighStakesIntent } = require("./intentService");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash-lite",
  generationConfig: { maxOutputTokens: 300, temperature: 0.2 },
});

function buildAnalysisPrompt(userInput, tier) {
  return [
    "You are an AI assistant for call center agents. Analyze the customer speech below.",
    `Customer tier: ${tier || "Regular"}`,
    `Customer said: "${userInput}"`,
    "",
    "Return ONLY valid JSON — no markdown, no code blocks, no explanation:",
    JSON.stringify({
      emotion: "<calm|confused|frustrated|angry>",
      intent: "<snake_case intent e.g. billing_issue, payment_issue, cancellation, complaint, technical_support, account_inquiry, refund_request, general_inquiry>",
      suggested_actions: ["<specific action for human agent>", "<action2>", "<action3>"],
    }),
    "",
    "Rules:",
    "- emotion: exactly one of calm, confused, frustrated, angry",
    "- intent: snake_case label that best describes the customer's issue",
    "- suggested_actions: 2-3 specific, actionable steps the human agent should take right now",
  ].join("\n");
}

function computePriority(emotion, intent, tier) {
  const tierLower = String(tier || "").toLowerCase();
  const isHighTier = tierLower === "platinum" || tierLower === "gold";
  const isAngry = emotion === "angry";
  const isFrustrated = emotion === "frustrated";
  const highStakes = isHighStakesIntent(intent);

  if (isAngry || (isFrustrated && highStakes) || (isHighTier && isAngry)) {
    return "high";
  }
  if (isFrustrated || (isHighTier && highStakes) || (highStakes && emotion !== "calm")) {
    return "medium";
  }
  return "low";
}

async function analyzeCustomerSpeech(userInput, customerTier = "Regular") {
  const prompt = buildAnalysisPrompt(userInput, customerTier);
  const timeoutMs = Number(process.env.AI_TIMEOUT_MS) || 5000;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await model.generateContent(prompt, { signal: controller.signal });
    const raw = result?.response?.text?.() || "";

    // Strip markdown code fences if model adds them
    const cleaned = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const emotion = normalizeEmotion(parsed.emotion);
    const intent = normalizeIntent(parsed.intent);
    const suggested_actions = Array.isArray(parsed.suggested_actions)
      ? parsed.suggested_actions.filter(Boolean).slice(0, 3)
      : ["Listen carefully", "Address the customer's concern", "Offer an appropriate solution"];
    const priority = computePriority(emotion, intent, customerTier);

    return { emotion, intent, priority, suggested_actions };
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn("analyzeCustomerSpeech timed out");
    } else {
      console.warn("analyzeCustomerSpeech error:", error.message);
    }
    return {
      emotion: "calm",
      intent: "general_inquiry",
      priority: "low",
      suggested_actions: [
        "Listen to the customer carefully",
        "Address their concern directly",
        "Offer an appropriate solution",
      ],
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

module.exports = { analyzeCustomerSpeech };
