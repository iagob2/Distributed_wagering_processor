import { describe, expect, it } from 'bun:test';
import {
    InconsistentLedgerEntryError,
    LedgerDirection,
    WalletLedgerEntry,
} from '../../src/domain/entities/wallet-ledger-entry.entity';
import { Money } from '../../src/domain/value-objects/money.vo';

describe('Entity: WalletLedgerEntry', () => {
    it('deve criar uma entrada de débito válida quando a conta fecha perfeitamente', () => {
        const before = Money.from({ amount: '100.00', currency: 'BRL' });
        const amount = Money.from({ amount: '25.00', currency: 'BRL' });
        const after = Money.from({ amount: '75.00', currency: 'BRL' });

        const entry = WalletLedgerEntry.create({
            id: 'ledger-1',
            walletId: 'wallet-1',
            transactionId: 'tx-1',
            direction: LedgerDirection.Debit,
            money: amount,
            balanceBefore: before,
            balanceAfter: after,
        });

        expect(entry.id).toBe('ledger-1');
        expect(entry.direction).toBe(LedgerDirection.Debit);
        expect(entry.isBalanced()).toBe(true);
    });

    it('deve criar uma entrada de crédito válida quando a conta fecha perfeitamente', () => {
        const before = Money.from({ amount: '50.00', currency: 'BRL' });
        const amount = Money.from({ amount: '30.00', currency: 'BRL' });
        const after = Money.from({ amount: '80.00', currency: 'BRL' });

        const entry = WalletLedgerEntry.create({
            id: 'ledger-2',
            walletId: 'wallet-1',
            transactionId: 'tx-2',
            direction: LedgerDirection.Credit,
            money: amount,
            balanceBefore: before,
            balanceAfter: after,
        });

        expect(entry.direction).toBe(LedgerDirection.Credit);
        expect(entry.isBalanced()).toBe(true);
    });

    it('deve lançar InconsistentLedgerEntryError se balanceBefore - amount != balanceAfter no débito', () => {
        const before = Money.from({ amount: '100.00', currency: 'BRL' });
        const amount = Money.from({ amount: '20.00', currency: 'BRL' });
        // Valor errado proposital (deveria ser 80.00)
        const afterErrado = Money.from({ amount: '70.00', currency: 'BRL' });

        expect(() =>
            WalletLedgerEntry.create({
                id: 'ledger-err',
                walletId: 'wallet-1',
                transactionId: 'tx-err',
                direction: LedgerDirection.Debit,
                money: amount,
                balanceBefore: before,
                balanceAfter: afterErrado,
            }),
        ).toThrow(InconsistentLedgerEntryError);
    });

    it('deve rejeitar lançamentos com montante zero', () => {
        const before = Money.from({ amount: '100.00', currency: 'BRL' });
        const zero = Money.zero('BRL');

        expect(() =>
            WalletLedgerEntry.create({
                id: 'ledger-zero',
                walletId: 'wallet-1',
                transactionId: 'tx-zero',
                direction: LedgerDirection.Debit,
                money: zero,
                balanceBefore: before,
                balanceAfter: before,
            }),
        ).toThrow(InconsistentLedgerEntryError);
    });
});