import { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../lib/prisma.js'

export type AuthRequest = Request & {
  ownerId?: string
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const token = header.slice(7)
  try {
    const secret = process.env.JWT_SECRET
    if (!secret) throw new Error('JWT_SECRET missing')
    const payload = jwt.verify(token, secret) as { sub: string }
    req.ownerId = payload.sub
    return next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

/** Ensures an owner row exists (single-user app). */
export async function getOwner() {
  const owner = await prisma.owner.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!owner) {
    throw Object.assign(new Error('Owner not seeded. Run npm run db:seed'), { status: 500 })
  }
  return owner
}
