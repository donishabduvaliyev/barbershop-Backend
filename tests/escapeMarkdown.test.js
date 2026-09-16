// Locks down the fix for the "a shop/customer name with an underscore
// silently breaks every Telegram notification" bug — legacy Telegram
// Markdown only treats these four characters as special.
import { describe, it, expect } from 'vitest';
import { escapeMarkdown } from '../utils/escapeMarkdown.js';

describe('escapeMarkdown', () => {
  it('escapes underscores', () => {
    expect(escapeMarkdown('Cut_n_Style')).toBe('Cut\\_n\\_Style');
  });

  it('escapes asterisks', () => {
    expect(escapeMarkdown('5*Star Salon')).toBe('5\\*Star Salon');
  });

  it('escapes backticks', () => {
    expect(escapeMarkdown('code`span')).toBe('code\\`span');
  });

  it('escapes square brackets', () => {
    expect(escapeMarkdown('[VIP] Client')).toBe('\\[VIP] Client');
  });

  it('escapes multiple special characters in one string', () => {
    expect(escapeMarkdown("O'Neil_s *Best* Cuts")).toBe("O'Neil\\_s \\*Best\\* Cuts");
  });

  it('leaves plain text untouched', () => {
    expect(escapeMarkdown('Gentleman\'s Cut 3')).toBe('Gentleman\'s Cut 3');
  });

  it('returns an empty string for null or undefined', () => {
    expect(escapeMarkdown(null)).toBe('');
    expect(escapeMarkdown(undefined)).toBe('');
  });

  it('coerces non-string values (e.g. a phone number) to a string', () => {
    expect(escapeMarkdown(998901234567)).toBe('998901234567');
  });
});
