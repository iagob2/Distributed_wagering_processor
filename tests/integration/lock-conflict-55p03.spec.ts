import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { createTestContainerContext, destroyTestContext, TestContext } from '../helpers/test-setup';
import { WalletDbEntity } from '../../src/infrastructure/database/entities/wallet.db-entity';
import { randomUUID } from 'crypto';

describe('PostgreSQL Concurrency: Explicit 55P03 Lock Conflict', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestContainerContext();
    });

    afterAll(async () => {
        await destroyTestContext();
    });

    it('dispara 55P03 quando uma transação tenta NOWAIT em uma linha bloqueada', async () => {
        const em1 = ctx.orm.em.fork() as EntityManager;
        const em2 = ctx.orm.em.fork() as EntityManager;
        const wallet = em1.create(WalletDbEntity, {
            id: randomUUID(),
            playerId: `lock-${randomUUID()}`,
            currency: 'BRL',
            balance: '10000',
            version: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
        });
        await em1.persistAndFlush(wallet);

        let captured: unknown;
        await em1.transactional(async (tx1) => {
            await tx1.getConnection().execute(
                'SELECT id FROM wallets WHERE id = ? FOR UPDATE',
                [wallet.id],
                'all',
                tx1.getTransactionContext(),
            );

            try {
                await em2.transactional(async (tx2) => {
                    await tx2.getConnection().execute(
                        'SELECT id FROM wallets WHERE id = ? FOR UPDATE NOWAIT',
                        [wallet.id],
                        'all',
                        tx2.getTransactionContext(),
                    );
                });
            } catch (error: unknown) {
                captured = error;
            }
        });

        const candidate = captured as { code?: string; cause?: { code?: string }; message?: string };
        expect(candidate).toBeDefined();
        expect(candidate.code ?? candidate.cause?.code ?? candidate.message).toContain('55P03');
    });
});
