import { IsInt, Min } from 'class-validator';

export class SignPartDto {
  @IsInt()
  @Min(1)
  partNumber: number;
}
