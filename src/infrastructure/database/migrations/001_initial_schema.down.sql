-- Down Migration (Rollback Seguro)
DROP TRIGGER IF EXISTS trg_protect_ledger_entries ON ledger_entries;
DROP FUNCTION IF EXISTS prevent_ledger_modification();
DROP TABLE IF EXISTS inbox_messages;
DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS ledger_entries;
DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;