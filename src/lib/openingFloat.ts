export interface OpeningFloatSource {
  opening?: number;
  openingConfirmed?: boolean;
}

/** An unconfirmed optional float must never inflate expected drawer cash. */
export function getEffectiveOpeningFloat(session: OpeningFloatSource): number {
  if (session.openingConfirmed === false) return 0;
  return Math.max(0, Number(session.opening) || 0);
}
