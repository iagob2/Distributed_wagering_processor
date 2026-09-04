import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestStore {
    correlationId: string;
    walletId?: string;
    playerId?: string;
    providerId?: string;
    transactionId?: string;
    messageId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestStore>();
