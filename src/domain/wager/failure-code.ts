/**
 * Catálogo exaustivo e estável de códigos de falha legíveis por máquina.
 * Provedores utilizam esses códigos para decidir se reenviam, corrigem o payload ou desistem.
 */
export const FailureCode = {
    // Regras de Negócio e Saldo
    INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
    INSUFFICIENT_FUNDS_FOR_REVERSAL: 'INSUFFICIENT_FUNDS_FOR_REVERSAL',

    // Integridade de Referências e Rodadas
    REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
    REFERENCE_NOT_PROCESSED: 'REFERENCE_NOT_PROCESSED',
    REFERENCE_ALREADY_REVERSED: 'REFERENCE_ALREADY_REVERSED',
    INVALID_REFERENCE_METADATA: 'INVALID_REFERENCE_METADATA',
    INVALID_REFUND_TARGET: 'INVALID_REFUND_TARGET',
    INVALID_ROLLBACK_TARGET: 'INVALID_ROLLBACK_TARGET',

    // Contrato e Configuração
    CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
    IDEMPOTENCY_PAYLOAD_MISMATCH: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    UNSUPPORTED_OPERATION: 'UNSUPPORTED_OPERATION',

    // Infraestrutura e Falhas Transitórias
    SYSTEM_CONCURRENCY_TIMEOUT: 'SYSTEM_CONCURRENCY_TIMEOUT',
    SYSTEM_ERROR: 'SYSTEM_ERROR',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];