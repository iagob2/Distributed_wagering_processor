import { Money } from '../value-objects/money.vo';
import { Wallet } from '../entities/wallet.entity';
import {
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from '../entities/wager-transaction.entity';
import { LedgerDirection } from '../entities/wallet-ledger-entry.entity';
import { FailureCode } from './failure-code';

export interface EvaluationResult {
    shouldApply: boolean;
    isPendingReference?: boolean;
    failureCode?: FailureCode;
    direction?: LedgerDirection;
    moneyToApply?: Money;
}

/**
 * Avalia BET/WIN/LOSS/REFUND/ROLLBACK sem mutar estado.
 * O use case aplica o resultado (debit/credit/reject/pending) sob lock da wallet.
 *
 * Integridade da máquina de estados:
 * - REFUND só sobre BET PROCESSED; ROLLBACK sobre BET|WIN|REFUND
 * - Anti double-reversal via alreadyReversedIds
 * - Referência ausente → isPendingReference (worker assíncrono)
 * - INSUFFICIENT_FUNDS ≠ INSUFFICIENT_FUNDS_FOR_REVERSAL (operações distintas)
 */
export class WagerRuleEngine {
    /**
     * Avalia a transação em relação à carteira e à referência opcional,
     * ditando o sentido contábil ou o código de rejeição sem mutar estados.
     */
    public static evaluate(
        transaction: WagerTransaction,
        wallet: Wallet,
        reference?: WagerTransaction,
        alreadyReversedIds: Set<string> = new Set(),
    ): EvaluationResult {
        // 1. Operação BET (Débito inicial)
        if (transaction.kind === WagerTransactionKind.Bet) {
            if (wallet.balance.isLessThan(transaction.money)) {
                return { shouldApply: false, failureCode: FailureCode.INSUFFICIENT_FUNDS };
            }
            return {
                shouldApply: true,
                direction: LedgerDirection.Debit,
                moneyToApply: transaction.money,
            };
        }

        // 2. Operação WIN (Crédito de prêmio)
        if (transaction.kind === WagerTransactionKind.Win) {
            return {
                shouldApply: true,
                direction: LedgerDirection.Credit,
                moneyToApply: transaction.money,
            };
        }

        // 3. Operação LOSS (Encerramento de rodada sem alteração contábil)
        if (transaction.kind === WagerTransactionKind.Loss) {
            return { shouldApply: true };
        }

        // 4. Operações de Compensação (REFUND e ROLLBACK)
        if (transaction.requiresReference()) {
            if (!reference) {
                // Referência ausente na base -> aguardar de forma assíncrona
                return { shouldApply: false, isPendingReference: true };
            }

            // Validação estrita de metadados da referência cruzada
            const matchesMetadata =
                reference.providerId === transaction.providerId &&
                reference.playerId === transaction.playerId &&
                reference.walletId === transaction.walletId &&
                reference.roundId === transaction.roundId &&
                reference.money.equals(transaction.money);

            if (!matchesMetadata) {
                return {
                    shouldApply: false,
                    failureCode: FailureCode.INVALID_REFERENCE_METADATA,
                };
            }

            if (reference.status !== WagerTransactionStatus.Processed) {
                return {
                    shouldApply: false,
                    failureCode: FailureCode.REFERENCE_NOT_PROCESSED,
                };
            }

            // Proibição de reversão dupla da mesma operação de origem
            if (alreadyReversedIds.has(reference.id)) {
                return {
                    shouldApply: false,
                    failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
                };
            }

            // Regra de REFUND: restrito exclusivamente a apostas (BET)
            if (transaction.kind === WagerTransactionKind.Refund) {
                if (reference.kind !== WagerTransactionKind.Bet) {
                    return {
                        shouldApply: false,
                        failureCode: FailureCode.INVALID_REFUND_TARGET,
                    };
                }
                return {
                    shouldApply: true,
                    direction: LedgerDirection.Credit,
                    moneyToApply: transaction.money,
                };
            }

            // Regra de ROLLBACK: inverte a direção original da transação referenciada
            if (transaction.kind === WagerTransactionKind.Rollback) {
                if (
                    reference.kind !== WagerTransactionKind.Bet &&
                    reference.kind !== WagerTransactionKind.Win &&
                    reference.kind !== WagerTransactionKind.Refund
                ) {
                    return {
                        shouldApply: false,
                        failureCode: FailureCode.INVALID_ROLLBACK_TARGET,
                    };
                }

                // Se referenciou um débito (BET), o estorno é CRÉDITO
                if (reference.kind === WagerTransactionKind.Bet) {
                    return {
                        shouldApply: true,
                        direction: LedgerDirection.Credit,
                        moneyToApply: transaction.money,
                    };
                }

                // Se referenciou um crédito (WIN ou REFUND), o estorno é DÉBITO
                if (
                    reference.kind === WagerTransactionKind.Win ||
                    reference.kind === WagerTransactionKind.Refund
                ) {
                    if (wallet.balance.isLessThan(transaction.money)) {
                        // Rejeita para não negativar a carteira
                        return {
                            shouldApply: false,
                            failureCode: FailureCode.INSUFFICIENT_FUNDS_FOR_REVERSAL,
                        };
                    }
                    return {
                        shouldApply: true,
                        direction: LedgerDirection.Debit,
                        moneyToApply: transaction.money,
                    };
                }
            }
        }

        return { shouldApply: false, failureCode: FailureCode.UNSUPPORTED_OPERATION };
    }
}