# Approvals

One pair per approved step, written by `scripts/firmar-instalacion.sh` with
Henry's security key (O-3, P5 §6.2), named by the pair it approves:

- `<base>-<nueva>.aprobacion`: the signed text, `bob-install-chain 1`, then
  `base <digest>` and `nueva <digest>`;
- `<base>-<nueva>.aprobacion.sig`: its `ssh-keygen -Y sign` signature,
  namespace `bob-install-chain`.

Nothing here counts toward the digest, so adding an approval does not change
what it approves, and several approvals can reach the same digest from
different bases. Old approvals stay as the record. A box replays nothing: it
accepts an approval only from the state it stands at.
