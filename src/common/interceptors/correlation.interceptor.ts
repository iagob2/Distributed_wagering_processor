import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import type { Request } from 'express';
import { requestContext } from '../logging/request-context';

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
    public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const request = context.switchToHttp().getRequest<Request & { provider?: { id?: string } }>();
        const header = request.headers['x-correlation-id'];
        const correlationId = typeof header === 'string' && header.trim() ? header.trim() : randomUUID();

        return new Observable((subscriber) => {
            requestContext.run(
                {
                    correlationId,
                    walletId: typeof request.body?.walletId === 'string' ? request.body.walletId : undefined,
                    playerId: typeof request.body?.playerId === 'string' ? request.body.playerId : undefined,
                    providerId: typeof request.body?.providerId === 'string' ? request.body.providerId : undefined,
                },
                () => next.handle().subscribe(subscriber),
            );
        });
    }
}
