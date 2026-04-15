const { supabase } = require('./supabaseAdmin');
const customerCache = new Map();
const CUSTOMER_CACHE_TTL_MS = Number(process.env.CUSTOMER_CACHE_TTL_MS) || 5 * 60 * 1000;

function normalizePhone(phone) {
  return String(phone || '').trim();
}

function buildPhoneVariants(phone) {
  const raw = normalizePhone(phone);
  if (!raw) return [];

  const digitsOnly = raw.replace(/\D/g, '');
  const variants = new Set([raw]);

  if (digitsOnly) {
    variants.add(digitsOnly);
    variants.add(`+${digitsOnly}`);

    if (digitsOnly.length === 10) {
      variants.add(`1${digitsOnly}`);
      variants.add(`+1${digitsOnly}`);
    }

    if (digitsOnly.length > 10) {
      const lastTen = digitsOnly.slice(-10);
      variants.add(lastTen);
      variants.add(`1${lastTen}`);
      variants.add(`+1${lastTen}`);
    }
  }

  return Array.from(variants);
}

function getCachedCustomer(phoneVariants) {
  const now = Date.now();

  for (const variant of phoneVariants) {
    const cached = customerCache.get(variant);
    if (!cached) continue;

    if (cached.expiresAt <= now) {
      customerCache.delete(variant);
      continue;
    }

    return cached.customer;
  }

  return null;
}

function cacheCustomer(phoneVariants, customer) {
  const expiresAt = Date.now() + CUSTOMER_CACHE_TTL_MS;

  for (const variant of phoneVariants) {
    customerCache.set(variant, { customer, expiresAt });
  }
}

async function getCustomerByPhone(phone) {
  const phoneVariants = buildPhoneVariants(phone);
  if (phoneVariants.length === 0) return null;

  const cachedCustomer = getCachedCustomer(phoneVariants);
  if (cachedCustomer) {
    return cachedCustomer;
  }

  const lastTen = phoneVariants
    .map((value) => value.replace(/\D/g, ''))
    .find((digits) => digits.length >= 10)
    ?.slice(-10);

  const escapedVariants = phoneVariants.map((value) => value.replace(/,/g, '\\,'));
  const exactFilters = escapedVariants.map((value) => `phone.eq.${value}`);
  const fuzzyFilters = lastTen ? [`phone.ilike.%${lastTen}%`] : [];
  const orFilter = [...exactFilters, ...fuzzyFilters].join(',');

  const { data, error } = await supabase
    .from('customers')
    .select('id, phone, name, years_as_customer, tier, total_calls, created_at')
    .or(orFilter)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`Failed to fetch customer: ${error.message}`);
  }

  const customer = data?.[0] || null;
  if (customer) {
    cacheCustomer(phoneVariants, customer);
  }

  return customer;
}

async function getCustomerById(customerId) {
  const id = normalizePhone(customerId);
  if (!id) return null;

  const { data, error } = await supabase
    .from('customers')
    .select('id, phone, name, years_as_customer, tier, total_calls, created_at')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to fetch customer by id: ${error.message}`);
  }

  return data || null;
}

async function getCustomerByEmail(email) {
  const normalizedEmail = normalizePhone(email);
  if (!normalizedEmail) return null;

  const { data, error } = await supabase
    .from('customers')
    .select('id, phone, name, years_as_customer, tier, total_calls, created_at')
    .eq('email', normalizedEmail)
    .maybeSingle();

  // If email column does not exist, return null without breaking IVR flow.
  if (error && error.code === '42703') {
    return null;
  }

  if (error) {
    throw new Error(`Failed to fetch customer by email: ${error.message}`);
  }

  return data || null;
}

async function incrementCustomerCalls(customerId, currentTotalCalls) {
  if (!customerId) return;

  const nextTotalCalls = Number(currentTotalCalls || 0) + 1;

  const { error } = await supabase
    .from('customers')
    .update({ total_calls: nextTotalCalls })
    .eq('id', customerId);

  if (error) {
    throw new Error(`Failed to increment customer calls: ${error.message}`);
  }

  // Clear stale cached rows after mutation.
  for (const [key, value] of customerCache.entries()) {
    if (value.customer?.id === customerId) {
      customerCache.delete(key);
    }
  }
}

function getPersonalization(customer, fallbackPhone) {
  if (customer) {
    const customerName = customer.name || 'Customer';
    const tier = customer.tier || 'Regular';

    return {
      isExistingCustomer: true,
      customerName,
      customerPhone: customer.phone || normalizePhone(fallbackPhone),
      tier,
      greeting: `Welcome back ${customerName}. Thank you for being our ${tier} customer.`,
      aiSystemContext: `You are assisting a ${tier} customer named ${customerName}. Be polite and personalized.`,
    };
  }

  return {
    isExistingCustomer: false,
    customerName: 'New Customer',
    customerPhone: normalizePhone(fallbackPhone),
    tier: 'Regular',
    greeting: 'Hello and welcome. Thank you for calling us today.',
    aiSystemContext:
      'You are assisting a new customer. Be polite, clear, and gather basic details for personalization.',
  };
}

module.exports = {
  normalizePhone,
  buildPhoneVariants,
  getCustomerByPhone,
  getCustomerById,
  getCustomerByEmail,
  incrementCustomerCalls,
  getPersonalization,
};
