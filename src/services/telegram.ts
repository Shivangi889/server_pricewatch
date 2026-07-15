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

export async function sendTelegram(message: string) {
  const owner = await prisma.owner.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!owner?.telegramEnabled || !owner.telegramBotToken || !owner.telegramChatId) {
    return { sent: false, reason: 'telegram_not_configured' as const }
  }

  const url = `https://api.telegram.org/bot${owner.telegramBotToken}/sendMessage`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: owner.telegramChatId,
      text: message,
      disable_web_page_preview: false,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    await logActivity('error', 'telegram', `Send failed: ${body.slice(0, 200)}`)
    return { sent: false, reason: 'telegram_api_error' as const }
  }

  await logActivity('info', 'telegram', 'Alert sent')
  return { sent: true as const }
}
