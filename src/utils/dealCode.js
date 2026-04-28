import { customAlphabet } from 'nanoid';

// Readable alphabet — no 0/O, I/1 confusion
const alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const generate = customAlphabet(alphabet, 6);

export const generateDealCode = () => `TP-${generate()}`;

export const isDealCode = (str) => /^TP-[A-Z0-9]{6}$/.test(str?.toUpperCase());
