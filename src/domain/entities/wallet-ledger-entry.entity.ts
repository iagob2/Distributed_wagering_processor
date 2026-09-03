import { DomainError } from '../errors/domain.error';
import { Money } from '../value-objects/money.vo';

export enum LedgerDirection {
    Debit = 'DEBIT',
    Credit = 'CREDIT',
}

export class InconsistentLedgerEntryError extends DomainError {
    public readonly code = 'INCONSISTENT_LEDGER_ENTRY';
    constructor(message: string) {
        super(message);
    }
}

export interface CreateLedgerEntryProps {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
    createdAt: Date;
}

export class WalletLedgerEntry {
    private constructor(
        public readonly id: string,
        public readonly walletId: string,
        public readonly transactionId: string,
        public readonly direction: LedgerDirection,
        public readonly money: Money,
        public readonly balanceBefore: Money,
        public readonly balanceAfter: Money,
        public readonly createdAt: Date,
    ) { }

    public static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
        if (props.money.isZero() || props.money.isNegative()) {
            throw new InconsistentLedgerEntryError(
                'Lançamentos no ledger devem possuir montante positivo maior que zero.',
            );
        }

        const expectedAfter =
            props.direction === LedgerDirection.Debit
                ? props.balanceBefore.subtract(props.money)
                : props.balanceBefore.add(props.money);

        if (!expectedAfter.equals(props.balanceAfter)) {
            throw new InconsistentLedgerEntryError(
                `Inconsistência contábil no Ledger: ${props.direction} de ${props.money.toString()} ` +
                `sobre o saldo anterior ${props.balanceBefore.toString()} não confere com o saldo posterior ${props.balanceAfter.toString()}.`,
            );
        }

        return new WalletLedgerEntry(
            props.id,
            props.walletId,
            props.transactionId,
            props.direction,
            props.money,
            props.balanceBefore,
            props.balanceAfter,
            new Date(),
        );
    }

    public static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
        return new WalletLedgerEntry(
            state.id,
            state.walletId,
            state.transactionId,
            state.direction,
            state.money,
            state.balanceBefore,
            state.balanceAfter,
            state.createdAt,
        );
    }

    public isBalanced(): boolean {
        const expected =
            this.direction === LedgerDirection.Debit
                ? this.balanceBefore.subtract(this.money)
                : this.balanceBefore.add(this.money);

        return expected.equals(this.balanceAfter);
    }
}