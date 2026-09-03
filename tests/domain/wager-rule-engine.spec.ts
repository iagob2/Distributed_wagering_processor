import { describe, expect, it } from 'bun:test';
import { WagerRuleEngine } from '../../src/domain/wager/wager-rule-engine';
import { FailureCode } from '../../src/domain/wager/failure-code';
import { Wallet } from '../../src/domain/entities/wallet.entity';
import {
    WagerTransaction,
    WagerTransactionKind,
} from '../../src/domain/entities/wager-transaction.entity';
import { LedgerDirection } from '../../src/domain/entities/wallet-ledger-entry.entity';
import { Money } from '../../src/domain/value-objects/money.vo';

describe('WagerRuleEngine', () => {
    const currency = 'BRL';

    const makeBet = (id: string, amount: string) =>
        WagerTransaction.create({
            id,
            providerId: 'provider-1',
            externalTransactionId: `ext-${id}`,
            idempotencyKey: `key-${id}`,
            payloadHash: 'hash',
            walletId: 'wallet-1',
            playerId: 'player-1',
            roundId: 'round-1',
            gameId: 'game-1',
            kind: WagerTransactionKind.Bet,
            money: Money.from({ amount, currency }),
        });

    it('deve debitar em BET quando há saldo e rejeitar com INSUFFICIENT_FUNDS quando não há', () => {
        const wallet = Wallet.open({
            id: 'wallet-1',
            playerId: 'player-1',
            initialBalance: Money.from({ amount: '50.00', currency }),
        });

        const bet1 = makeBet('bet-1', '30.00');
        const result1 = WagerRuleEngine.evaluate(bet1, wallet);
        expect(result1.shouldApply).toBe(true);
        expect(result1.direction).toBe(LedgerDirection.Debit);

        const bet2 = makeBet('bet-2', '60.00');
        const result2 = WagerRuleEngine.evaluate(bet2, wallet);
        expect(result2.shouldApply).toBe(false);
        expect(result2.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    });

    it('deve sinalizar PENDING_REFERENCE caso REFUND chegue sem referência', () => {
        const wallet = Wallet.open({
            id: 'wallet-1',
            playerId: 'player-1',
            initialBalance: Money.from({ amount: '10.00', currency }),
        });

        const refundTx = WagerTransaction.create({
            id: 'refund-1',
            providerId: 'provider-1',
            externalTransactionId: 'ext-ref-1',
            idempotencyKey: 'key-ref-1',
            payloadHash: 'hash',
            walletId: 'wallet-1',
            playerId: 'player-1',
            roundId: 'round-1',
            gameId: 'game-1',
            kind: WagerTransactionKind.Refund,
            money: Money.from({ amount: '30.00', currency }),
            referenceExternalTransactionId: 'ext-bet-1',
        });

        const result = WagerRuleEngine.evaluate(refundTx, wallet, undefined);
        expect(result.shouldApply).toBe(false);
        expect(result.isPendingReference).toBe(true);
    });

    it('deve creditar no REFUND quando a referência de BET estiver processada', () => {
        const wallet = Wallet.open({
            id: 'wallet-1',
            playerId: 'player-1',
            initialBalance: Money.from({ amount: '20.00', currency }),
        });

        const bet = makeBet('bet-1', '30.00');
        bet.markProcessed(undefined);

        const refundTx = WagerTransaction.create({
            id: 'refund-1',
            providerId: 'provider-1',
            externalTransactionId: 'ext-ref-1',
            idempotencyKey: 'key-ref-1',
            payloadHash: 'hash',
            walletId: 'wallet-1',
            playerId: 'player-1',
            roundId: 'round-1',
            gameId: 'game-1',
            kind: WagerTransactionKind.Refund,
            money: Money.from({ amount: '30.00', currency }),
            referenceExternalTransactionId: bet.externalTransactionId,
        });

        const result = WagerRuleEngine.evaluate(refundTx, wallet, bet);
        expect(result.shouldApply).toBe(true);
        expect(result.direction).toBe(LedgerDirection.Credit);
        expect(result.moneyToApply?.toString()).toBe('BRL 30.00');
    });

    it('deve rejeitar ROLLBACK com INSUFFICIENT_FUNDS_FOR_REVERSAL se a reversão de WIN deixar o saldo negativo', () => {
        const wallet = Wallet.open({
            id: 'wallet-1',
            playerId: 'player-1',
            initialBalance: Money.from({ amount: '50.00', currency }),
        });

        // Prêmio original de R$ 200.00 que foi sacado/gasto (saldo agora é só R$ 50.00)
        const winTx = WagerTransaction.create({
            id: 'win-1',
            providerId: 'provider-1',
            externalTransactionId: 'ext-win-1',
            idempotencyKey: 'key-win-1',
            payloadHash: 'hash',
            walletId: 'wallet-1',
            playerId: 'player-1',
            roundId: 'round-1',
            gameId: 'game-1',
            kind: WagerTransactionKind.Win,
            money: Money.from({ amount: '200.00', currency }),
        });
        winTx.markProcessed(undefined);

        const rollbackTx = WagerTransaction.create({
            id: 'roll-1',
            providerId: 'provider-1',
            externalTransactionId: 'ext-roll-1',
            idempotencyKey: 'key-roll-1',
            payloadHash: 'hash',
            walletId: 'wallet-1',
            playerId: 'player-1',
            roundId: 'round-1',
            gameId: 'game-1',
            kind: WagerTransactionKind.Rollback,
            money: Money.from({ amount: '200.00', currency }),
            referenceExternalTransactionId: winTx.externalTransactionId,
        });

        const result = WagerRuleEngine.evaluate(rollbackTx, wallet, winTx);
        expect(result.shouldApply).toBe(false);
        expect(result.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS_FOR_REVERSAL);
    });
});