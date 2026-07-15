import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'

export const authRouter = Router()

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

authRouter.post('/login', async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body)
    const owner = await prisma.owner.findUnique({ where: { email: body.email } })
    if (!owner) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const ok = await bcrypt.compare(body.password, owner.passwordHash)
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const secret = process.env.JWT_SECRET
    if (!secret) throw Object.assign(new Error('JWT_SECRET missing'), { status: 500 })

    const token = jwt.sign(
      { sub: owner.id, email: owner.email },
      secret,
      { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') as jwt.SignOptions['expiresIn'] },
    )

    res.json({
      token,
      owner: {
        id: owner.id,
        name: owner.name,
        email: owner.email,
      },
    })
  } catch (err) {
    next(err)
  }
})

authRouter.get('/me', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const owner = await prisma.owner.findUnique({
      where: { id: req.ownerId },
      select: {
        id: true,
        name: true,
        email: true,
        telegramChatId: true,
        telegramEnabled: true,
        pauseTracking: true,
        checkIntervalMin: true,
        createdAt: true,
      },
    })
    if (!owner) return res.status(404).json({ error: 'Owner not found' })
    res.json({ owner })
  } catch (err) {
    next(err)
  }
})
