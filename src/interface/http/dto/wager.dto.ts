import { IsString, IsNotEmpty, IsEnum, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WagerTransactionKind } from '../../../domain/entities/wager-transaction.entity';
import { MoneyDto } from './wallet.dto';

export class SubmitWagerDto {
    @ApiProperty({
        description: 'Identificador do provedor externo de jogos.',
        example: 'provider-smoke',
        type: String,
    })
    @IsString()
    @IsNotEmpty()
    providerId!: string;

    @ApiProperty({
        description: 'Identificador único da transação externa gerado pelo provedor.',
        example: 'tx-001',
        type: String,
    })
    @IsString()
    @IsNotEmpty()
    externalTransactionId!: string;

    @ApiProperty({
        description: 'Identificador do jogador associado à aposta.',
        example: 'player-smoke-001',
        type: String,
    })
    @IsString()
    @IsNotEmpty()
    playerId!: string;

    @ApiProperty({
        description: 'UUID da carteira que receberá a mutação.',
        example: 'e9da796b-4bcb-4326-bc5d-8a4cb6601304',
        type: String,
    })
    @IsString()
    @IsNotEmpty()
    walletId!: string;

    @ApiProperty({
        description: 'Identificador da rodada de jogo.',
        example: 'round-smoke-001',
        type: String,
    })
    @IsString()
    @IsNotEmpty()
    roundId!: string;

    @ApiProperty({
        description: 'Identificador ou nome do jogo.',
        example: 'fortune-chimp',
        type: String,
    })
    @IsString()
    @IsNotEmpty()
    gameId!: string;

    @ApiProperty({
        description: 'Tipo da operação de aposta.',
        enum: ['BET', 'WIN', 'REFUND'], // ou enum: WagerTransactionKind,
        example: 'BET',
    })
    @IsEnum(WagerTransactionKind)
    kind!: WagerTransactionKind;

    @ApiProperty({
        description: 'Objeto de valor monetário e moeda da transação.',
        type: () => MoneyDto,
    })
    @ValidateNested()
    @Type(() => MoneyDto)
    money!: MoneyDto;

    @ApiPropertyOptional({
        description: 'ID da transação referenciada (obrigatório apenas para REFUND e ROLLBACK).',
        example: 'tx-001',
        type: String,
    })
    @IsString()
    @IsOptional()
    referenceExternalTransactionId?: string;
}