// Alfabeto URL-safe sem caracteres ambíguos (exclui 0/O/o, 1/I/l) — per
// phase-03-videos/TD-06: IDs curtos e não-enumeráveis.
export const PUBLIC_ID_ALPHABET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz' as const;

export const PUBLIC_ID_LENGTH = 11 as const;

export const PUBLIC_ID_MAX_ATTEMPTS = 5 as const;
