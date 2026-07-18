import { prisma } from '../lib/prisma.js'

export async function logActivity(
  level: 'info' | 'warn' | 'error',
  source: string,
  message: string,
) {
  const line = `[${source}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  try {
    await prisma.activityLog.create({ data: { level, source, message } })
  } catch (err) {
    console.error('Failed to write activity log', err)
  }
}

function stripHtml(message: string) {
  return message
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>.*?<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function sendTelegram(message: string, opts?: { html?: boolean }) {
  const owner = await prisma.owner.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!owner?.telegramEnabled || !owner.telegramBotToken || !owner.telegramChatId) {
    return { sent: false, reason: 'telegram_not_configured' as const }
  }

  const useHtml = opts?.html === true
  const api = `https://api.telegram.org/bot${owner.telegramBotToken}/sendMessage`

  const send = async (text: string, html: boolean) =>
    fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: owner.telegramChatId,
        text,
        parse_mode: html ? 'HTML' : undefined,
        disable_web_page_preview: true,
      }),
    })

  let res = await send(message, useHtml)

  // If HTML rejected, retry as clear plain text (still keeps link lines)
  if (!res.ok && useHtml) {
    res = await send(stripHtml(message), false)
    if (res.ok) {
      await logActivity('info', 'telegram', 'Alert sent (plain fallback)')
      return { sent: true as const }
    }
  }

  if (!res.ok) {
    const body = await res.text()
    await logActivity('error', 'telegram', `Send failed: ${body.slice(0, 200)}`)
    return { sent: false, reason: 'telegram_api_error' as const }
  }

  await logActivity('info', 'telegram', 'Alert sent')
  return { sent: true as const }
}
