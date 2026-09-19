-- Track ATA rent paid/refunded for unbiased entry/exit pricing
-- Entry: rent paid to create ATA (refundable on close)
-- Exit: rent refunded when ATA is closed

ALTER TABLE hybrid_shadow_trades
ADD COLUMN IF NOT EXISTS entry_ata_rent_paid_sol NUMERIC(20, 9),
ADD COLUMN IF NOT EXISTS exit_ata_rent_refunded_sol NUMERIC(20, 9);

COMMENT ON COLUMN hybrid_shadow_trades.entry_ata_rent_paid_sol IS 'ATA rent paid on entry (SOL) for output token account';
COMMENT ON COLUMN hybrid_shadow_trades.exit_ata_rent_refunded_sol IS 'ATA rent refunded on exit (SOL) when closing token account';

ALTER TABLE trades
ADD COLUMN IF NOT EXISTS entry_ata_rent_paid_sol NUMERIC(20, 9),
ADD COLUMN IF NOT EXISTS exit_ata_rent_refunded_sol NUMERIC(20, 9);

COMMENT ON COLUMN trades.entry_ata_rent_paid_sol IS 'ATA rent paid on entry (SOL) for output token account';
COMMENT ON COLUMN trades.exit_ata_rent_refunded_sol IS 'ATA rent refunded on exit (SOL) when closing token account';
