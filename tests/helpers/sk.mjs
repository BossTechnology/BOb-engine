// A security key emulated in software, for tests only.
//
// It makes what a FIDO authenticator makes: an sk-ecdsa-sha2-nistp256 or
// sk-ssh-ed25519 public key, and an SSH signature (sshsig, the format of
// `ssh-keygen -Y sign`) whose authenticator flags are whatever the test says:
// 0x01 user present (touched), 0x04 user verified (PIN or biometric); Henry's
// Secure Enclave key signs with 0x21 (UP and bit 5, no UV) and counter 1, its
// line is presence-only (docs/adr/0001). The
// signature is real: ssh-keygen -Y verify checks it like one from a key, flags
// included, since the authenticator signs them. What no software can show is
// that a person touched anything; that is what Henry's first signature
// measures.

import { generateKeyPairSync, sign, createHash } from 'node:crypto'

export const UP = 0x01
export const UV = 0x04

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b }
const str = (b) => { b = Buffer.isBuffer(b) ? b : Buffer.from(b); return Buffer.concat([u32(b.length), b]) }
const mpint = (b) => {
  let i = 0; while (i < b.length - 1 && b[i] === 0) i++
  b = b.subarray(i)
  return str(b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b)
}
const sha256 = (b) => createHash('sha256').update(b).digest()

// skKey('ecdsa' | 'ed25519', application) → { type, line, sign(message, namespace, flags, counter) }
// line: '<type> <base64>', as it goes in an allowed_signers file.
export function skKey(kind = 'ecdsa', application = 'ssh:') {
  const ecdsa = kind === 'ecdsa'
  const type = ecdsa ? 'sk-ecdsa-sha2-nistp256@openssh.com' : 'sk-ssh-ed25519@openssh.com'
  const { publicKey, privateKey } = ecdsa
    ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' })
  const point = ecdsa
    ? Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
    : Buffer.from(jwk.x, 'base64url')
  const pub = ecdsa
    ? Buffer.concat([str(type), str('nistp256'), str(point), str(application)])
    : Buffer.concat([str(type), str(point), str(application)])

  const signBlob = (message, namespace, flags, counter) => {
    // What sshsig signs: the preamble, the namespace, the hash of the message.
    const data = Buffer.concat([Buffer.from('SSHSIG'), str(namespace), str(''), str('sha512'),
      str(createHash('sha512').update(message).digest())])
    // What the authenticator signs: H(application) ‖ flags ‖ counter ‖ H(data).
    const signed = Buffer.concat([sha256(application), Buffer.from([flags]), u32(counter), sha256(data)])
    let inner
    if (ecdsa) {
      const rs = sign('sha256', signed, { key: privateKey, dsaEncoding: 'ieee-p1363' })
      inner = Buffer.concat([mpint(rs.subarray(0, 32)), mpint(rs.subarray(32))])
    } else {
      inner = sign(null, signed, privateKey)
    }
    return Buffer.concat([str(type), str(inner), Buffer.from([flags]), u32(counter)])
  }

  return {
    type,
    line: `${type} ${pub.toString('base64')}`,
    // An armored SSH signature, as `ssh-keygen -Y sign` writes it to <file>.sig.
    sign(message, namespace = 'bob-install-chain', flags = UP | UV, counter = 1, reserved = '') {
      const blob = Buffer.concat([Buffer.from('SSHSIG'), u32(1), str(pub), str(namespace), str(reserved), str('sha512'),
        str(signBlob(message, namespace, flags, counter))])
      const b64 = blob.toString('base64').match(/.{1,70}/g).join('\n')
      return `-----BEGIN SSH SIGNATURE-----\n${b64}\n-----END SSH SIGNATURE-----\n`
    },
  }
}
