import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { StructuredLogger } from './common/logging/structured-logger';
import { CorrelationInterceptor } from './common/interceptors/correlation.interceptor';

async function bootstrap() {
    const logger = new StructuredLogger();
    const app = await NestFactory.create(AppModule);

    // Logging & Observabilidade
    app.useLogger(logger);
    app.useGlobalInterceptors(new CorrelationInterceptor());
    app.enableShutdownHooks();

    // CORS
    app.enableCors({
        origin: '*',
        methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    });

    // Validação Global de Payloads DTO
    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
        }),
    );

    // Configuração Central do Swagger (Tags, Descrições e Autenticações)
    const swaggerConfig = new DocumentBuilder()
        .setTitle('Distributed Wagering Processor')
        .setDescription('Painel interativo para testar carteiras, apostas, concorrência e reconciliação financeira')
        .setVersion('1.0')
        .addTag('Wallets', 'Operações de saldo, extrato e reconciliação da carteira do jogador')
        .addTag('Wagering', 'Processamento de transações financeiras e apostas (BET, WIN, REFUND)')
        .addTag('Health & Ops', 'Monitoramento operacional, métricas Prometheus e health checks')
        .addBearerAuth(
            {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                name: 'JWT',
                in: 'header',
                description: 'Cole aqui o access_token gerado pelo Zitadel via OAuth2 Client Credentials',
            },
            'bearer-token',
        )
        .addApiKey(
            {
                type: 'apiKey',
                name: 'Idempotency-Key',
                in: 'header',
                description: 'Chave exclusiva para garantir idempotência contra requisições duplicadas',
            },
            'Idempotency-Key',
        )
        .build();

    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, swaggerDocument);

    const port = Number(process.env.PORT ?? 3000);
    await app.listen(port);

    logger.log(`🚀 Servidor HTTP iniciado em http://localhost:${port}`);
    logger.log(`📄 Interface Swagger disponível em http://localhost:${port}/docs`);
}

bootstrap();