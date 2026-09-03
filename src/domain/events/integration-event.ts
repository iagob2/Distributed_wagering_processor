import { LedgerDirection } from '../entities/wallet-ledger-entry.entity';
import { MoneyProps } from '../value-objects/money.vo';
import { Wallet } from '../entities/wallet.entity';
import { WalletLedgerEntry } from '../entities/wallet-ledger-entry.entity';

export interface EventContext {
    correlationId: string;
    causationId?: string;
}

export interface IntegrationEventProps<T> {
    eventId: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    data: T;
}

export abstract class IntegrationEvent<T> {
    abstract readonly eventType: string;
    abstract readonly version: number;

    public readonly eventId: string;
    public readonly aggregateId: string;
    public readonly correlationId: string;
    public readonly causationId?: string;
    public readonly occurredAt: Date;
    public readonly data: Readonly<T>;

    protected constructor(props: IntegrationEventProps<T>) {
        this.eventId = props.eventId;
        this.aggregateId = props.aggregateId;
        this.correlationId = props.correlationId;
        this.causationId = props.causationId;
        this.occurredAt = props.occurredAt;
        this.data = Object.freeze(props.data);
    }

    public toJSON(): {
        eventId: string;
        eventType: string;
        version: number;
        aggregateId: string;
        correlationId: string;
        causationId?: string;
        occurredAt: string;
        data: T;
    } {
        return {
            eventId: this.eventId,
            eventType: this.eventType,
            version: this.version,
            aggregateId: this.aggregateId,
            correlationId: this.correlationId,
            causationId: this.causationId,
            occurredAt: this.occurredAt.toISOString(),
            data: this.data,
        };
    }
}

export interface WalletBalanceChangedData {
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
    public readonly eventType = 'WalletBalanceChanged';
    public readonly version = 1;

    public static from(
        wallet: Wallet,
        entry: WalletLedgerEntry,
        ctx: EventContext,
    ): WalletBalanceChanged {
        return new WalletBalanceChanged({
            eventId: crypto.randomUUID(),
            aggregateId: wallet.id,
            correlationId: ctx.correlationId,
            causationId: ctx.causationId,
            occurredAt: new Date(),
            data: {
                walletId: wallet.id,
                transactionId: entry.transactionId,
                direction: entry.direction,
                money: entry.money.toJSON(),
                balanceBefore: entry.balanceBefore.toJSON(),
                balanceAfter: entry.balanceAfter.toJSON(),
                walletVersion: wallet.version,
            },
        });
    }
}