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
- **Qué se pierde.** La caja ya no puede comprobar que hubo una persona. Lo
  que comprueba es que firmó la llave privada de la línea de Henry, en la
  namespace correcta, sobre el par base → nueva, y que el byte de flags trae
  UP. Con esta llave, ese UP casi no dice nada:
  - *Inferencia, no medida.* Con `/usr/lib/ssh-keychain.dylib`, el byte de
    flags y el contador muy probablemente los arma esa librería, que es
    software de macOS; el Secure Enclave solo firma un resumen P-256. Los
    indicios: el contador fijo en 1 y los flags siempre en 0x21. Si es así, el
    UP que comprueba la caja es casi una constante del proveedor, no la prueba
    de que alguien tocó algo.
  - *La medición que lo confirmaría*, para Henry (crear llaves es cosa suya):
    crear con este proveedor una llave de prueba con `-O no-touch-required`,
    firmar con ella y ver si la firma también sale con 0x21. Si sale igual, el
    UP lo pone la librería.
  - Lo que garantiza que hubo una persona es la política de acceso de la llave
    en el Secure Enclave y el aviso de macOS: Touch ID, o la contraseña de la
    Mac si la política lo admite. La caja no lo ve, y no hay atestación que lo
    pruebe. Descansa en esa política y en el registro de Henry de cada firma
    que hace, no en la firma misma.
  - El aviso de Touch ID no muestra qué se firma. Quien controle la sesión de
    Henry o su `PATH` podría hacerle firmar otra cosa con el mismo toque.
    Mitigación, parcial: `firmar-instalacion.sh` muestra el diff, los dos
    digests del par y la orden de `ssh-keygen` (el programa, `-w` y `-f`)
    antes de pedir `firmo`, y Henry corre `/usr/bin/ssh-keygen` por ruta
    absoluta. Una sesión comprometida también puede falsear lo que se muestra
    en la terminal.
- **El contador.** El proveedor deja el contador en 1 siempre. `verificar` no lo
  lee y nunca lo leyó, así que no se pierde nada que BOb usara; pero una llave
  clonada no se puede detectar por el contador. La repetición de una firma vieja
  ya la cierra el par base → nueva del mensaje y la lista de revocadas, no el
  contador.
- **Por qué se acepta.** No hay presupuesto para una FIDO2 ni otra máquina, y la
  firma sigue siendo con una llave que no sale del Secure Enclave y que macOS
  solo usa tras el aviso de su política. Que eso basta lo dice esta ADR, a la
  vista en el archivo que revisa CODEOWNERS, no la caja.
- **Cómo se revierte.** Cuando haya una FIDO2 con PIN: crear la llave con
  `ssh-keygen -t ed25519-sk -O verify-required`, cambiar en
  `firmantes_instalacion` la línea de Henry por la nueva con `verify-required`,
  instalar esa copia en cada caja como root y quitar la línea `presence-only`.
  El código puede quedarse: sin ninguna línea `presence-only`, toda firma vuelve
  a necesitar UV. Una ADR nueva reemplaza a esta.
- **Qué vigilar.** Que ninguna otra línea use `presence-only` sin una ADR que lo
  diga, y que `firmar-instalacion.sh` firme con la llave del Secure Enclave
  (`--llave`, con `--proveedor /usr/lib/ssh-keychain.dylib` y
  `--ssh-keygen /usr/bin/ssh-keygen`), no con otra.
