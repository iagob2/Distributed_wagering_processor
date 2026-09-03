/**
 * Controla backoff e TTL de transações em PENDING_REFERENCE.
 * A unidade de verdade do estado continua sendo a linha em wager_transactions;
 * este tracker encapsula apenas a política de retentativas (domínio puro).
 */
export class PendingReferenceTracker {
    public static readonly MAX_ATTEMPTS = 5;
    private static readonly BASE_DELAY_MS = 2000;

    private constructor(
        public readonly transactionId: string,
        private _attempts: number,
        private _nextAttemptAt: Date,
    ) { }

    public static create(transactionId: string): PendingReferenceTracker {
        return new PendingReferenceTracker(transactionId, 0, new Date());
    }

    public static rehydrate(state: {
        transactionId: string;
        attempts: number;
        nextAttemptAt: Date;
    }): PendingReferenceTracker {
        return new PendingReferenceTracker(
            state.transactionId,
            state.attempts,
            state.nextAttemptAt,
        );
    }

    public get attempts(): number {
        return this._attempts;
    }

    public get nextAttemptAt(): Date {
        return this._nextAttemptAt;
    }

    public hasExceededLimit(): boolean {
        return this._attempts >= PendingReferenceTracker.MAX_ATTEMPTS;
    }

    /** Backoff exponencial: 2s, 4s, 8s, 16s, 32s (~62s de janela total). */
    public scheduleNextAttempt(now: Date = new Date()): void {
        this._attempts += 1;
        const delayMs = PendingReferenceTracker.BASE_DELAY_MS * Math.pow(2, this._attempts - 1);
        this._nextAttemptAt = new Date(now.getTime() + delayMs);
    }
}
