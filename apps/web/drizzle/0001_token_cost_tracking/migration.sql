-- Migration: Replace FLOPS billing with token-based cost tracking
-- IMPORTANT: Deploy code changes FIRST, then run this migration.
-- The code no longer references the dropped columns, so this is safe.

-- Drop old billing columns
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "authorized_flops";
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "cost_flops";
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "mpp_channel_id";

-- Add token tracking columns (all nullable for backward compatibility)
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "input_tokens" integer;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "output_tokens" integer;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "cache_read_tokens" integer;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "cache_write_tokens" integer;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "bedrock_cost_usd" numeric(12, 6);
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "container_cost_usd" numeric(12, 6);
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "cost_usd" numeric(12, 6);
