import { describe, expect, it } from 'bun:test';
import {
    LedgerDirection,
    WalletLedgerEntry,
} from '../../src/domain/entities/wallet-ledger-entry.entity';
import { Wallet } from '../../src/domain/entities/wallet.entity';
import {
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
} from '../../src/domain/entities/wager-transaction.entity';
import { Money } from '../../src/domain/value-objects/money.vo';

describe('Domain Integration: Wallet, Transaction & Ledger Consistency', () => {
    it('deve processar sequência de apostas e prêmios mantendo a carteira e o ledger estritamente reconciliados', () => {
        // 1. Abertura da Carteira com R$ 100.00
        const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });
        const wallet = Wallet.open({
            id: 'wallet-001',
            playerId: 'player-001',
            initialBalance,
        });

        const ledgerHistory: WalletLedgerEntry[] = [];

        // Lançamento de abertura no Ledger
        ledgerHistory.push(
            WalletLedgerEntry.create({
                id: 'ledger-opening',
                walletId: wallet.id,
                transactionId: 'tx-opening',
                direction: LedgerDirection.Credit,
                money: initialBalance,
                balanceBefore: Money.zero('BRL'),
                balanceAfter: initialBalance,
            }),
        );

        // 2. Operação 1: Aposta (BET) de R$ 30.00
        const betAmount = Money.from({ amount: '30.00', currency: 'BRL' });
        const betTx = WagerTransaction.create({
            id: 'tx-bet-1',
            providerId: 'provider-test',
            externalTransactionId: 'ext-bet-1',
            idempotencyKey: 'provider-test:ext-bet-1',
            payloadHash: 'hash-1',
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'round-100',
            gameId: 'fortune-tiger',
            kind: WagerTransactionKind.Bet,
            money: betAmount,
        });

        // Aplicação na Wallet e geração do snapshot contábil
        const betMutation = wallet.debit(betAmount);
        betTx.markProcessed(undefined);

        ledgerHistory.push(
            WalletLedgerEntry.create({
                id: 'ledger-bet-1',
                walletId: wallet.id,
                transactionId: betTx.id,
                direction: LedgerDirection.Debit,
                money: betAmount,
                balanceBefore: betMutation.balanceBefore,
                balanceAfter: betMutation.balanceAfter,
            }),
        );

        expect(wallet.balance.toString()).toBe('BRL 70.00');
        expect(wallet.version).toBe(2);
        expect(betTx.status).toBe(WagerTransactionStatus.Processed);

        // 3. Operação 2: Vitória (WIN) de R$ 50.00 na mesma rodada
        const winAmount = Money.from({ amount: '50.00', currency: 'BRL' });
        const winTx = WagerTransaction.create({
            id: 'tx-win-1',
            providerId: 'provider-test',
            externalTransactionId: 'ext-win-1',
            idempotencyKey: 'provider-test:ext-win-1',
            payloadHash: 'hash-2',
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: 'round-100',
            gameId: 'fortune-tiger',
            kind: WagerTransactionKind.Win,
            money: winAmount,
        });

        const winMutation = wallet.credit(winAmount);
        winTx.markProcessed(betTx.id);

        ledgerHistory.push(
            WalletLedgerEntry.create({
                id: 'ledger-win-1',
                walletId: wallet.id,
                transactionId: winTx.id,
                direction: LedgerDirection.Credit,
                money: winAmount,
                balanceBefore: winMutation.balanceBefore,
                balanceAfter: winMutation.balanceAfter,
            }),
        );

        expect(wallet.balance.toString()).toBe('BRL 120.00');
        expect(wallet.version).toBe(3);

        // 4. Auditoria e Reconciliação Matemática: Saldo = Σ(Créditos) - Σ(Débitos)
        let calculatedCents = 0n;
        for (const entry of ledgerHistory) {
            expect(entry.isBalanced()).toBe(true);
            if (entry.direction === LedgerDirection.Credit) {
                calculatedCents += entry.money.toCents();
            } else {
                calculatedCents -= entry.money.toCents();
            }
        }

        const calculatedBalance = Money.fromCents(calculatedCents, 'BRL');

        // Invariante inegociável do desafio
        expect(wallet.balance.equals(calculatedBalance)).toBe(true);
        expect(calculatedBalance.toString()).toBe('BRL 120.00');
    });
});