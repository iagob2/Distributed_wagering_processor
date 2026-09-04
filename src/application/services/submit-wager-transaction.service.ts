import {
    Injectable,
    ConflictException,
    UnprocessableEntityException,
    NotFoundException,
    BadRequestException,
    Optional,
} from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { CanonicalJsonHasher } from '../../common/utils/canonical-json-hasher.util';
import { IdempotencyKeyDbEntity } from '../../infrastructure/database/entities/idempotency-key.db-entity';
import { WalletDbEntity } from '../../infrastructure/database/entities/wallet.db-entity';
import { WagerTransactionDbEntity } from '../../infrastructure/database/entities/wager-transaction.db-entity';
import { WalletLedgerEntryDbEntity } from '../../infrastructure/database/entities/wallet-ledger-entry.db-entity';
import { OutboxEventDbEntity } from '../../infrastructure/database/entities/outbox-event.db-entity';
import { Money } from '../../domain/value-objects/money.vo';
import { Wallet } from '../../domain/entities/wallet.entity';
import {
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from '../../domain/entities/wager-transaction.entity';
import {
    WalletLedgerEntry,
    LedgerDirection,
} from '../../domain/entities/wallet-ledger-entry.entity';
import { WagerRuleEngine } from '../../domain/wager/wager-rule-engine';
import { FailureCode } from '../../domain/wager/failure-code';
import {
    WalletBalanceChanged,
    WagerTransactionProcessed,
    WagerTransactionRejected,
    WagerTransactionPendingReference,
} from '../../domain/events/integration-event';
import { MetricsService } from '../../common/metrics/metrics.service';

export interface SubmitTransactionInput {
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: {
        amount: string;
        currency: string;
    };
    referenceExternalTransactionId?: string;
}

export interface SubmitTransactionOutput {
    transactionId: string;
    status: WagerTransactionStatus;
    balance: {
        amount: string;
        currency: string;
    };
    idempotentReplay: boolean;
    failureCode?: FailureCode;
}

/**
 * Use case único compartilhado por HTTP e SQS.
 *
 * Invariantes garantidos nesta unidade:
 * 1. Idempotência persistente (tabela + advisory lock) — nunca cache em memória.
 * 2. Lock pessimista por wallet (FOR UPDATE) — unidade de concorrência = walletId.
 * 3. Mutação financeira + ledger + outbox + idempotency_keys na MESMA transação SQL
 *    (Transactional Outbox: publicar só após commit).
 */
@Injectable()
export class SubmitWagerTransactionService {
    constructor(
        private readonly em: EntityManager,
        @Optional() private readonly metrics?: MetricsService,
    ) { }

    public async execute(
        idempotencyKeyHeader: string,
        dto: SubmitTransactionInput,
        options?: { entityManager?: EntityManager; correlationId?: string },
    ): Promise<{ statusCode: number; body: SubmitTransactionOutput }> {
        const correlationId = options?.correlationId ?? idempotencyKeyHeader;
        const rootEm = options?.entityManager ?? this.em;

        // Subconjunto de campos de negócio para hash canônico (header/transporte fora do hash).
        const businessPayload = {
            amount: dto.money.amount,
            currency: dto.money.currency,
            externalTransactionId: dto.externalTransactionId,
            gameId: dto.gameId,
            kind: dto.kind,
            playerId: dto.playerId,
            providerId: dto.providerId,
            referenceExternalTransactionId: dto.referenceExternalTransactionId ?? null,
            roundId: dto.roundId,
            walletId: dto.walletId,
        };

        const incomingPayloadHash = CanonicalJsonHasher.hash(businessPayload);

        try {
            return await rootEm.transactional(async (txEm) => {
                // Serializa concorrentes com a mesma Idempotency-Key sem lock global de wallets.
                await txEm.getConnection().execute(
                    'SELECT pg_advisory_xact_lock(hashtext(?))',
                    [idempotencyKeyHeader],
                    'all',
                    txEm.getTransactionContext(),
                );

                const existingIdempotency = await txEm.findOne(IdempotencyKeyDbEntity, {
                    key: idempotencyKeyHeader,
                });

                if (existingIdempotency) {
                    if (existingIdempotency.payloadHash !== incomingPayloadHash) {
                        throw new ConflictException(
                            `A Idempotency-Key "${idempotencyKeyHeader}" já foi registrada com um payload divergente.`,
                        );
                    }

                    const savedResponse = existingIdempotency.responseBody as unknown as SubmitTransactionOutput;
                    return {
                        statusCode: existingIdempotency.responseStatus,
                        body: { ...savedResponse, idempotentReplay: true },
                    };
                }

                // SELECT ... FOR UPDATE na linha da carteira — hot wallets serializam; wallets distintas paralelizam.
                const walletDb = await txEm.findOne(
                    WalletDbEntity,
                    { id: dto.walletId },
                    { lockMode: LockMode.PESSIMISTIC_WRITE },
                );

                if (!walletDb) {
                    throw new NotFoundException(`Carteira ${dto.walletId} não encontrada.`);
                }

                if (walletDb.playerId !== dto.playerId) {
                    throw new UnprocessableEntityException({
                        failureCode: FailureCode.INVALID_REFERENCE_METADATA,
                        message: 'playerId não corresponde à carteira informada.',
                    });
                }

                if (walletDb.currency !== dto.money.currency) {
                    throw new UnprocessableEntityException({
                        failureCode: FailureCode.CURRENCY_MISMATCH,
                        message: 'Moeda da operação diverge da moeda da carteira.',
                    });
                }

                const wallet = Wallet.rehydrate({
                    id: walletDb.id,
                    playerId: walletDb.playerId,
                    currency: walletDb.currency,
                    balance: Money.fromCents(walletDb.balance, walletDb.currency),
                    version: walletDb.version,
                    createdAt: walletDb.createdAt,
                    updatedAt: walletDb.updatedAt,
                });

                let operationMoney: Money;
                try {
                    operationMoney = Money.from(dto.money);
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : 'Payload monetário inválido.';
                    throw new BadRequestException(message);
                }

                let wagerTx: WagerTransaction;
                try {
                    wagerTx = WagerTransaction.create({
                        id: randomUUID(),
                        providerId: dto.providerId,
                        externalTransactionId: dto.externalTransactionId,
                        idempotencyKey: idempotencyKeyHeader,
                        payloadHash: incomingPayloadHash,
                        walletId: dto.walletId,
                        playerId: dto.playerId,
                        roundId: dto.roundId,
                        gameId: dto.gameId,
                        kind: dto.kind,
                        money: operationMoney,
                        referenceExternalTransactionId: dto.referenceExternalTransactionId,
                    });
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : 'Transação inválida.';
                    throw new BadRequestException(message);
                }

                // Resolve referência (REFUND/ROLLBACK) por (providerId, externalTransactionId).
                let reference: WagerTransaction | undefined;
                if (wagerTx.requiresReference() && dto.referenceExternalTransactionId) {
                    const refDb = await txEm.findOne(WagerTransactionDbEntity, {
                        providerId: dto.providerId,
                        externalTransactionId: dto.referenceExternalTransactionId,
                    });

                    if (refDb) {
                        reference = WagerTransaction.rehydrate({
                            id: refDb.id,
                            providerId: refDb.providerId,
                            externalTransactionId: refDb.externalTransactionId,
                            idempotencyKey: refDb.idempotencyKey,
                            payloadHash: refDb.payloadHash,
                            walletId: refDb.walletId,
                            playerId: refDb.playerId,
                            roundId: refDb.roundId,
                            gameId: refDb.gameId,
                            kind: refDb.kind as WagerTransactionKind,
                            money: Money.fromCents(refDb.amount, refDb.currency),
                            referenceExternalTransactionId: refDb.referenceExternalTransactionId,
                            createdAt: refDb.createdAt,
                            status: refDb.status as WagerTransactionStatus,
                            referenceTransactionId: refDb.referenceTransactionId,
                            failureCode: refDb.failureCode as FailureCode | undefined,
                            processedAt: refDb.processedAt,
                        });
                    }
                }

                // Anti double-reversal: mesma referência + mesmo kind já PROCESSED.
                const alreadyReversedIds = new Set<string>();
                if (reference) {
                    const prior = await txEm.find(WagerTransactionDbEntity, {
                        providerId: dto.providerId,
                        referenceExternalTransactionId: reference.externalTransactionId,
                        kind: dto.kind,
                        status: WagerTransactionStatus.Processed,
                    });
                    if (prior.length > 0) {
                        alreadyReversedIds.add(reference.id);
                    }
                }

                const evaluation = WagerRuleEngine.evaluate(
                    wagerTx,
                    wallet,
                    reference,
                    alreadyReversedIds,
                );

                let httpResponseStatus = 200;
                const outboxEvents: OutboxEventDbEntity[] = [];
                const eventCtx = { correlationId, causationId: wagerTx.id };

                if (evaluation.isPendingReference) {
                    // Referência ausente (at-least-once / fora de ordem) → PENDING_REFERENCE + worker.
                    wagerTx.markPendingReference();
                    httpResponseStatus = 202;
                    outboxEvents.push(
                        this.toOutbox(
                            WagerTransactionPendingReference.from(wagerTx, eventCtx).toJSON(),
                        ),
                    );
                } else if (!evaluation.shouldApply) {
                    const code = evaluation.failureCode ?? FailureCode.UNSUPPORTED_OPERATION;
                    wagerTx.reject(code);
                    httpResponseStatus = 422;
                    outboxEvents.push(
                        this.toOutbox(
                            WagerTransactionRejected.from(wagerTx, code, eventCtx).toJSON(),
                        ),
                    );
                } else {
                    // LOSS: PROCESSED sem ledger / sem movimento de saldo.
                    if (evaluation.direction && evaluation.moneyToApply) {
                        const moneyToApply = evaluation.moneyToApply;
                        const mutation =
                            evaluation.direction === LedgerDirection.Debit
                                ? wallet.debit(moneyToApply)
                                : wallet.credit(moneyToApply);

                        wagerTx.markProcessed(reference?.id, new Date());

                        const ledgerEntry = WalletLedgerEntry.create({
                            id: randomUUID(),
                            walletId: wallet.id,
                            transactionId: wagerTx.id,
                            direction: evaluation.direction,
                            money: moneyToApply,
                            balanceBefore: mutation.balanceBefore,
                            balanceAfter: mutation.balanceAfter,
                        });

                        walletDb.balance = wallet.balance.toCents().toString();
                        walletDb.version = wallet.version;
                        walletDb.updatedAt = wallet.updatedAt;

                        txEm.persist(
                            txEm.create(WalletLedgerEntryDbEntity, {
                                id: ledgerEntry.id,
                                walletId: ledgerEntry.walletId,
                                transactionId: ledgerEntry.transactionId,
                                direction: ledgerEntry.direction,
                                amount: ledgerEntry.money.toCents().toString(),
                                balanceBefore: ledgerEntry.balanceBefore.toCents().toString(),
                                balanceAfter: ledgerEntry.balanceAfter.toCents().toString(),
                                createdAt: ledgerEntry.createdAt,
                            }),
                        );

                        outboxEvents.push(
                            this.toOutbox(
                                WalletBalanceChanged.from(wallet, ledgerEntry, eventCtx).toJSON(),
                            ),
                        );
                    } else {
                        wagerTx.markProcessed(reference?.id, new Date());
                    }

                    outboxEvents.push(
                        this.toOutbox(
                            WagerTransactionProcessed.from(wagerTx, wallet, eventCtx).toJSON(),
                        ),
                    );
                }

                const txDb = txEm.create(WagerTransactionDbEntity, {
                    id: wagerTx.id,
                    providerId: wagerTx.providerId,
                    externalTransactionId: wagerTx.externalTransactionId,
                    idempotencyKey: wagerTx.idempotencyKey,
                    payloadHash: wagerTx.payloadHash,
                    walletId: wagerTx.walletId,
                    playerId: wagerTx.playerId,
                    roundId: wagerTx.roundId,
                    gameId: wagerTx.gameId,
                    kind: wagerTx.kind,
                    amount: wagerTx.money.toCents().toString(),
                    currency: wagerTx.money.currency,
                    referenceExternalTransactionId: wagerTx.referenceExternalTransactionId,
                    referenceTransactionId: wagerTx.referenceTransactionId,
                    status: wagerTx.status,
                    failureCode: wagerTx.failureCode,
                    createdAt: wagerTx.createdAt,
                    processedAt: wagerTx.processedAt,
                });

                const responseBody: SubmitTransactionOutput = {
                    transactionId: wagerTx.id,
                    status: wagerTx.status,
                    balance: wallet.balance.toJSON(),
                    idempotentReplay: false,
                    failureCode: wagerTx.failureCode,
                };

                const idempotencyDb = txEm.create(IdempotencyKeyDbEntity, {
                    key: idempotencyKeyHeader,
                    providerId: dto.providerId,
                    externalTransactionId: dto.externalTransactionId,
                    payloadHash: incomingPayloadHash,
                    responseStatus: httpResponseStatus,
                    responseBody: responseBody as unknown as Record<string, unknown>,
                    createdAt: new Date(),
                });

                // Commit atômico: wallet + tx + ledger + outbox + idempotency. Publish é pós-commit.
                txEm.persist([txDb, walletDb, idempotencyDb, ...outboxEvents]);

                return { statusCode: httpResponseStatus, body: responseBody };
            });
        } catch (error: unknown) {
            if (this.isLockConflict(error)) {
                this.metrics?.lockConflictsTotal.inc();
            }
            throw error;
        }
    }

    private isLockConflict(error: unknown): boolean {
        const candidate = error as { code?: string; cause?: { code?: string }; message?: string };
        const code = candidate.code ?? candidate.cause?.code;
        return code === '40P01' || code === '55P03' || /lock timeout|deadlock detected/i.test(candidate.message ?? '');
    }

    private toOutbox(envelope: {
        eventId: string;
        eventType: string;
        aggregateId: string;
        occurredAt: string;
        [key: string]: unknown;
    }): OutboxEventDbEntity {
        const row = new OutboxEventDbEntity();
        row.id = envelope.eventId;
        row.aggregateId = envelope.aggregateId;
        row.eventType = envelope.eventType;
        row.payload = envelope as Record<string, unknown>;
        row.occurredAt = new Date(envelope.occurredAt);
        row.attempts = 0;
        row.nextAttemptAt = new Date();
        row.createdAt = new Date();
        return row;
    }
}
