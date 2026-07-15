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

/** Keep Telegram readable — full title stays on dashboard via product record. */
function shortTitle(name: string, max = 72) {
  const t = String(name || 'Tracked item').trim().replace(/\s+/g, ' ')
  if (t.length <= max) return t
  return `${t.slice(0, max - 1).trim()}…`
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

function telegramShell(opts: {
  emoji: string
  headline: string
  name: string
  detailLines: string[]
  base: BaseFields
}) {
  const title = shortTitle(opts.name)
  const lines = [
    `${opts.emoji} <b>PriceWatch · ${escapeHtml(opts.headline)}</b>`,
    '',
    '<b>Product</b>',
    escapeHtml(title),
    '',
    ...opts.detailLines,
    '',
    `<b>Store</b> · ${escapeHtml(opts.base.storeName)}`,
  ]
  if (opts.base.pincode) {
    lines.push(`<b>Pincode</b> · <code>${escapeHtml(opts.base.pincode)}</code>`)
  }
  lines.push('')
  lines.push(`🔗 <a href="${escapeHtml(opts.base.url)}">Open product link</a>`)
  // Plain URL as backup (shows even if HTML link fails)
  lines.push(escapeHtml(opts.base.url))
  return lines.join('\n')
}

export function priceDropAlert(
  base: BaseFields & { oldPrice: number; newPrice: number },
): AlertCopy {
  const saved = Math.max(0, Math.round(base.oldPrice - base.newPrice))
  return {
    dashboard: `${formatInr(base.oldPrice)} → ${formatInr(base.newPrice)}${saved ? ` · saved ${formatInr(saved)}` : ''}`,
    telegram: telegramShell({
      emoji: '📉',
      headline: 'Price dropped',
      name: base.name,
      base,
      detailLines: [
        '<b>What changed</b>',
        `Price fell from <s>${formatInr(base.oldPrice)}</s> to <b>${formatInr(base.newPrice)}</b>`,
        saved ? `You save <b>${formatInr(saved)}</b>` : '',
      ].filter(Boolean),
    }),
  }
}

export function priceUpAlert(
  base: BaseFields & { oldPrice: number; newPrice: number },
): AlertCopy {
  return {
    dashboard: `${formatInr(base.oldPrice)} → ${formatInr(base.newPrice)}`,
    telegram: telegramShell({
      emoji: '📈',
      headline: 'Price went up',
      name: base.name,
      base,
      detailLines: [
        '<b>What changed</b>',
        `Price rose from ${formatInr(base.oldPrice)} to <b>${formatInr(base.newPrice)}</b>`,
      ],
    }),
  }
}

export function discountChangeAlert(
  base: BaseFields & { oldDiscount: number; newDiscount: number },
): AlertCopy {
  const direction =
    base.newDiscount > base.oldDiscount
      ? 'Discount increased'
      : base.newDiscount < base.oldDiscount
        ? 'Discount reduced'
        : 'Discount changed'
  const priceLine =
    base.price != null && base.price > 0 ? ` · ${formatInr(base.price)}` : ''
  return {
    dashboard: `${base.oldDiscount}% → ${base.newDiscount}%${priceLine}`,
    telegram: telegramShell({
      emoji: '🏷️',
      headline: direction,
      name: base.name,
      base,
      detailLines: [
        '<b>What changed</b>',
        `Discount was <b>${base.oldDiscount}% off</b>`,
        `Now it is <b>${base.newDiscount}% off</b>`,
        base.price != null && base.price > 0
          ? `Current price · <b>${formatInr(base.price)}</b>`
          : '',
      ].filter(Boolean),
    }),
  }
}

export function newOfferAlert(base: BaseFields & { offerText: string }): AlertCopy {
  const offer = base.offerText.trim()
  return {
    dashboard: offer.slice(0, 120) + (offer.length > 120 ? '…' : ''),
    telegram: telegramShell({
      emoji: '🎁',
      headline: 'New offer',
      name: base.name,
      base,
      detailLines: ['<b>Offer</b>', escapeHtml(offer)],
    }),
  }
}

export function pincodeAvailableAlert(base: BaseFields & { price: number }): AlertCopy {
  return {
    dashboard: `Available · Pin ${base.pincode} · ${formatInr(base.price)}`,
    telegram: telegramShell({
      emoji: '✅',
      headline: 'Now available',
      name: base.name,
      base,
      detailLines: [
        '<b>What changed</b>',
        `This product is deliverable again for pincode <code>${escapeHtml(base.pincode || '')}</code>`,
        `Price · <b>${formatInr(base.price)}</b>`,
      ],
    }),
  }
}
