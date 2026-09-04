import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/entities/wager-transaction.entity';
import { WalletDbEntity } from '../../src/infrastructure/database/entities/wallet.db-entity';
import { createTestContainerContext, destroyTestContext, TestContext } from '../helpers/test-setup';

type ChildResult = {
    status?: WagerTransactionStatus;
    statusCode?: number;
    error?: string;
};

describe('Concurrency: Multi-Process OS Race Condition', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestContainerContext();
    });

    afterAll(async () => {
        await destroyTestContext();
    });

    it('serializa três processos reais disputando a mesma carteira', async () => {
        const walletId = randomUUID();
        const playerId = `player-os-${randomUUID()}`;
        const runToken = randomUUID();
        await ctx.createWallet(walletId, playerId, '100.00', 'BRL');

        const childScript = `
            import { MikroORM } from '@mikro-orm/core';
            import { PostgreSqlDriver, EntityManager } from '@mikro-orm/postgresql';
            import { SubmitWagerTransactionService } from './src/application/services/submit-wager-transaction.service';
            import { WagerTransactionKind } from './src/domain/entities/wager-transaction.entity';
            import { WalletDbEntity } from './src/infrastructure/database/entities/wallet.db-entity';
            import { WalletLedgerEntryDbEntity } from './src/infrastructure/database/entities/wallet-ledger-entry.db-entity';
            import { WagerTransactionDbEntity } from './src/infrastructure/database/entities/wager-transaction.db-entity';
            import { IdempotencyKeyDbEntity } from './src/infrastructure/database/entities/idempotency-key.db-entity';
            import { OutboxEventDbEntity } from './src/infrastructure/database/entities/outbox-event.db-entity';
            import { InboxMessageDbEntity } from './src/infrastructure/database/entities/inbox-message.db-entity';

            const [processId, childWalletId, childPlayerId] = Bun.argv.slice(-3);
            const orm = await MikroORM.init({
                driver: PostgreSqlDriver,
                entities: [WalletDbEntity, WalletLedgerEntryDbEntity, WagerTransactionDbEntity, IdempotencyKeyDbEntity, OutboxEventDbEntity, InboxMessageDbEntity],
                dbName: process.env.DB_NAME ?? 'wagering_db',
                user: process.env.DB_USER ?? 'postgres',
                password: process.env.DB_PASSWORD ?? 'postgrespassword',
                host: process.env.DB_HOST ?? '127.0.0.1',
                port: Number(process.env.DB_PORT ?? 5432),
                pool: { min: 1, max: 2 },
            });
            const service = new SubmitWagerTransactionService(orm.em.fork() as EntityManager);
            try {
                const result = await service.execute('os:' + processId, {
                    providerId: 'provider-os',
                    externalTransactionId: 'tx-os-' + processId,
                    playerId: childPlayerId,
                    walletId: childWalletId,
                    roundId: 'round-os',
                    gameId: 'game-os',
                    kind: WagerTransactionKind.Bet,
                    money: { amount: '60.00', currency: 'BRL' },
                });
                process.stdout.write(JSON.stringify({ status: result.body.status, statusCode: result.statusCode }));
            } catch (error) {
                process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            } finally {
                await orm.close();
            }
        `;

        const runProcess = async (processId: string): Promise<ChildResult> => {
            const childProcess = Bun.spawn(['bun', '-e', childScript, processId, walletId, playerId], {
                stdout: 'pipe',
                stderr: 'pipe',
                env: process.env,
            });
            const [stdout, stderr] = await Promise.all([
                new Response(childProcess.stdout).text(),
                new Response(childProcess.stderr).text(),
            ]);
            const exitCode = await childProcess.exited;
            if (exitCode !== 0) throw new Error(`Worker ${processId} terminou com ${exitCode}: ${stderr}`);
            return JSON.parse(stdout.trim()) as ChildResult;
        };

        const results = await Promise.all(['1', '2', '3'].map((id) => runProcess(`${runToken}-${id}`)));
        const successes = results.filter((result) => result.status === WagerTransactionStatus.Processed);
        const rejected = results.filter((result) => result.status === WagerTransactionStatus.Rejected);
        if (successes.length !== 1 || rejected.length !== 2) {
            throw new Error(`Resultados dos processos OS inválidos: ${JSON.stringify(results)}`);
        }

        const freshWallet = await (ctx.orm.em.fork() as EntityManager).findOneOrFail(WalletDbEntity, { id: walletId });
        expect(BigInt(freshWallet.balance)).toBe(4000n);
    });
});
