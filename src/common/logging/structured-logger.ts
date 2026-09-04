import { LoggerService } from '@nestjs/common';
import { requestContext } from './request-context';

type LogLevel = 'log' | 'error' | 'warn' | 'debug' | 'verbose';

type LogContext = {
    correlationId: string | null;
    messageId: string | null;
    transactionId: string | null;
    walletId: string | null;
    providerId: string | null;
};

export class StructuredLogger implements LoggerService {
    public log(message: unknown, context?: string): void {
        this.write('log', message, context);
    }

    public error(message: unknown, trace?: string, context?: string): void {
        this.write('error', message, context, trace);
    }

    public warn(message: unknown, context?: string): void {
        this.write('warn', message, context);
    }

    public debug(message: unknown, context?: string): void {
        this.write('debug', message, context);
    }

    public verbose(message: unknown, context?: string): void {
        this.write('verbose', message, context);
    }

    private write(level: LogLevel, message: unknown, context?: string, trace?: string): void {
        const metadata: LogContext = {
            correlationId: requestContext.getStore()?.correlationId ?? null,
            messageId: requestContext.getStore()?.messageId ?? null,
            transactionId: requestContext.getStore()?.transactionId ?? null,
            walletId: requestContext.getStore()?.walletId ?? null,
            providerId: requestContext.getStore()?.providerId ?? null,
        };
        const output = {
            timestamp: new Date().toISOString(),
            level,
            context: context ?? 'Application',
            message: message instanceof Error ? message.message : String(message),
            ...metadata,
            ...(trace ? { trace } : {}),
        };
        process.stdout.write(`${JSON.stringify(output)}\n`);
    }
}
