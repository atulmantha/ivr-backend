function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildVoiceTwiML(greeting, aiReply) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${xmlEscape(greeting)}</Say>
  <Pause length="1"/>
  <Say voice="alice">${xmlEscape(aiReply)}</Say>
</Response>`;
}

module.exports = { buildVoiceTwiML };
