-- ============================================================================
-- Distributed Wagering Processor — Migration inicial (Seção 5 / Seção 9 do desafio)
-- Garantias no SCHEMA (não só no código):
--   • CHECK (balance >= 0)
--   • UNIQUE (player_id, currency)
--   • UNIQUE (provider_id, external_transaction_id)
--   • Ledger append-only via trigger BEFORE UPDATE OR DELETE
--   • Aritmética DEBIT/CREDIT validada por CHECK
-- ============================================================================

-- Habilita extensão para geração de UUIDv4 nativo no PostgreSQL
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. TABELA DE CARTEIRAS (WALLETS)
-- Invariantes: Saldo não-negativo e unicidade por player + moeda
-- ============================================================================
CREATE TABLE wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    player_id VARCHAR(64) NOT NULL,
    currency VARCHAR(3) NOT NULL,
    balance BIGINT NOT NULL DEFAULT 0,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_wallet_balance_non_negative CHECK (balance >= 0),
    CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
);

CREATE INDEX idx_wallets_player_id ON wallets(player_id);

-- ============================================================================
-- 2. TABELA DE TRANSAÇÕES DE APOSTA (WAGER_TRANSACTIONS)
-- Registra o ciclo de vida completo de cada operação recebida
-- ============================================================================
CREATE TABLE wager_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_id VARCHAR(64) NOT NULL,
    external_transaction_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    player_id VARCHAR(64) NOT NULL,
    round_id VARCHAR(128) NOT NULL,
    game_id VARCHAR(64) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    amount BIGINT NOT NULL,
    currency VARCHAR(3) NOT NULL,
    reference_external_transaction_id VARCHAR(128),
    reference_transaction_id UUID REFERENCES wager_transactions(id),
    status VARCHAR(25) NOT NULL,
    failure_code VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    CONSTRAINT chk_wager_tx_amount_positive CHECK (amount >= 0),
    CONSTRAINT uq_provider_external_tx UNIQUE (provider_id, external_transaction_id)
);

CREATE INDEX idx_wager_tx_wallet ON wager_transactions(wallet_id);
CREATE INDEX idx_wager_tx_round ON wager_transactions(round_id);
CREATE INDEX idx_wager_tx_status ON wager_transactions(status);
CREATE INDEX idx_wager_tx_ref ON wager_transactions(provider_id, reference_external_transaction_id);

-- ============================================================================
-- 3. TABELA DE IDEMPOTÊNCIA PERSISTENTE (IDEMPOTENCY_KEYS)
-- Impede reprocessamento em múltiplas instâncias e detecta conflitos
-- ============================================================================
CREATE TABLE idempotency_keys (
    key VARCHAR(255) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    external_transaction_id VARCHAR(128) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    response_status INT NOT NULL,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_idempotency_provider_tx UNIQUE (provider_id, external_transaction_id)
);

CREATE INDEX idx_idempotency_lookup ON idempotency_keys(provider_id, external_transaction_id);

-- ============================================================================
-- 4. TABELA DE LIVRO-RAZÃO CONTÁBIL (LEDGER_ENTRIES)
-- Append-Only: Lançamentos imutáveis com rastreio exato de saldo
-- ============================================================================
CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    transaction_id UUID NOT NULL REFERENCES wager_transactions(id) ON DELETE RESTRICT,
    direction VARCHAR(6) NOT NULL,
    amount BIGINT NOT NULL,
    balance_before BIGINT NOT NULL,
    balance_after BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
    CONSTRAINT chk_ledger_amount_positive CHECK (amount > 0),
    CONSTRAINT chk_ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
    CONSTRAINT chk_ledger_arithmetic CHECK (
        (direction = 'DEBIT' AND balance_before - amount = balance_after) OR
        (direction = 'CREDIT' AND balance_before + amount = balance_after)
    )
);

CREATE INDEX idx_ledger_wallet_id ON ledger_entries(wallet_id);
CREATE INDEX idx_ledger_tx_id ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_created_at ON ledger_entries(created_at);

-- Trigger de Imutabilidade: Proíbe UPDATE e DELETE no Ledger
CREATE OR REPLACE FUNCTION prevent_ledger_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Operação inválida: lançamentos no livro-razão (ledger) são imutáveis e puramente cumulativos (append-only).';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_ledger_entries
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION prevent_ledger_modification();

-- ============================================================================
-- 5. OUTBOX TRANSACTIONAL (OUTBOX_EVENTS)
-- Previne Dual-Write garantindo envio atômico ao SQS
-- ============================================================================
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    aggregate_id VARCHAR(128) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_outbox_pending ON outbox_events(next_attempt_at) WHERE published_at IS NULL;

-- ============================================================================
-- 6. INBOX PERSISTENTE (INBOX_MESSAGES)
-- Deduplicação no consumo de mensagens vindas da fila SQS
-- ============================================================================
CREATE TABLE inbox_messages (
    message_id VARCHAR(128) NOT NULL,
    consumer_name VARCHAR(64) NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (message_id, consumer_name)
);