import { CurrencyMismatchError, InsufficientFundsError } from '../errors/domain.error';
import { Money } from '../value-objects/money.vo';

export interface WalletState {
    id: string;
    playerId: string;
    currency: string;
    balance: Money;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface WalletMutationResult {
    balanceBefore: Money;
    balanceAfter: Money;
}

export class Wallet {
    private constructor(
        public readonly id: string,
        public readonly playerId: string,
        public readonly currency: string,
        private _balance: Money,
        private _version: number,
        public readonly createdAt: Date,
        private _updatedAt: Date,
    ) { }

    public static open(props: { id: string; playerId: string; initialBalance: Money }): Wallet {
        const now = new Date();
        return new Wallet(
            props.id,
            props.playerId,
            props.initialBalance.currency,
            props.initialBalance,
            1,
            now,
            now,
        );
    }

    public static rehydrate(state: WalletState): Wallet {
        return new Wallet(
            state.id,
            state.playerId,
            state.currency,
            state.balance,
            state.version,
            state.createdAt,
            state.updatedAt,
        );
    }

    public get balance(): Money {
        return this._balance;
    }

    public get version(): number {
        return this._version;
    }

    public get updatedAt(): Date {
        return this._updatedAt;
    }

    /**
     * Débito com invariante de não-negatividade no domínio.
     * Em concorrência, o caller DEVE ter adquirido SELECT ... FOR UPDATE na linha
     * da wallet antes de reidratar e chamar este método — sem isso, lost update.
     */
    public debit(amount: Money): WalletMutationResult {
        this.assertSameCurrency(amount);

        if (this._balance.isLessThan(amount)) {
            throw new InsufficientFundsError(this._balance.toString(), amount.toString());
        }

        const balanceBefore = this._balance;
        this._balance = this._balance.subtract(amount);
        this.incrementMutation();

        return { balanceBefore, balanceAfter: this._balance };
    }

    public credit(amount: Money): WalletMutationResult {
        this.assertSameCurrency(amount);

        const balanceBefore = this._balance;
        this._balance = this._balance.add(amount);
        this.incrementMutation();

        return { balanceBefore, balanceAfter: this._balance };
    }

    private incrementMutation(): void {
        this._version += 1;
        this._updatedAt = new Date();
    }

    private assertSameCurrency(money: Money): void {
        if (this.currency !== money.currency) {
            throw new CurrencyMismatchError(money.currency, this.currency);
        }
    }
}