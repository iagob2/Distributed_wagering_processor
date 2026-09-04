import { LoggerService } from '@nestjs/common';

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
            correlationId: null,
            messageId: null,
            transactionId: null,
            walletId: null,
            providerId: null,
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
