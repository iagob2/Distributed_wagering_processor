import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

export interface RequestWithProvider extends Request {
    provider?: {
        id: string;
        name: string;
        allowedCurrencies: string[];
    };
}

@Injectable()
export class NoopAuthGuard implements CanActivate {
    public async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<RequestWithProvider>();

        // Pass-through stub com contexto de provedor validado (extensível via JWKS/OIDC)
        request.provider = {
            id: (request.headers['x-provider-id'] as string) || 'provider-mock-a',
            name: 'Simulated Provider',
            allowedCurrencies: ['BRL'],
        };

        return true;
    }
}