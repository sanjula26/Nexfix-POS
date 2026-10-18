/** Small pure helpers for Credit Settle search; kept separate for regression tests. */
export function normalizeCreditPhoneSearch(value: string): string {
  return String(value ?? '').replace(/\s/g, '');
}

export function normalizeCreditSearchDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeSriLankanPhoneDigits(value: string): string {
  const digits = normalizeCreditSearchDigits(value);
  if (digits.startsWith('94') && digits.length >= 11) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
}

export function matchesCreditPhoneDigits(phone: string, query: string): boolean {
  const queryDigits = normalizeCreditSearchDigits(query);
  if (!queryDigits) return false;

  const phoneDigits = normalizeCreditSearchDigits(phone);
  if (phoneDigits.includes(queryDigits)) return true;

  const normalizedQuery = normalizeSriLankanPhoneDigits(query);
  const normalizedPhone = normalizeSriLankanPhoneDigits(phone);
  return normalizedQuery.length > 0 && normalizedPhone.includes(normalizedQuery);
}
