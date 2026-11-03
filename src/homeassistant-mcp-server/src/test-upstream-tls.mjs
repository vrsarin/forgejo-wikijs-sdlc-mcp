import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { connect } from 'node:tls'

const hostname = 'home-assistant-upstream-tls'
const root = readFileSync('/step-ca-root/root_ca.crt')

function handshake(ca) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: 443, servername: hostname, ca, rejectUnauthorized: true })
    socket.setTimeout(3000, () => socket.destroy(new Error('Home Assistant TLS handshake timed out')))
    socket.once('error', reject)
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate()
      socket.end()
      resolve(certificate)
    })
  })
}

const deadline = Date.now() + 120_000
let certificate
let lastError
while (Date.now() < deadline) {
  try {
    certificate = await handshake(root)
    break
  } catch (error) {
    lastError = error
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}
if (!certificate) throw new Error(`Home Assistant TLS did not become ready: ${lastError?.message}`)
assert(certificate.subjectaltname?.split(', ').includes(`DNS:${hostname}`), 'Home Assistant TLS certificate has the wrong identity')
assert(Date.parse(certificate.valid_to) > Date.now() + 60_000, 'Home Assistant TLS certificate expires too soon')
await assert.rejects(handshake([]), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }, 'An untrusted CA must be rejected')
console.log('PASS Home Assistant upstream TLS uses the project CA and rejects untrusted roots')
