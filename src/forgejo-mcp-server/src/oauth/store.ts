import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface StoredGrant { accessToken: string; refreshToken: string; expiresAt: number; scope: string }
export interface StoredState { grants: Record<string, StoredGrant> }

/**
 * Forgejo grants, encrypted at rest with AES-256-GCM. The key never sits beside the file, and the file
 * is replaced atomically so a crash cannot leave a half-written grant that loses a rotated refresh token.
 */
export class EncryptedFileStore {
  readonly #path: string
  readonly #key: Buffer
  #writes: Promise<unknown> = Promise.resolve()

  constructor(path: string, key: Buffer) {
    if (key.length !== 32) throw new Error('The token encryption key must be 32 bytes')
    this.#path = path
    this.#key = key
  }

  async load(): Promise<StoredState> {
    let raw: string
    try { raw = await readFile(this.#path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { grants: {} }
      throw error
    }
    const { v, iv, tag, data } = JSON.parse(raw) as { v: number; iv: string; tag: string; data: string }
    if (v !== 1) throw new Error('Unsupported token store version')
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()])
    return JSON.parse(plain.toString('utf8')) as StoredState
  }

  save(state: StoredState): Promise<void> {
    const write = this.#writes.then(async () => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
      const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()])
      const body = JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
      await mkdir(dirname(this.#path), { recursive: true })
      const temporary = `${this.#path}.${process.pid}.tmp`
      await writeFile(temporary, body, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.#path)
    })
    this.#writes = write.catch(() => undefined)
    return write
  }
}
