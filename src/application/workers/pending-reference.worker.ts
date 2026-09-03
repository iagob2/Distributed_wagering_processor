import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { WagerTransactionDbEntity } from '../../infrastructure/database/entities/wager-transaction.db-entity';
import { WalletDbEntity } from '../../infrastructure/database/entities/wallet.db-entity';
import { WalletLedgerEntryDbEntity } from '../../infrastructure/database/entities/wallet-ledger-entry.db-entity';
import { OutboxEventDbEntity } from '../../infrastructure/database/entities/outbox-event.db-entity';
import { IdempotencyKeyDbEntity } from '../../infrastructure/database/entities/idempotency-key.db-entity';
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
import { LedgerDirection, WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry.entity';
import {
    WalletBalanceChanged,
    WagerTransactionProcessed,
    WagerTransactionRejected,
} from '../../domain/events/integration-event';
import { MetricsService } from '../../common/metrics/metrics.service';

/**
 * Reprocessa PENDING_REFERENCE (REFUND/ROLLBACK que chegaram antes da BET).
 * Usa SKIP LOCKED para múltiplas instâncias e PendingReferenceTracker para backoff/TTL.
 */
@Injectable()
export class PendingReferenceWorker {
    private readonly logger = new Logger(PendingReferenceWorker.name);

    constructor(
        private readonly em: EntityManager,
        private readonly metrics: MetricsService,
    ) { }

    public async processPendingBatch(): Promise<number> {
        const ids = await this.claimPendingIds();
        let processedCount = 0;

        for (const id of ids) {
            try {
                const changed = await this.processOne(id);
                if (changed) processedCount++;
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.error(`Falha ao reprocessar ${id}: ${msg}`);
                this.metrics.transactionRetriesTotal.inc({ kind: 'pending_reference' });
            }
        }

        return processedCount;
    }

    private async claimPendingIds(): Promise<string[]> {
        const forkEm = this.em.fork();
        return await forkEm.transactional(async (txEm) => {
            const knex = txEm.getKnex();
            const rows = await knex('wager_transactions')
                .select('id')
                .where({ status: WagerTransactionStatus.PendingReference })
                .orderBy('created_at', 'asc')
                .limit(50)
                .forUpdate()
                .skipLocked();
            return rows.map((r: { id: string }) => r.id);
        });
    }

    private async processOne(transactionId: string): Promise<boolean> {
        const forkEm = this.em.fork();
        const now = new Date();

        return await forkEm.transactional(async (txEm) => {
            const currentTxDb = await txEm.findOne(
                WagerTransactionDbEntity,
                { id: transactionId },
                { lockMode: LockMode.PESSIMISTIC_WRITE },
            );

            if (!currentTxDb || currentTxDb.status !== WagerTransactionStatus.PendingReference) {
                return false;
            }

            const referenceDb = await txEm.findOne(WagerTransactionDbEntity, {
                providerId: currentTxDb.providerId,
                externalTransactionId: currentTxDb.referenceExternalTransactionId!,
            });

            if (referenceDb && referenceDb.status === WagerTransactionStatus.Processed) {
                return await this.applyResolvedReference(txEm, currentTxDb, referenceDb, now);
            }

            // Referência ainda ausente: janela ~60s (backoff 2+4+8+16+32s do PendingReferenceTracker).
            const elapsedMs = now.getTime() - currentTxDb.createdAt.getTime();
            const approxAttempts = Math.min(
                PendingReferenceTracker.MAX_ATTEMPTS,
                Math.max(1, Math.floor(elapsedMs / 2000) + 1),
            );
            const tracker = PendingReferenceTracker.rehydrate({
                transactionId: currentTxDb.id,
                attempts: approxAttempts,
                nextAttemptAt: now,
            });
            this.metrics.transactionRetriesTotal.inc({ kind: currentTxDb.kind });

            if (elapsedMs >= 60_000 || tracker.hasExceededLimit()) {
                currentTxDb.status = WagerTransactionStatus.Rejected;
                currentTxDb.failureCode = FailureCode.REFERENCE_NOT_FOUND;
                currentTxDb.processedAt = now;

                const walletDb = await txEm.findOne(WalletDbEntity, { id: currentTxDb.walletId });
                if (walletDb) {
                    await this.updateIdempotencyResponse(
                        txEm,
                        currentTxDb,
                        422,
                        Money.fromCents(walletDb.balance, walletDb.currency).toJSON(),
                        WagerTransactionStatus.Rejected,
                        FailureCode.REFERENCE_NOT_FOUND,
                    );
                }

                const rejected = WagerTransaction.rehydrate({
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
                    status: WagerTransactionStatus.PendingReference,
                });
                rejected.reject(FailureCode.REFERENCE_NOT_FOUND);

                const envelope = WagerTransactionRejected.from(
                    rejected,
                    FailureCode.REFERENCE_NOT_FOUND,
                    { correlationId: currentTxDb.idempotencyKey, causationId: currentTxDb.id },
                ).toJSON();

                txEm.persist(
                    txEm.create(OutboxEventDbEntity, {
                        id: envelope.eventId,
                        aggregateId: envelope.aggregateId,
                        eventType: envelope.eventType,
                        payload: envelope as unknown as Record<string, unknown>,
                        occurredAt: now,
                        attempts: 0,
                        nextAttemptAt: now,
                        createdAt: now,
                    }),
                );

                this.logger.warn(`PENDING_REFERENCE ${currentTxDb.id} rejeitada (TTL/attempts).`);
                return true;
            }

            // Mantém PENDING_REFERENCE; próxima varredura reavalia.
            this.logger.debug(
                `Referência ainda ausente para ${currentTxDb.id}; attempt=${tracker.attempts}`,
            );
            return false;
        });
    }

    private async applyResolvedReference(
        txEm: EntityManager,
        currentTxDb: WagerTransactionDbEntity,
        referenceDb: WagerTransactionDbEntity,
        now: Date,
    ): Promise<boolean> {
        const walletDb = await txEm.findOne(
            WalletDbEntity,
            { id: currentTxDb.walletId },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
        );
        if (!walletDb) return false;

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

        const alreadyReversed = await txEm.find(WagerTransactionDbEntity, {
            providerId: currentTxDb.providerId,
            referenceExternalTransactionId: referenceDb.externalTransactionId,
            kind: currentTxDb.kind,
            status: WagerTransactionStatus.Processed,
        });
        const alreadyReversedIds = new Set(
            alreadyReversed.length > 0 ? [referenceDb.id] : [],
        );

        const evalResult = WagerRuleEngine.evaluate(
            currentDomainTx,
            wallet,
            refDomainTx,
            alreadyReversedIds,
        );
        const ctx = {
            correlationId: currentTxDb.idempotencyKey,
            causationId: currentTxDb.id,
        };

        if (evalResult.shouldApply) {
            if (evalResult.direction && evalResult.moneyToApply) {
                const mutation =
                    evalResult.direction === LedgerDirection.Debit
                        ? wallet.debit(evalResult.moneyToApply)
                        : wallet.credit(evalResult.moneyToApply);

                currentDomainTx.markProcessed(refDomainTx.id, now);
                walletDb.balance = wallet.balance.toCents().toString();
                walletDb.version = wallet.version;
                walletDb.updatedAt = wallet.updatedAt;

                const ledgerEntry = WalletLedgerEntry.create({
                    id: randomUUID(),
                    walletId: wallet.id,
                    transactionId: currentDomainTx.id,
                    direction: evalResult.direction,
                    money: evalResult.moneyToApply,
                    balanceBefore: mutation.balanceBefore,
                    balanceAfter: mutation.balanceAfter,
                });

                txEm.persist(
                    txEm.create(WalletLedgerEntryDbEntity, {
                        id: ledgerEntry.id,
                        walletId: ledgerEntry.walletId,
                        transactionId: ledgerEntry.transactionId,
                        direction: ledgerEntry.direction,
                        amount: ledgerEntry.money.toCents().toString(),
                        balanceBefore: ledgerEntry.balanceBefore.toCents().toString(),
                        balanceAfter: ledgerEntry.balanceAfter.toCents().toString(),
                        createdAt: now,
                    }),
                );

                const balanceEvt = WalletBalanceChanged.from(wallet, ledgerEntry, ctx).toJSON();
                txEm.persist(
                    txEm.create(OutboxEventDbEntity, {
                        id: balanceEvt.eventId,
                        aggregateId: balanceEvt.aggregateId,
                        eventType: balanceEvt.eventType,
                        payload: balanceEvt as unknown as Record<string, unknown>,
                        occurredAt: now,
                        attempts: 0,
                        nextAttemptAt: now,
                        createdAt: now,
                    }),
                );
            } else {
                currentDomainTx.markProcessed(refDomainTx.id, now);
            }

            currentTxDb.status = currentDomainTx.status;
            currentTxDb.referenceTransactionId = refDomainTx.id;
            currentTxDb.processedAt = currentDomainTx.processedAt;

            await this.updateIdempotencyResponse(
                txEm,
                currentTxDb,
                200,
                wallet.balance.toJSON(),
                WagerTransactionStatus.Processed,
            );

            const processedEvt = WagerTransactionProcessed.from(
                currentDomainTx,
                wallet,
                ctx,
            ).toJSON();
            txEm.persist(
                txEm.create(OutboxEventDbEntity, {
                    id: processedEvt.eventId,
                    aggregateId: processedEvt.aggregateId,
                    eventType: processedEvt.eventType,
                    payload: processedEvt as unknown as Record<string, unknown>,
                    occurredAt: now,
                    attempts: 0,
                    nextAttemptAt: now,
                    createdAt: now,
                }),
            );

            this.logger.log(`PENDING_REFERENCE resolvida: ${currentTxDb.id}`);
            return true;
        }

        if (evalResult.failureCode) {
            currentDomainTx.reject(evalResult.failureCode);
            currentTxDb.status = currentDomainTx.status;
            currentTxDb.failureCode = evalResult.failureCode;
            currentTxDb.processedAt = now;

            const rejectedEvt = WagerTransactionRejected.from(
                currentDomainTx,
                evalResult.failureCode,
                ctx,
            ).toJSON();
            txEm.persist(
                txEm.create(OutboxEventDbEntity, {
                    id: rejectedEvt.eventId,
                    aggregateId: rejectedEvt.aggregateId,
                    eventType: rejectedEvt.eventType,
                    payload: rejectedEvt as unknown as Record<string, unknown>,
                    occurredAt: now,
                    attempts: 0,
                    nextAttemptAt: now,
                    createdAt: now,
                }),
            );
            return true;
        }

        return false;
    }

    private async updateIdempotencyResponse(
        txEm: EntityManager,
        transaction: WagerTransactionDbEntity,
        responseStatus: number,
        balance: { amount: string; currency: string },
        status: WagerTransactionStatus,
        failureCode?: FailureCode,
    ): Promise<void> {
        const idempotency = await txEm.findOne(IdempotencyKeyDbEntity, {
            key: transaction.idempotencyKey,
        });

        if (!idempotency) return;

        idempotency.responseStatus = responseStatus;
        idempotency.responseBody = {
            transactionId: transaction.id,
            status,
            balance,
            idempotentReplay: false,
            ...(failureCode ? { failureCode } : {}),
        };
    }
}
