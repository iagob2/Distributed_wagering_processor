import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver, EntityManager } from '@mikro-orm/postgresql';
import { WalletDbEntity } from '../../src/infrastructure/database/entities/wallet.db-entity';
import { WalletLedgerEntryDbEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.db-entity';
import { WagerTransactionDbEntity } from '../../src/infrastructure/database/entities/wager-transaction.db-entity';
import { IdempotencyKeyDbEntity } from '../../src/infrastructure/database/entities/idempotency-key.db-entity';
import { OutboxEventDbEntity } from '../../src/infrastructure/database/entities/outbox-event.db-entity';
import { InboxMessageDbEntity } from '../../src/infrastructure/database/entities/inbox-message.db-entity';
import { SubmitWagerTransactionService } from '../../src/application/services/submit-wager-transaction.service';
import { Wallet } from '../../src/domain/entities/wallet.entity';
import { Money } from '../../src/domain/value-objects/money.vo';
import { LedgerDirection } from '../../src/domain/entities/wallet-ledger-entry.entity';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/entities/wager-transaction.entity';
import { randomUUID } from 'crypto';

export interface TestContext {
    orm: MikroORM;
    em: EntityManager;
    submitService: SubmitWagerTransactionService;
    createWallet: (walletId: string, playerId: string, amount: string, currency?: string) => Promise<void>;
    getReconciliation: (walletId: string) => Promise<{ consistent: boolean; storedCents: bigint; calculatedCents: bigint; totalEntries: number }>;
}

let sharedOrm: MikroORM | null = null;

export async function createTestContainerContext(): Promise<TestContext> {
    if (!sharedOrm) {
        sharedOrm = await MikroORM.init({
            driver: PostgreSqlDriver,
            entities: [
                WalletDbEntity,
                WalletLedgerEntryDbEntity,
                WagerTransactionDbEntity,
                IdempotencyKeyDbEntity,
                OutboxEventDbEntity,
                InboxMessageDbEntity,
            ],
            dbName: 'wagering_db',
            user: 'postgres',
            password: 'postgrespassword',
            host: '127.0.0.1',
            port: 5432,
            debug: false,
            pool: { min: 2, max: 60 }, // Pool largo para suportar até 50 requisições simultâneas
        });
    }

    const em = sharedOrm.em.fork() as EntityManager;
    const submitService = new SubmitWagerTransactionService(em);

    const createWallet = async (walletId: string, playerId: string, amount: string, currency = 'BRL') => {
        const forkEm = sharedOrm!.em.fork() as EntityManager;
        await forkEm.transactional(async (txEm) => {
            const money = Money.from({ amount, currency });
            const wallet = Wallet.open({ id: walletId, playerId, initialBalance: money });

            const walletDb = txEm.create(WalletDbEntity, {
                id: wallet.id,
                playerId: wallet.playerId,
                currency: wallet.currency,
                balance: wallet.balance.toCents().toString(),
                version: 1,
                createdAt: wallet.createdAt,
                updatedAt: wallet.updatedAt,
            });
            txEm.persist(walletDb);
            await txEm.flush();

            if (money.isPositive()) {
                const txId = randomUUID();
                const txDb = txEm.create(WagerTransactionDbEntity, {
                    id: txId,
                    providerId: 'INTERNAL',
                    externalTransactionId: `INIT-${walletId}`,
                    idempotencyKey: `init:${walletId}`,
                    payloadHash: 'initial_hash',
                    walletId: wallet.id,
                    playerId: wallet.playerId,
                    roundId: `round-init-${walletId}`,
                    gameId: 'system',
                    kind: WagerTransactionKind.Opening,
                    amount: money.toCents().toString(),
                    currency: money.currency,
                    status: WagerTransactionStatus.Processed,
                    createdAt: new Date(),
                    processedAt: new Date(),
                });
                txEm.persist(txDb);
                await txEm.flush();

                const ledgerDb = txEm.create(WalletLedgerEntryDbEntity, {
                    id: randomUUID(),
                    walletId: wallet.id,
                    transactionId: txId,
                    direction: LedgerDirection.Credit,
                    amount: money.toCents().toString(),
                    balanceBefore: '0',
                    balanceAfter: money.toCents().toString(),
                    createdAt: new Date(),
                });

                txEm.persist(ledgerDb);
            }
        });
    };

    const getReconciliation = async (walletId: string) => {
        const forkEm = sharedOrm!.em.fork() as EntityManager;
        const wallet = await forkEm.findOne(WalletDbEntity, { id: walletId });
        if (!wallet) throw new Error('Carteira não encontrada.');

        const entries = await forkEm.find(
            WalletLedgerEntryDbEntity,
            { walletId },
            { orderBy: { createdAt: 'ASC', id: 'ASC' } },
        );

        let calculatedCents = 0n;
        for (const entry of entries) {
            if (entry.direction === 'CREDIT') {
                calculatedCents += BigInt(entry.amount);
            } else {
                calculatedCents -= BigInt(entry.amount);
            }
        }

        const storedCents = BigInt(wallet.balance);
        return {
            consistent: storedCents === calculatedCents,
            storedCents,
            calculatedCents,
            totalEntries: entries.length,
        };
    };

    return { orm: sharedOrm, em, submitService, createWallet, getReconciliation };
}

export async function destroyTestContext(): Promise<void> {
    if (sharedOrm) {
        await sharedOrm.close();
        sharedOrm = null;
    }
}