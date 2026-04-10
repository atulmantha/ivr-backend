const { supabase } = require('./supabaseAdmin');

async function insertCallRecord({
  existingCallData = {},
  customerName,
  customerPhone,
  tier,
}) {
  const { error } = await supabase.from('calls').insert({
    ...existingCallData,
    customer_name: customerName,
    customer_phone: customerPhone,
    tier,
  });

  if (error) {
    throw new Error(`Failed to insert call record: ${error.message}`);
  }
}

module.exports = { insertCallRecord };
