import {
    Injectable,
    ConflictException,
    UnprocessableEntityException,
    NotFoundException,
} from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/postgresql';
import { CanonicalJsonHasher } from '../../common/utils/canonical-json-hasher.util';
import { IdempotencyKeyDbEntity } from '../../infrastructure/database/entities/idempotency-key.db-entity';
import { WalletDbEntity } from '../../infrastructure/database/entities/wallet.db-entity';
import { WagerTransactionDbEntity } from '../../infrastructure/database/entities/wager-transaction.db-entity';
import { WalletLedgerEntryDbEntity } from '../../infrastructure/database/entities/wallet-ledger-entry.db-entity';
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
import { randomUUID } from 'crypto';

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
}

@Injectable()
export class SubmitWagerTransactionService {
    constructor(private readonly em: EntityManager) { }

    public async execute(
        idempotencyKeyHeader: string,
        dto: SubmitTransactionInput,
    ): Promise<{ statusCode: number; body: SubmitTransactionOutput }> {
        // 1. Extração normalizada do payload de negócio para hash canônico
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

        // 2. Transação ACID isolada com o EntityManager do MikroORM
        return await this.em.transactional(async (txEm) => {
            // 2.1 Validação de idempotência persistente
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
                // Conflito: chave idêntica com payload modificado
                if (existingIdempotency.payloadHash !== incomingPayloadHash) {
                    throw new ConflictException(
                        `A Idempotency-Key "${idempotencyKeyHeader}" já foi registrada com um payload divergente.`,
                    );
                }

                // Replay seguro da resposta original gravada
                const savedResponse = existingIdempotency.responseBody as unknown as SubmitTransactionOutput;
                return {
                    statusCode: existingIdempotency.responseStatus,
                    body: {
                        ...savedResponse,
                        idempotentReplay: true,
                    },
                };
            }

            // 2.2 Bloqueio pessimista pontual na linha da carteira (SELECT ... FOR UPDATE)
            const walletDb = await txEm.findOne(
                WalletDbEntity,
                { id: dto.walletId },
                { lockMode: LockMode.PESSIMISTIC_WRITE },
            );

            if (!walletDb) {
                throw new NotFoundException(`Carteira ${dto.walletId} não encontrada.`);
            }

            if (walletDb.playerId !== dto.playerId || walletDb.currency !== dto.money.currency) {
                throw new UnprocessableEntityException('Dados cadastrais da carteira não conferem com a requisição.');
            }

            // 2.3 Reidratação do agregado de domínio
            const wallet = Wallet.rehydrate({
                id: walletDb.id,
                playerId: walletDb.playerId,
                currency: walletDb.currency,
                balance: Money.fromCents(walletDb.balance, walletDb.currency),
                version: walletDb.version,
                createdAt: walletDb.createdAt,
                updatedAt: walletDb.updatedAt,
            });

            const operationMoney = Money.from(dto.money);
            const transactionId = randomUUID();

            const wagerTx = WagerTransaction.create({
                id: transactionId,
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

            let httpResponseStatus = 200;

            // 2.4 Processamento da operação financeira
            if (dto.kind === WagerTransactionKind.Bet) {
                if (wallet.balance.isLessThan(operationMoney)) {
                    wagerTx.reject('INSUFFICIENT_FUNDS');
                    httpResponseStatus = 422;
                } else {
                    const { balanceBefore, balanceAfter } = wallet.debit(operationMoney);
                    wagerTx.markProcessed(undefined, new Date());

                    const ledgerEntry = WalletLedgerEntry.create({
                        id: randomUUID(),
                        walletId: wallet.id,
                        transactionId: wagerTx.id,
                        direction: LedgerDirection.Debit,
                        money: operationMoney,
                        balanceBefore,
                        balanceAfter,
                    });

                    // Atualiza registro no banco
                    walletDb.balance = wallet.balance.toCents().toString();
                    walletDb.version = wallet.version;
                    walletDb.updatedAt = wallet.updatedAt;

                    const ledgerDb = txEm.create(WalletLedgerEntryDbEntity, {
                        id: ledgerEntry.id,
                        walletId: ledgerEntry.walletId,
                        transactionId: ledgerEntry.transactionId,
                        direction: ledgerEntry.direction,
                        amount: ledgerEntry.money.toCents().toString(),
                        balanceBefore: ledgerEntry.balanceBefore.toCents().toString(),
                        balanceAfter: ledgerEntry.balanceAfter.toCents().toString(),
                        createdAt: ledgerEntry.createdAt,
                    });

                    txEm.persist(ledgerDb);
                }
            }

            // 2.5 Persistência da transação de aposta
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
            };

            // 2.6 Registro da chave de idempotência com a resposta exata
            const idempotencyDb = txEm.create(IdempotencyKeyDbEntity, {
                key: idempotencyKeyHeader,
                providerId: dto.providerId,
                externalTransactionId: dto.externalTransactionId,
                payloadHash: incomingPayloadHash,
                responseStatus: httpResponseStatus,
                responseBody: responseBody as unknown as Record<string, unknown>,
                createdAt: new Date(),
            });

            txEm.persist([txDb, walletDb, idempotencyDb]);

            return {
                statusCode: httpResponseStatus,
                body: responseBody,
            };
        });
    }
}