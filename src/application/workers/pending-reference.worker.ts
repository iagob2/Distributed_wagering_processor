import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { WagerTransactionDbEntity } from '../../infrastructure/database/entities/wager-transaction.db-entity';
import { WalletDbEntity } from '../../infrastructure/database/entities/wallet.db-entity';
import { WalletLedgerEntryDbEntity } from '../../infrastructure/database/entities/wallet-ledger-entry.db-entity';
import { OutboxEventDbEntity } from '../../infrastructure/database/entities/outbox-event.db-entity';
import {
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.entity';
import { Wallet } from '../../domain/entities/wallet.entity';
import { Money } from '../../domain/value-objects/money.vo';
import { WagerRuleEngine } from '../../domain/wager/wager-rule-engine';
import { PendingReferenceTracker } from '../../domain/wager/pending-reference-tracker';
import { FailureCode } from '../../domain/wager/failure-code';
import {
    WalletLedgerEntry,
    LedgerDirection,
} from '../../domain/entities/wallet-ledger-entry.entity';
import { randomUUID } from 'crypto';

@Injectable()
export class PendingReferenceWorker {
    private readonly logger = new Logger(PendingReferenceWorker.name);

    constructor(private readonly em: EntityManager) { }

    public async processPendingBatch(): Promise<number> {
        const forkEm = this.em.fork();
        const now = new Date();

        // Busca transações pendentes de referência
        const pendingTxs = await forkEm.find(
            WagerTransactionDbEntity,
            { status: WagerTransactionStatus.PendingReference },
            { limit: 50 },
        );

        let processedCount = 0;

        for (const item of pendingTxs) {
            await forkEm.transactional(async (txEm) => {
                // Bloqueio pessimista na transação pendente para evitar colisão entre workers
                const currentTxDb = await txEm.findOne(
                    WagerTransactionDbEntity,
                    { id: item.id },
                    { lockMode: LockMode.PESSIMISTIC_WRITE },
                );

                if (!currentTxDb || currentTxDb.status !== WagerTransactionStatus.PendingReference) {
                    return;
                }

                // 1. Tenta localizar a aposta referenciada
                const referenceDb = await txEm.findOne(WagerTransactionDbEntity, {
                    providerId: currentTxDb.providerId,
                    externalTransactionId: currentTxDb.referenceExternalTransactionId!,
                });

                // 2. Se a referência existe e está PROCESSED, aplicamos a operação
                if (referenceDb && referenceDb.status === WagerTransactionStatus.Processed) {
                    const walletDb = await txEm.findOne(
                        WalletDbEntity,
                        { id: currentTxDb.walletId },
                        { lockMode: LockMode.PESSIMISTIC_WRITE },
                    );

                    if (!walletDb) return;

                    const wallet = Wallet.rehydrate({
                        id: walletDb.id,
                        playerId: walletDb.playerId,
                        currency: walletDb.currency,
                        balance: Money.fromCents(walletDb.balance, walletDb.currency),
                        version: walletDb.version,
                        createdAt: walletDb.createdAt,
                        updatedAt: walletDb.updatedAt,
                    });

                    const currentDomainTx = WagerTransaction.rehydrate({
                        id: currentTxDb.id,
                        providerId: currentTxDb.providerId,
                        externalTransactionId: currentTxDb.externalTransactionId,
                        idempotencyKey: currentTxDb.idempotencyKey,
                        payloadHash: currentTxDb.payloadHash,
                        walletId: currentTxDb.walletId,
                        playerId: currentTxDb.playerId,
                        roundId: currentTxDb.roundId,
                        gameId: currentTxDb.gameId,
                        kind: currentTxDb.kind as WagerTransactionKind,
                        money: Money.fromCents(currentTxDb.amount, currentTxDb.currency),
                        referenceExternalTransactionId: currentTxDb.referenceExternalTransactionId,
                        createdAt: currentTxDb.createdAt,
                        status: currentTxDb.status as WagerTransactionStatus,
                    });

                    const refDomainTx = WagerTransaction.rehydrate({
                        id: referenceDb.id,
                        providerId: referenceDb.providerId,
                        externalTransactionId: referenceDb.externalTransactionId,
                        idempotencyKey: referenceDb.idempotencyKey,
                        payloadHash: referenceDb.payloadHash,
                        walletId: referenceDb.walletId,
                        playerId: referenceDb.playerId,
                        roundId: referenceDb.roundId,
                        gameId: referenceDb.gameId,
                        kind: referenceDb.kind as WagerTransactionKind,
                        money: Money.fromCents(referenceDb.amount, referenceDb.currency),
                        referenceExternalTransactionId: referenceDb.referenceExternalTransactionId,
                        createdAt: referenceDb.createdAt,
                        status: referenceDb.status as WagerTransactionStatus,
                    });

                    const evalResult = WagerRuleEngine.evaluate(currentDomainTx, wallet, refDomainTx);

                    if (evalResult.shouldApply && evalResult.direction && evalResult.moneyToApply) {
                        const mutation =
                            evalResult.direction === LedgerDirection.Debit
                                ? wallet.debit(evalResult.moneyToApply)
                                : wallet.credit(evalResult.moneyToApply);

                        currentDomainTx.markProcessed(refDomainTx.id, now);

                        walletDb.balance = wallet.balance.toCents().toString();
                        walletDb.version = wallet.version;
                        walletDb.updatedAt = wallet.updatedAt;

                        currentTxDb.status = currentDomainTx.status;
                        currentTxDb.referenceTransactionId = refDomainTx.id;
                        currentTxDb.processedAt = currentDomainTx.processedAt;

                        const ledgerDb = txEm.create(WalletLedgerEntryDbEntity, {
                            id: randomUUID(),
                            walletId: wallet.id,
                            transactionId: currentDomainTx.id,
                            direction: evalResult.direction,
                            amount: evalResult.moneyToApply.toCents().toString(),
                            balanceBefore: mutation.balanceBefore.toCents().toString(),
                            balanceAfter: mutation.balanceAfter.toCents().toString(),
                            createdAt: now,
                        });

                        txEm.persist(ledgerDb);
                        this.logger.log(`Transação fora de ordem resolvida: ${currentTxDb.id}`);
                    } else if (evalResult.failureCode) {
                        currentDomainTx.reject(evalResult.failureCode);
                        currentTxDb.status = currentDomainTx.status;
                        currentTxDb.failureCode = evalResult.failureCode;
                        currentTxDb.processedAt = now;
                    }

                    processedCount++;
                    return;
                }

                // 3. Referência continua ausente: checa janela de TTL (60 segundos)
                const elapsedMs = now.getTime() - currentTxDb.createdAt.getTime();
                if (elapsedMs >= 60000) {
                    currentTxDb.status = WagerTransactionStatus.Rejected;
                    currentTxDb.failureCode = FailureCode.REFERENCE_NOT_FOUND;
                    currentTxDb.processedAt = now;

                    const outboxFailure = txEm.create(OutboxEventDbEntity, {
                        id: randomUUID(),
                        aggregateId: currentTxDb.id,
                        eventType: 'WagerTransactionRejected',
                        payload: {
                            transactionId: currentTxDb.id,
                            providerId: currentTxDb.providerId,
                            failureCode: FailureCode.REFERENCE_NOT_FOUND,
                            reason: 'Janela de tolerância para recebimento da referência expirada.',
                        },
                        occurredAt: now,
                        attempts: 0,
                        nextAttemptAt: now,
                        createdAt: now,
                    });

                    txEm.persist(outboxFailure);
                    this.logger.warn(`Transação ${currentTxDb.id} rejeitada por TTL expirado.`);
                    processedCount++;
                }
            });
        }

        return processedCount;
    }
}
