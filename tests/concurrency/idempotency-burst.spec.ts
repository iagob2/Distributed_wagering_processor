import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createTestContainerContext, destroyTestContext, TestContext } from '../helpers/test-setup';
import { EntityManager } from '@mikro-orm/postgresql';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/entities/wager-transaction.entity';
import { WagerTransactionDbEntity } from '../../src/infrastructure/database/entities/wager-transaction.db-entity';
import { WalletLedgerEntryDbEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.db-entity';
import { SubmitWagerTransactionService } from '../../src/application/services/submit-wager-transaction.service';
import { randomUUID } from 'crypto';

describe('Concorrência Extrema: Rajada de 50 Requisições com a Mesma Idempotency-Key', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestContainerContext();
    });

    afterAll(async () => {
        await destroyTestContext();
    });

    it('deve debitar exatamente uma única vez e retornar resposta consistente para as 49 réplicas', async () => {
        const walletId = randomUUID();
        const playerId = `player-burst-${randomUUID()}`;

        // Saldo inicial de 100.00 BRL
        await ctx.createWallet(walletId, playerId, '100.00', 'BRL');

        const idempotencyKey = `burst-key-${randomUUID()}`;
        const payload = {
            providerId: 'provider-burst',
            externalTransactionId: `ext-tx-${randomUUID()}`,
            playerId,
            walletId,
            roundId: `round-${randomUUID()}`,
            gameId: 'crash-game',
            kind: WagerTransactionKind.Bet,
            money: { amount: '35.00', currency: 'BRL' },
        };

        const startTime = performance.now();

        // 50 requisições simultâneas reais no pool de conexões do PostgreSQL
        const promises = Array.from({ length: 50 }).map(() => {
            const serviceFork = new SubmitWagerTransactionService(ctx.orm.em.fork() as EntityManager);
            return serviceFork.execute(idempotencyKey, payload);
        });

        const results = await Promise.all(promises);
        const totalLatencyMs = performance.now() - startTime;

        // Diagnóstico de tempo de execução total
        expect(totalLatencyMs).toBeLessThan(10000); // 50 chamadas devem resolver em menos de 10s no PostgreSQL local

        // 1. Verificação dos retornos HTTP/Serviço
        const processed = results.filter((r) => r.body.status === WagerTransactionStatus.Processed && !r.body.idempotentReplay);
        const replays = results.filter((r) => r.body.idempotentReplay);

        expect(processed.length).toBe(1);
        expect(replays.length).toBe(49);

        // Todas as 50 respostas devem informar exatamente o mesmo saldo final de 65.00 BRL
        for (const res of results) {
            expect(res.body.balance.amount).toBe('65.00');
            expect(res.body.balance.currency).toBe('BRL');
        }

        // 2. Prova de persistência no PostgreSQL: contagem estrita de registros
        const forkEm = ctx.orm.em.fork();
        const txRecords = await forkEm.find(WagerTransactionDbEntity, {
            idempotencyKey,
        });
        expect(txRecords.length).toBe(1); // Exatamente 1 registro criado

        const ledgerDebits = await forkEm.find(WalletLedgerEntryDbEntity, {
            walletId,
            direction: 'DEBIT',
        });
        expect(ledgerDebits.length).toBe(1); // Exatamente 1 débito no ledger

        // 3. Invariante Global: Conciliação Matemática Estrita
        const report = await ctx.getReconciliation(walletId);
        expect(report.consistent).toBe(true);
        expect(report.storedCents).toBe(6500n); // 65.00 BRL
        expect(report.calculatedCents).toBe(6500n);
    });
});