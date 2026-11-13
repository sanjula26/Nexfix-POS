export interface OpeningFloatSource {
  opening?: number;
  openingConfirmed?: boolean;
}

export interface ParsedOpeningFloatInput {
  opening: number;
  confirmed: boolean;
}

/** Blank means no opening float; zero entered explicitly is a confirmed zero float. */
export function parseOpeningFloatInput(value: string): ParsedOpeningFloatInput | null {
  const trimmed = value.trim();
  if (!trimmed) return { opening: 0, confirmed: false };
  const amount = Number(trimmed);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return { opening: Math.round(amount * 100) / 100, confirmed: true };
}

/** Missing or unconfirmed opening cash is zero for drawer reconciliation. */
export function getEffectiveOpeningFloat(session: OpeningFloatSource): number {
  if (session.openingConfirmed !== true) return 0;
  const opening = Number(session.opening);
  return Number.isFinite(opening) ? Math.max(0, opening) : 0;
}

export function sumEffectiveOpeningFloats(sessions: OpeningFloatSource[]): number {
  return sessions.reduce((sum, session) => sum + getEffectiveOpeningFloat(session), 0);
}

export function getCreditPaymentSessionBlockReason(session: { closed?: boolean; openingConfirmed?: boolean } | null | undefined): string {
  if (!session) return "Open a cashier drawer session for today first. Go to Cashier Balance Report and open today's session.";
  if (session.closed) return "Today's cashier drawer is already closed. Credit payments cannot be collected in a closed session.";
  // Opening float is optional; an unconfirmed zero-float session can collect credit.
  return '';
}
