/** Shared alert copy for Telegram (HTML) and in-app dashboard. */

function formatInr(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(n)
}

function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type AlertCopy = {
  /** Short text stored in Notification.message (no raw URL dump) */
  dashboard: string
  /** Formatted HTML for Telegram sendMessage */
  telegram: string
}

type BaseFields = {
  name: string
  storeName: string
  url: string
  pincode?: string
  price?: number
}

function telegramFooter(base: BaseFields) {
  const lines = [
    '',
    `🏪 <b>${escapeHtml(base.storeName)}</b>`,
  ]
  if (base.pincode) lines.push(`📍 Pincode <code>${escapeHtml(base.pincode)}</code>`)
  lines.push(`🔗 <a href="${escapeHtml(base.url)}">Open product</a>`)
  return lines.join('\n')
}

export function priceDropAlert(
  base: BaseFields & { oldPrice: number; newPrice: number },
): AlertCopy {
  const saved = Math.max(0, Math.round(base.oldPrice - base.newPrice))
  return {
    dashboard: `${formatInr(base.oldPrice)} → ${formatInr(base.newPrice)}${saved ? ` · saved ${formatInr(saved)}` : ''}`,
    telegram: [
      '📉 <b>Price Drop</b>',
      escapeHtml(base.name),
      '',
      `<s>${formatInr(base.oldPrice)}</s> → <b>${formatInr(base.newPrice)}</b>`,
      saved ? `💸 Saved ${formatInr(saved)}` : null,
      telegramFooter(base),
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

export function priceUpAlert(
  base: BaseFields & { oldPrice: number; newPrice: number },
): AlertCopy {
  return {
    dashboard: `${formatInr(base.oldPrice)} → ${formatInr(base.newPrice)}`,
    telegram: [
      '📈 <b>Price Up</b>',
      escapeHtml(base.name),
      '',
      `${formatInr(base.oldPrice)} → <b>${formatInr(base.newPrice)}</b>`,
      telegramFooter(base),
    ].join('\n'),
  }
}

export function discountChangeAlert(
  base: BaseFields & { oldDiscount: number; newDiscount: number },
): AlertCopy {
  const priceLine =
    base.price != null && base.price > 0 ? ` · ${formatInr(base.price)}` : ''
  return {
    dashboard: `${base.oldDiscount}% → ${base.newDiscount}%${priceLine}`,
    telegram: [
      '🏷️ <b>Discount Change</b>',
      escapeHtml(base.name),
      '',
      `<b>${base.oldDiscount}%</b> → <b>${base.newDiscount}%</b>`,
      base.price != null && base.price > 0
        ? `💰 Price ${formatInr(base.price)}`
        : null,
      telegramFooter(base),
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

export function newOfferAlert(base: BaseFields & { offerText: string }): AlertCopy {
  const offer = base.offerText.trim()
  return {
    dashboard: offer.slice(0, 120) + (offer.length > 120 ? '…' : ''),
    telegram: [
      '🎁 <b>New Offer</b>',
      escapeHtml(base.name),
      '',
      escapeHtml(offer),
      telegramFooter(base),
    ].join('\n'),
  }
}

export function pincodeAvailableAlert(base: BaseFields & { price: number }): AlertCopy {
  return {
    dashboard: `Available · Pin ${base.pincode} · ${formatInr(base.price)}`,
    telegram: [
      '✅ <b>Now Available</b>',
      escapeHtml(base.name),
      '',
      `📍 Pincode <code>${escapeHtml(base.pincode || '')}</code>`,
      `💰 ${formatInr(base.price)}`,
      telegramFooter(base),
    ].join('\n'),
  }
}
