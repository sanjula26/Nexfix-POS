/** Small pure helpers for Credit Settle search; kept separate for regression tests. */
export function normalizeCreditPhoneSearch(value: string): string {
  return String(value ?? '').replace(/\s/g, '');
}

export function normalizeCreditSearchDigits(value: string): string {
  return String(value ?? '').replace(/\D/g, '');
}

export function matchesCreditPhoneDigits(phone: string, query: string): boolean {
  const queryDigits = normalizeCreditSearchDigits(query);
  return queryDigits.length > 0 && normalizeCreditSearchDigits(phone).includes(queryDigits);
}
