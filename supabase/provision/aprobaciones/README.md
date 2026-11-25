# Approvals

One pair per approved change, written by `scripts/firmar-instalacion.sh` with
Henry's security key (O-3, P5 §6.2):

- `<digest>.aprobacion`: the signed text, `bob-install-chain 1`, then
  `base <digest>` and `nueva <digest>`;
- `<digest>.aprobacion.sig`: its `ssh-keygen -Y sign` signature, namespace
  `bob-install-chain`.

Nothing here counts toward the digest, so adding an approval does not change
what it approves. Old approvals stay as the record. A box replays nothing: it
accepts an approval only from the state it stands at.
