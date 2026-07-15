import { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' })
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.flatten(),
    })
  }

  const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status: number }).status) : 500
  const message =
    err instanceof Error ? err.message : 'Internal server error'

  if (status >= 500) {
    console.error(err)
  }

  return res.status(status || 500).json({ error: message })
}
