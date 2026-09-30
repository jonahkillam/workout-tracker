// Vercel serverless function for Strava token handling; see server/strava.ts.
import { handleStrava } from '../../server/strava.js'

export function POST(request: Request): Promise<Response> {
  const action = new URL(request.url).pathname.split('/').pop() ?? ''
  return handleStrava(action, request, process.env)
}
