/**
 * Telegram MarkdownV2 Escaping Utility
 * 
 * Properly escapes all special characters for Telegram's MarkdownV2 format
 * See: https://core.telegram.org/bots/api#markdownv2-style
 */

/**
 * Escape special characters for MarkdownV2
 * 
 * Special characters that need escaping:
 * _ * [ ] ( ) ~ ` > # + - = | { } . !
 */
export function escapeMarkdownV2(text: string | number): string {
  // Convert to string if number
  const str = String(text);
  
  // Escape all special MarkdownV2 characters
  return str.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Format a number with escaping (e.g., for prices, market cap)
 */
export function formatNumber(num: number, decimals: number = 2): string {
  return escapeMarkdownV2(num.toFixed(decimals));
}

/**
 * Format large numbers with K/M/B suffix and escaping
 */
export function formatLargeNumber(num: number): string {
  if (num >= 1_000_000_000) {
    return escapeMarkdownV2(`$${(num / 1_000_000_000).toFixed(2)}B`);
  } else if (num >= 1_000_000) {
    return escapeMarkdownV2(`$${(num / 1_000_000).toFixed(2)}M`);
  } else if (num >= 1_000) {
    return escapeMarkdownV2(`$${(num / 1_000).toFixed(1)}K`);
  } else {
    return escapeMarkdownV2(`$${num.toFixed(2)}`);
  }
}

/**
 * Escape text but preserve already-escaped markdown formatting
 * Use this for pre-formatted text with intentional markdown
 */
export function escapePreserveMarkdown(text: string): string {
  // This escapes everything except already escaped characters
  return text.replace(/(?<!\\)([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

