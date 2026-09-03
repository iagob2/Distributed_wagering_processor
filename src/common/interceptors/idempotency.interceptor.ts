import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
    BadRequestException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';

@Injectable()
export class IdempotencyValidationInterceptor implements NestInterceptor {
    public intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const request = context.switchToHttp().getRequest<Request>();

        // Valida apenas requisições mutantes (POST, PUT, PATCH)
        if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
            const idempotencyKey = request.headers['idempotency-key'];

            if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
                throw new BadRequestException('O header "Idempotency-Key" é obrigatório para operações financeiras.');
            }

            // Sanitiza o header para consumo nos controllers e services
            request.headers['idempotency-key'] = idempotencyKey.trim();
        }

        return next.handle();
    }
}