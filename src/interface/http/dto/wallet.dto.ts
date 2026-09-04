import { IsString, IsNotEmpty, ValidateNested, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class MoneyDto {
    @ApiProperty({
        description: 'Valor monetário como string decimal com até 2 casas.',
        example: '100.00',
        type: String,
    })
    @IsString()
    @Matches(/^\d+(\.\d{2})?$/, {
        message: 'amount deve ser string decimal com até 2 casas (ex: "100.00")',
    })
    amount!: string;

    @ApiProperty({
        description: 'Código da moeda no padrão ISO 4217.',
        example: 'BRL',
        type: String,
    })
    @IsString()
    @IsNotEmpty()
    currency!: string;
}

export class CreateWalletDto {
    @ApiProperty({
        description: 'Identificador do jogador (único por moeda).',
        example: 'player-smoke-001',
        type: String,
    })
    @IsString()
    @IsNotEmpty()
    playerId!: string;

    @ApiProperty({
        description: 'Saldo inicial creditado na abertura da carteira.',
        type: () => MoneyDto,
    })
    @ValidateNested()
    @Type(() => MoneyDto)
    initialBalance!: MoneyDto;
}