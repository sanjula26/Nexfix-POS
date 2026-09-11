# Atomic POS sale validation

This checklist is used to validate the cloud-first POS checkout integration before merge.

## Required checks

1. **Online + authenticated admin/manager**
   - First sale bootstraps the shop if needed.
   - Local products/customers/in-stock tracked units are mirrored into the normalized cloud catalog.
   - The atomic sale RPC commits the sale, stock decrement, tracked-unit transition, payments, loyalty/credit changes, and audit entry in one transaction.
   - The local POS mirror uses the returned cloud sale ID and bill number.

2. **Online + authenticated cashier**
   - No catalog bootstrap write is attempted by the cashier.
   - The cashier can sell only against the already synchronized cloud catalog.
   - Server-side membership, stock, tracked-unit, payment, customer, and price-override checks remain authoritative.

3. **Offline or cloud not configured**
   - Checkout keeps the existing durable local POS path and does not discard the sale.

4. **Cloud transaction failure**
   - The UI does not silently create a local-only sale when cloud mode is active and the atomic transaction rejects the sale.

5. **Idempotency**
   - Repeating the same sale ID returns the already committed cloud sale instead of creating a second sale.

## Current environment note

The connected Supabase project currently has no shops, memberships, profiles, products, customers, or in-stock inventory units, so a real authenticated end-to-end sale cannot be executed against production data until the first-run cloud account/shop is created and the normalized catalog is populated.
