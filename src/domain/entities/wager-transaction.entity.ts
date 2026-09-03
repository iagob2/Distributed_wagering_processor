import { InvalidTransactionStateError } from '../errors/domain.error';
import { Money } from '../value-objects/money.vo';

export enum WagerTransactionKind {
    Opening = 'OPENING',
    Bet = 'BET',
    Win = 'WIN',
    Loss = 'LOSS',
    Refund = 'REFUND',
    Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
    Pending = 'PENDING',
    PendingReference = 'PENDING_REFERENCE',
    Processed = 'PROCESSED',
    Rejected = 'REJECTED',
    Failed = 'FAILED',
}

export type FailureCode =
    | 'INSUFFICIENT_FUNDS'
    | 'TRANSACTION_NOT_FOUND'
    | 'INVALID_ROUND_STATE'
    | 'CURRENCY_MISMATCH'
    | 'REFERENCE_ALREADY_REVERTED'
    | 'REFERENCE_MISMATCH'
    | 'SYSTEM_ERROR';

export interface CreateWagerTransactionProps {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    referenceExternalTransactionId?: string;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
    createdAt: Date;
    status: WagerTransactionStatus;
    referenceTransactionId?: string;
    failureCode?: FailureCode;
    processedAt?: Date;
}

export class WagerTransaction {
    private constructor(
        public readonly id: string,
        public readonly providerId: string,
        public readonly externalTransactionId: string,
        public readonly idempotencyKey: string,
        public readonly payloadHash: string,
        public readonly walletId: string,
        public readonly playerId: string,
        public readonly roundId: string,
        public readonly gameId: string,
        public readonly kind: WagerTransactionKind,
        public readonly money: Money,
        public readonly referenceExternalTransactionId: string | undefined,
        public readonly createdAt: Date,
        private _status: WagerTransactionStatus,
        private _referenceTransactionId?: string,
        private _failureCode?: FailureCode,
        private _processedAt?: Date,
    ) { }

    public static create(props: CreateWagerTransactionProps): WagerTransaction {
        if (props.kind === WagerTransactionKind.Opening) {
            throw new Error('Transações do tipo OPENING são exclusivamente internas.');
        }

        if (
            (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) &&
            !props.referenceExternalTransactionId
        ) {
            throw new Error(
                `Operações do tipo ${props.kind} exigem uma transação de referência (referenceExternalTransactionId).`,
            );
        }

        return new WagerTransaction(
            props.id,
            props.providerId,
            props.externalTransactionId,
            props.idempotencyKey,
            props.payloadHash,
            props.walletId,
            props.playerId,
            props.roundId,
            props.gameId,
            props.kind,
            props.money,
            props.referenceExternalTransactionId,
            new Date(),
            WagerTransactionStatus.Pending,
        );
    }

    public static rehydrate(state: WagerTransactionState): WagerTransaction {
        return new WagerTransaction(
            state.id,
            state.providerId,
            state.externalTransactionId,
            state.idempotencyKey,
            state.payloadHash,
            state.walletId,
            state.playerId,
            state.roundId,
            state.gameId,
            state.kind,
            state.money,
            state.referenceExternalTransactionId,
            state.createdAt,
            state.status,
            state.referenceTransactionId,
            state.failureCode,
            state.processedAt,
        );
    }

    public markProcessed(referenceTransactionId: string | undefined, at: Date = new Date()): void {
        this.assertNotTerminal();
        this._status = WagerTransactionStatus.Processed;
        this._referenceTransactionId = referenceTransactionId;
        this._processedAt = at;
    }

    public markPendingReference(): void {
        this.assertNotTerminal();
        this._status = WagerTransactionStatus.PendingReference;
    }

    public reject(code: FailureCode): void {
        this.assertNotTerminal();
        this._status = WagerTransactionStatus.Rejected;
        this._failureCode = code;
        this._processedAt = new Date();
    }

    public fail(code: FailureCode): void {
        this.assertNotTerminal();
        this._status = WagerTransactionStatus.Failed;
        this._failureCode = code;
        this._processedAt = new Date();
    }

    public isTerminal(): boolean {
        return (
            this._status === WagerTransactionStatus.Processed ||
            this._status === WagerTransactionStatus.Rejected ||
            this._status === WagerTransactionStatus.Failed
        );
    }

    public affectsBalance(): boolean {
        return this.kind !== WagerTransactionKind.Loss;
    }

    public requiresReference(): boolean {
        return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
    }

    public matchesPayload(incomingPayloadHash: string): boolean {
        return this.payloadHash === incomingPayloadHash;
    }

    private assertNotTerminal(): void {
        if (this.isTerminal()) {
            throw new InvalidTransactionStateError(
                `Transição ilegal: transação ${this.id} já se encontra no estado terminal ${this._status}.`,
            );
        }
    }

    public get status(): WagerTransactionStatus {
        return this._status;
    }
    public get referenceTransactionId(): string | undefined {
        return this._referenceTransactionId;
    }
    public get failureCode(): FailureCode | undefined {
        return this._failureCode;
    }
    public get processedAt(): Date | undefined {
        return this._processedAt;
    }
}
