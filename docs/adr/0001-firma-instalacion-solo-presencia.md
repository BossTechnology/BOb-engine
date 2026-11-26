# 0001 — La firma de instalación acepta una llave que solo da presencia

- **Fecha:** 2026-11-26
- **Estado:** aceptada

## Contexto
La aprobación de instalación de O-3 (P5 §6.2) es la firma de una persona: las
IAs proponen y las personas firman, así que ningún agente debe poder firmar
solo. `scripts/firma-instalacion.sh verificar` exigía que cada línea de
`supabase/provision/firmantes_instalacion` llevara `verify-required` y que la
firma trajera los dos bits del autenticador: presencia (UP, 0x01, la llave se
tocó) y verificación (UV, 0x04, PIN o biometría). Eso pide una llave FIDO2 con
PIN.

No habrá llave FIDO2 con PIN: Henry no la va a comprar y no hay otra máquina.
La llave que hay es la del Secure Enclave de su Mac, con Touch ID. Medido el
26 nov con `/usr/bin/ssh-keygen -Y sign -n bob-install-chain -w
/usr/lib/ssh-keychain.dylib`:

- La llave es `sk-ecdsa-sha2-nistp256@openssh.com` y residente. Al crearla con
  `-O verify-required`, el proveedor de Apple contesta «requested feature not
  supported».
- Dos firmas de prueba salieron con flags `0x21`: UP=1, UV=0 (el bit 5, 0x20,
  no lo lee nadie). macOS le pidió Touch ID a Henry en las dos.
- El contador vale 1 en las dos: el proveedor no lo incrementa.

Con la regla de antes, ninguna firma de Henry puede pasar `verificar`, y el
lunes 30 de noviembre se instala en Febor.

## Opciones consideradas
1. Comprar una llave FIDO2 con PIN y mantener `verify-required`. Descartada:
   no hay presupuesto.
2. Aflojar `verificar` para todos: no exigir UV nunca. Descartada: una línea
   con `verify-required` dejaría de significar lo que dice, sin que nadie lo
   vea en el archivo.
3. Una marca propia de BOb, `presence-only`, que una línea declara a la vista
   en lugar de `verify-required`. Solo esa línea queda sin UV; el resto de las
   reglas no cambia. Elegida.

## Decisión
Una línea de `firmantes_instalacion` lleva exactamente una de dos marcas:

- `verify-required`: la firma necesita UP y UV. Sin cambios.
- `presence-only`: la firma necesita UP; UV no se exige.

Una línea sin ninguna de las dos se rechaza, igual que antes. Las dos a la vez,
o una repetida, se rechazan. Con `presence-only` sigue todo lo demás: una llave
`sk-`, `namespaces="bob-install-chain"` en la línea y en la firma, y el rechazo
de `no-touch-required`, `cert-authority` y cualquier otra opción. La exigencia
de UV sigue a la línea de la llave que firmó, no al archivo entero: si la misma
llave aparece también en una línea `verify-required`, se exige UV.

El nombre `presence-only` usa los términos de FIDO: «user presence» frente a
«user verification». Dice lo que la llave sí da (presencia) y deja claro lo que
falta. OpenSSH no conoce esa opción, igual que no acepta `verify-required` en un
allowed_signers, así que `verificar` la lee y le pasa a ssh-keygen una copia sin
ninguna de las dos. Henry usa `henry namespaces="bob-install-chain",presence-only
sk-ecdsa-sha2-nistp256@openssh.com AAAA…`.

## Consecuencias
- **Qué se pierde.** La caja ya no puede comprobar que la firma de Henry pidió
  Touch ID: la firma lo dice con UV, y esta llave lo deja en 0. Lo único que la
  caja comprueba es que la llave privada del Secure Enclave firmó y que hubo
  presencia (UP). La garantía de que hubo Touch ID viene del Secure Enclave
  (la llave no sale de él, y macOS lo pidió en cada firma medida) y del registro
  de Henry de cada firma que hace, no de la firma misma. Un proceso con acceso a
  la sesión de Henry podría pedir una firma, pero no completarla sin que Henry
  dé el Touch ID que macOS le pide.
- **El contador.** El proveedor deja el contador en 1 siempre. `verificar` no lo
  lee y nunca lo leyó, así que no se pierde nada que BOb usara; pero una llave
  clonada no se puede detectar por el contador. La repetición de una firma vieja
  ya la cierra el par base → nueva del mensaje y la lista de revocadas, no el
  contador.
- **Por qué se acepta.** No hay presupuesto para una FIDO2 ni otra máquina, y la
  firma sigue siendo de una persona, en hardware, con presencia, dicho a la
  vista en el archivo que revisa CODEOWNERS.
- **Cómo se revierte.** Cuando haya una FIDO2 con PIN: crear la llave con
  `ssh-keygen -t ed25519-sk -O verify-required`, cambiar en
  `firmantes_instalacion` la línea de Henry por la nueva con `verify-required`,
  instalar esa copia en cada caja como root y quitar la línea `presence-only`.
  El código puede quedarse: sin ninguna línea `presence-only`, toda firma vuelve
  a necesitar UV. Una ADR nueva reemplaza a esta.
- **Qué vigilar.** Que ninguna otra línea use `presence-only` sin una ADR que lo
  diga, y que `firmar-instalacion.sh` firme con la llave del Secure Enclave
  (`FIRMA_LLAVE`), no con otra.
