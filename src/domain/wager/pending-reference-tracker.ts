export class PendingReferenceTracker {
    public static readonly MAX_ATTEMPTS = 5;
    private static readonly BASE_DELAY_MS = 2000; // 2 segundos iniciais

    constructor(
        public readonly transactionId: string,
        private _attempts: number = 0,
        private _nextAttemptAt: Date = new Date(),
    ) { }

    public get attempts(): number {
        return this._attempts;
    }

    public get nextAttemptAt(): Date {
        return this._nextAttemptAt;
    }

    public hasExceededLimit(): boolean {
        return this._attempts >= PendingReferenceTracker.MAX_ATTEMPTS;
    }

    public scheduleNextAttempt(now: Date = new Date()): void {
        this._attempts += 1;
        // Exponential Backoff: 2s, 4s, 8s, 16s, 32s (Janela de ~62 segundos)
        const delayMs = PendingReferenceTracker.BASE_DELAY_MS * Math.pow(2, this._attempts - 1);
        this._nextAttemptAt = new Date(now.getTime() + delayMs);
    }
}