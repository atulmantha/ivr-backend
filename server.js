const express = require('express');
const {
  getCustomerByPhone,
  getCustomerById,
  getCustomerByEmail,
  incrementCustomerCalls,
  getPersonalization,
} = require('./lib/backend/customerService');
const { buildGeminiPrompt, generateGeminiReply } = require('./lib/backend/geminiService');
const { insertCallRecord } = require('./lib/backend/callService');
const { buildVoiceTwiML } = require('./lib/backend/twiml');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

async function handleVoiceWebhook(req, res) {
  const fromPhone = req.body?.From || '';
  const callSid = req.body?.CallSid || null;
  const userInput = req.body?.SpeechResult || req.body?.Body || 'Hello';

  try {
    const customer = await getCustomerByPhone(fromPhone);

    const personalization = getPersonalization(customer, fromPhone);
    const prompt = buildGeminiPrompt({ personalization, userInput });

    let aiReply = 'How can I help you today?';
    try {
      aiReply = await generateGeminiReply(prompt, {
        maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 64,
        maxSentences: Number(process.env.GEMINI_MAX_SENTENCES) || 2,
        maxChars: Number(process.env.GEMINI_MAX_CHARS) || 180,
      });
    } catch (aiError) {
      console.error('Gemini error:', aiError.message);
    }

    const twiml = buildVoiceTwiML(personalization.greeting, aiReply);
    res.type('text/xml').status(200).send(twiml);

    // Keep Twilio latency low by moving bookkeeping out of the response path.
    Promise.allSettled([
      customer?.id ? incrementCustomerCalls(customer.id, customer.total_calls) : Promise.resolve(),
      insertCallRecord({
        existingCallData: {
          call_sid: callSid,
        },
        customerName: personalization.customerName,
        customerPhone: personalization.customerPhone,
        tier: personalization.tier,
      }),
    ]).then((results) => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          const label = index === 0 ? 'Customer call count update' : 'Call insert';
          console.error(`${label} error:`, result.reason?.message || result.reason);
        }
      });
    });
  } catch (error) {
    console.error('Voice webhook error:', error.message);

    const fallbackTwiML = buildVoiceTwiML(
      'Hello. Thank you for calling us.',
      'We are facing a temporary issue, but your call is important to us.'
    );

    res.type('text/xml').status(200).send(fallbackTwiML);
  }
}

app.post('/api/twilio/voice', handleVoiceWebhook);
app.post('/process', handleVoiceWebhook);

app.get('/api/customer-details', async (req, res) => {
  const phone = String(req.query?.phone || '').trim();
  const id = String(req.query?.id || '').trim();
  const email = String(req.query?.email || '').trim();

  if (!phone && !id && !email) {
    return res
      .status(400)
      .json({ error: 'Provide at least one query parameter: id, email, or phone.' });
  }

  try {
    let customer = null;

    if (phone) {
      customer = await getCustomerByPhone(phone);
    } else if (id) {
      customer = await getCustomerById(id);
    } else if (email) {
      customer = await getCustomerByEmail(email);
    }

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found.' });
    }

    return res.status(200).json({ customer });
  } catch (error) {
    console.error('Customer details route error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch customer details.' });
  }
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(port, () => {
  console.log(`IVR backend listening on port ${port}`);
});
