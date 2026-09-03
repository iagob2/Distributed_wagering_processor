import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
    const logger = new Logger('Bootstrap');
    const app = await NestFactory.create(AppModule);
    app.enableShutdownHooks();

    app.enableCors({
        origin: '*',
        methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    });

    app.useGlobalPipes(
        new ValidationPipe({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
        }),
    );

    const swaggerConfig = new DocumentBuilder()
        .setTitle('Distributed Wagering Processor')
        .setDescription('Painel interativo para testar carteiras, apostas e concorrência')
        .setVersion('1.0')
        .addBearerAuth(
            {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                name: 'JWT',
                description: 'Cole aqui o access_token gerado pelo Zitadel',
                in: 'header',
            },
            'bearer-token',
        )
        .addApiKey({ type: 'apiKey', name: 'Idempotency-Key', in: 'header' }, 'Idempotency-Key')
        .build();

    const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, swaggerDocument);

    const port = Number(process.env.PORT ?? 3000);
    await app.listen(port);

    logger.log(`🚀 Servidor HTTP iniciado em http://localhost:${port}`);
    logger.log(`📄 Interface Swagger disponível em http://localhost:${port}/docs`);
}

bootstrap();