import { describe, expect, it } from 'bun:test';
import { InsufficientFundsError } from '../../src/domain/errors/domain.error';
import { Wallet } from '../../src/domain/entities/wallet.entity';
import { Money } from '../../src/domain/value-objects/money.vo';

describe('Aggregate Root: Wallet', () => {
    it('deve abrir uma nova carteira com versão inicial 1', () => {
        const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });
        const wallet = Wallet.open({
            id: 'wallet-123',
            playerId: 'player-abc',
            initialBalance,
        });

        expect(wallet.id).toBe('wallet-123');
        expect(wallet.playerId).toBe('player-abc');
        expect(wallet.balance.toString()).toBe('BRL 100.00');
        expect(wallet.version).toBe(1);
    });

    it('deve creditar valor aumentando o saldo e incrementando a versão', () => {
        const wallet = Wallet.open({
            id: 'wallet-1',
            playerId: 'p-1',
            initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
        });

        const creditAmount = Money.from({ amount: '25.00', currency: 'BRL' });
        const mutation = wallet.credit(creditAmount);

        expect(mutation.balanceBefore.toString()).toBe('BRL 50.00');
        expect(mutation.balanceAfter.toString()).toBe('BRL 75.00');
        expect(wallet.balance.toString()).toBe('BRL 75.00');
        expect(wallet.version).toBe(2);
    });

    it('deve debitar saldo com sucesso quando houver fundos suficientes', () => {
        const wallet = Wallet.open({
            id: 'wallet-1',
            playerId: 'p-1',
            initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
        });

        const debitAmount = Money.from({ amount: '80.00', currency: 'BRL' });
        const mutation = wallet.debit(debitAmount);

        expect(mutation.balanceBefore.toString()).toBe('BRL 100.00');
        expect(mutation.balanceAfter.toString()).toBe('BRL 20.00');
        expect(wallet.balance.toString()).toBe('BRL 20.00');
        expect(wallet.version).toBe(2);
    });

    it('deve lançar InsufficientFundsError ao tentar debitar mais do que o saldo disponível', () => {
        const wallet = Wallet.open({
            id: 'wallet-1',
            playerId: 'p-1',
            initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
        });

        const debitAmount = Money.from({ amount: '150.00', currency: 'BRL' });

        expect(() => wallet.debit(debitAmount)).toThrow(InsufficientFundsError);
        expect(wallet.balance.toString()).toBe('BRL 100.00');
        expect(wallet.version).toBe(1); // Versão intocada
    });
});