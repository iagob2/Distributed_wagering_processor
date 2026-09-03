import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { EntityManager } from '@mikro-orm/postgresql';
import { createTestContainerContext, destroyTestContext, TestContext } from '../helpers/test-setup';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/entities/wager-transaction.entity';
import { WalletLedgerEntryDbEntity } from '../../src/infrastructure/database/entities/wallet-ledger-entry.db-entity';
import { SubmitWagerTransactionService } from '../../src/application/services/submit-wager-transaction.service';
import { randomUUID } from 'crypto';

describe('Concorrência: Disputa Simultânea de Saldo (Cenário Obrigatório Seção 8)', () => {
    let ctx: TestContext;

    beforeAll(async () => {
        ctx = await createTestContainerContext();
    });

    afterAll(async () => {
        await destroyTestContext();
    });

    it('deve debitar exatamente uma aposta de 80.00 BRL e rejeitar a segunda com saldo inicial de 100.00 BRL', async () => {
        const walletId = randomUUID();
        const playerId = `player-race-${randomUUID()}`;

        // 1. Cria a carteira com saldo inicial de 100.00 BRL
        await ctx.createWallet(walletId, playerId, '100.00', 'BRL');

        const betA = {
            providerId: 'provider-race',
            externalTransactionId: `tx-bet-a-${randomUUID()}`,
            playerId,
            walletId,
            roundId: `round-a-${randomUUID()}`,
            gameId: 'fortune-tiger',
            kind: WagerTransactionKind.Bet,
            money: { amount: '80.00', currency: 'BRL' },
        };

        const betB = {
            providerId: 'provider-race',
            externalTransactionId: `tx-bet-b-${randomUUID()}`,
            playerId,
            walletId,
            roundId: `round-b-${randomUUID()}`,
            gameId: 'fortune-tiger',
            kind: WagerTransactionKind.Bet,
            money: { amount: '80.00', currency: 'BRL' },
        };

        // 2. Cada execução recebe um EntityManager forkado exclusivamente para ela
        const emA = ctx.orm.em.fork() as EntityManager;
        const emB = ctx.orm.em.fork() as EntityManager;

        const serviceA = new SubmitWagerTransactionService(emA);
        const serviceB = new SubmitWagerTransactionService(emB);

        // 3. Execução em paralelo disputando a linha da carteira via SELECT FOR UPDATE
        const [resA, resB] = await Promise.all([
            serviceA.execute(`key-a-${randomUUID()}`, betA),
            serviceB.execute(`key-b-${randomUUID()}`, betB),
        ]);

        const statuses = [resA.body.status, resB.body.status];

        // Exatamente uma aposta aprovada e uma rejeitada
        expect(statuses).toContain(WagerTransactionStatus.Processed);
        expect(statuses).toContain(WagerTransactionStatus.Rejected);

        // O status code reflete o resultado: 200 para aprovada e 422 para saldo insuficiente
        const rejectedResult = resA.body.status === WagerTransactionStatus.Rejected ? resA : resB;
        const processedResult = resA.body.status === WagerTransactionStatus.Processed ? resA : resB;

        expect(processedResult.statusCode).toBe(200);
        expect(rejectedResult.statusCode).toBe(422);

        // Saldo final deve ser rigorosamente 20.00 BRL
        expect(processedResult.body.balance.amount).toBe('20.00');

        // 4. Validação na persistência (PostgreSQL)
        const verifyEm = ctx.orm.em.fork() as EntityManager;
        const ledgerDebits = await verifyEm.find(WalletLedgerEntryDbEntity, {
            walletId,
            direction: 'DEBIT',
        });

        // Exatamente 1 débito de 80.00 registrado no ledger
        expect(ledgerDebits.length).toBe(1);
        expect(ledgerDebits[0].amount).toBe('8000');

        // 5. Invariante Global: Conciliação Contábil
        const report = await ctx.getReconciliation(walletId);
        expect(report.consistent).toBe(true);
        expect(report.storedCents).toBe(2000n);
        expect(report.calculatedCents).toBe(2000n);
        expect(report.totalEntries).toBe(2); // 1 Abertura (Credit) + 1 Aposta (Debit)
    });
});