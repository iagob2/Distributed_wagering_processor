import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import jwt, { JwtHeader, SigningKeyCallback } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

@Injectable()
export class JwtAuthGuard implements CanActivate {
    private readonly client = jwksClient({
        jwksUri: process.env.IDP_JWKS_URI || 'http://localhost:8080/oauth/v2/keys',
        cache: true,
        rateLimit: true,
    });

    public async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<Request>();
        const authHeader = request.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new UnauthorizedException('Token de autenticação ausente ou mal formatado.');
        }

        const token = authHeader.split(' ')[1];

        try {
            const decodedToken = await this.verifyToken(token);
            (request as any).provider = decodedToken;
            return true;
        } catch {
            throw new UnauthorizedException('Token inválido ou expirado.');
        }
    }

    private verifyToken(token: string): Promise<jwt.JwtPayload> {
        const getKey = (header: JwtHeader, callback: SigningKeyCallback) => {
            this.client.getSigningKey(header.kid, (err, key) => {
                if (err || !key) {
                    return callback(err || new Error('Chave JWKS não encontrada'));
                }
                callback(null, key.getPublicKey());
            });
        };

        return new Promise((resolve, reject) => {
            jwt.verify(
                token,
                getKey,
                {
                    issuer: process.env.IDP_ISSUER || 'http://localhost:8080',
                    algorithms: ['RS256'],
                },
                (err, decoded) => {
                    if (err || !decoded) return reject(err);
                    resolve(decoded as jwt.JwtPayload);
                },
            );
        });
    }
}