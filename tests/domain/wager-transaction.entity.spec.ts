import { describe, expect, it } from 'bun:test';
import { InvalidTransactionStateError } from '../../src/domain/errors/domain.error';
import {
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.entity';
import { Money } from '../../src/domain/value-objects/money.vo';

describe('Entity: WagerTransaction', () => {
    const baseProps = {
        id: 'tx-123',
        providerId: 'provider-a',
        externalTransactionId: 'ext-456',
        idempotencyKey: 'key-789',
        payloadHash: 'hash-abc',
        walletId: 'w-1',
        playerId: 'p-1',
        roundId: 'round-1',
        gameId: 'game-slot',
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
    };

    it('deve nascer no estado PENDING', () => {
        const tx = WagerTransaction.create({
            ...baseProps,
            kind: WagerTransactionKind.Bet,
        });

        expect(tx.status).toBe(WagerTransactionStatus.Pending);
        expect(tx.isTerminal()).toBe(false);
    });

    it('deve exigir referência externa para REFUND e ROLLBACK', () => {
        expect(() =>
            WagerTransaction.create({
                ...baseProps,
                kind: WagerTransactionKind.Refund,
            }),
        ).toThrow('Operações do tipo REFUND exigem uma transação de referência');

        expect(() =>
            WagerTransaction.create({
                ...baseProps,
                kind: WagerTransactionKind.Rollback,
            }),
        ).toThrow('Operações do tipo ROLLBACK exigem uma transação de referência');
    });

    it('deve rejeitar tentativa de transição a partir de estado terminal', () => {
        const tx = WagerTransaction.create({
            ...baseProps,
            kind: WagerTransactionKind.Bet,
        });

        tx.markProcessed(undefined);
        expect(tx.status).toBe(WagerTransactionStatus.Processed);
        expect(tx.isTerminal()).toBe(true);

        // Tentativa de rejeitar ou alterar uma transação já processada deve falhar
        expect(() => tx.reject('INSUFFICIENT_FUNDS')).toThrow(InvalidTransactionStateError);
        expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    });

    it('deve validar correspondência de hash do payload', () => {
        const tx = WagerTransaction.create({
            ...baseProps,
            kind: WagerTransactionKind.Bet,
        });

        expect(tx.matchesPayload('hash-abc')).toBe(true);
        expect(tx.matchesPayload('outro-hash')).toBe(false);
    });
});