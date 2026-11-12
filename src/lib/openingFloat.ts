export interface OpeningFloatSource {
  opening?: number;
  openingConfirmed?: boolean;
}

/** Missing or unconfirmed opening cash is zero for drawer reconciliation. */
export function getEffectiveOpeningFloat(session: OpeningFloatSource): number {
  if (session.openingConfirmed === false) return 0;
  const opening = Number(session.opening);
  return Number.isFinite(opening) ? Math.max(0, opening) : 0;
}
