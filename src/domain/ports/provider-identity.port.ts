export interface AuthenticatedProvider {
    id: string;
    name: string;
    allowedCurrencies: string[];
}

export interface ProviderIdentityPort {
    validateToken(token: string): Promise<AuthenticatedProvider>;
}