// Stand-in for CHI Authentication's signing side, for local wiring tests only.
// GET /jwks.json          public key set
// GET /sign?sub=ada[&aud=..][&iss=..][&exp=-60]   a fresh ES256 assertion
import http from 'node:http'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'

const ISS = process.env.ISS || 'https://sso.test/auth/'
const AUD = process.env.AUD || 'sso.test'
const PORT = Number(process.env.PORT || 8777)

const { publicKey, privateKey } = await generateKeyPair('ES256')
const jwk = { ...(await exportJWK(publicKey)), kid: 'stub', alg: 'ES256', use: 'sig' }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/jwks.json') {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ keys: [jwk] }))
  }
  if (url.pathname === '/sign') {
    const now = Math.floor(Date.now() / 1000)
    const exp = now + Number(url.searchParams.get('exp') ?? 120)
    const token = await new SignJWT({
      email: `${url.searchParams.get('sub')}@example.org`,
      given_name: 'Ada',
      family_name: 'Lovelace'
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'stub' })
      .setIssuer(url.searchParams.get('iss') ?? ISS)
      .setAudience(url.searchParams.get('aud') ?? AUD)
      .setSubject(url.searchParams.get('sub') ?? 'ada')
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(privateKey)
    return res.end(token)
  }
  res.statusCode = 404
  res.end()
}).listen(PORT, '0.0.0.0', () => console.log(`sso stub on :${PORT}`))
