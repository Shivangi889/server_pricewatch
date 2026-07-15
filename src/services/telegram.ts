import { prisma } from '../lib/prisma.js'

export async function logActivity(
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
) {
  try {
    await prisma.activityLog.create({ data: { level, source, message } })
  } catch (err) {
    console.error('Failed to write activity log', err)
  }
}

export async function sendTelegram(message: string, opts?: { html?: boolean }) {
  const owner = await prisma.owner.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!owner?.telegramEnabled || !owner.telegramBotToken || !owner.telegramChatId) {
    return { sent: false, reason: 'telegram_not_configured' as const }
  }

  const useHtml = opts?.html !== false && /<[a-z][\s\S]*>/i.test(message)
  const url = `https://api.telegram.org/bot${owner.telegramBotToken}/sendMessage`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: owner.telegramChatId,
      text: message,
      parse_mode: useHtml ? 'HTML' : undefined,
      disable_web_page_preview: true,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    // Retry once as plain text if HTML parse failed
    if (useHtml) {
      const plain = message.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      const retry = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: owner.telegramChatId,
          text: plain,
          disable_web_page_preview: true,
        }),
      })
      if (retry.ok) {
        await logActivity('info', 'telegram', 'Alert sent (plain fallback)')
        return { sent: true as const }
      }
    }
    await logActivity('error', 'telegram', `Send failed: ${body.slice(0, 200)}`)
    return { sent: false, reason: 'telegram_api_error' as const }
  }

  await logActivity('info', 'telegram', 'Alert sent')
  return { sent: true as const }
}
