/**
 * /start command - Show hot tokens
 */

import type { CommandContext } from 'grammy';
import { scanHotTokens } from '../utils/scanner';
import { formatHotTokens } from '../utils/formatter';
import { logger } from '../utils/logger';

export async function startCommand(ctx: CommandContext<any>) {
  // Send initial message
  await ctx.reply('🔍 Scanning BSC for hot tokens...\n\nThis may take 30-60 seconds...');
  
  try {
    // Run scanner
    const result = await scanHotTokens();
    
    // Format and send results
    const message = formatHotTokens(result);
    
    await ctx.reply(message, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    });
    
  } catch (error) {
    logger.error('Error scanning tokens:', error);
    await ctx.reply('❌ Error scanning tokens. Please try again later.');
  }
}

