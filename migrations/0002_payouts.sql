-- Studio payouts: after settlement Earned pays each studio its share with PayPal Payouts and keeps a
-- platform fee. Refunds from appeals upheld after a payout are netted out of the studio's next payout.

ALTER TABLE orders ADD COLUMN payout_status TEXT;                         -- NULL until settled; none | sending | PayPal item status (PENDING, SUCCESS, UNCLAIMED, ...)
ALTER TABLE orders ADD COLUMN payout_cents INTEGER NOT NULL DEFAULT 0;   -- sent to the studio
ALTER TABLE orders ADD COLUMN fee_cents INTEGER NOT NULL DEFAULT 0;      -- kept by Earned
ALTER TABLE orders ADD COLUMN recovered_cents INTEGER NOT NULL DEFAULT 0; -- earlier clawbacks netted out of this payout
ALTER TABLE orders ADD COLUMN clawback_cents INTEGER NOT NULL DEFAULT 0;  -- studio share of refunds made after this order's payout
ALTER TABLE orders ADD COLUMN payout_batch_id TEXT;
ALTER TABLE orders ADD COLUMN payout_item_id TEXT;
CREATE INDEX orders_payout ON orders(status, payout_status);
