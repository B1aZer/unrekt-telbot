/**
 * Telegram MarkdownV2 escaping
 * Based on: https://core.telegram.org/bots/api#markdownv2-style
 */

const MARKDOWN_V2_ESCAPABLES: Record<string, string> = {
  '_': '\\_',
  '*': '\\*',
  '[': '\\[',
  ']': '\\]',
  '(': '\\(',
  ')': '\\)',
  '~': '\\~',
  '`': '\\`',
  '>': '\\>',
  '#': '\\#',
  '+': '\\+',
  '-': '\\-',
  '=': '\\=',
  '|': '\\|',
  '{': '\\{',
  '}': '\\}',
  '.': '\\.',
  '!': '\\!',
};

const ESCAPE_REGEX = /[_*[\]()~`>#+=\-|{}.!]/g;

/**
 * Escape text for Telegram MarkdownV2
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(ESCAPE_REGEX, (char) => MARKDOWN_V2_ESCAPABLES[char] || char);
}

/**
 * Escape text but preserve certain markdown formatting
 * Used when you want to keep some markdown like *bold* but escape other special chars
 */
export function escapeMarkdownV2Partial(text: string, preserve: string[] = []): string {
  const charsToEscape = Object.keys(MARKDOWN_V2_ESCAPABLES).filter(char => !preserve.includes(char));
  const regex = new RegExp(`[${charsToEscape.map(c => c === '\\' ? '\\\\' : c).join('')}]`, 'g');
  return text.replace(regex, (char) => MARKDOWN_V2_ESCAPABLES[char] || char);
}

