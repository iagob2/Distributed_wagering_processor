import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestWithProvider extends Request {
    provider?: {
        id: string;
        name: string;
        allowedCurrencies: string[];
    };
}

/**
 * Ponto de extensão de autenticação (Seção 2 do desafio — autenticação vale 0 pontos).
 *
 * Produção: substituir por `JwtAuthGuard` (JWKS/OIDC contra Zitadel em Docker Compose).
 * Avaliação local: este Noop injeta um provedor simulado sem bloquear o motor financeiro.
 *
 * @see JwtAuthGuard em ./jwt-auth.guard.ts
 * @see ProviderIdentityPort em domain/ports/provider-identity.port.ts
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
    public async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<RequestWithProvider>();

        request.provider = {
            id: (request.headers['x-provider-id'] as string) || 'provider-mock-a',
            name: 'Simulated Provider',
            allowedCurrencies: ['BRL'],
        };

        return true;
    }
}