# Holdrim

Documentación que avisa cuando dejó de ser verdad.

[English](README.md) · [Português](README.pt-BR.md)

<!-- source: README.md up to the translated marker, sha256 1b21ecaa7b88375601ffcc7b771322f21b940ca72fba45f62f7a2688a1b69d40 -->

**Misión.** El documento aprobado es la fuente de verdad del sistema: quien conoce el negocio lo
escribe y lo aprueba, un agente de IA facilita la construcción, y el código queda a la vista de
quien quiera validarlo.

**Visión.** Que personas técnicas y no técnicas creen, mantengan y refactoricen sistemas complejos
empezando por las reglas de negocio. La documentación revisada y aprobada viene antes de cualquier
línea de código o pantalla, y por eso nadie rehace trabajo por falta de una regla — ni las personas,
ni un agente gastando tokens para adivinar.

## Cómo funciona

1. **Di lo que el producto tiene que hacer, con palabras simples.** Pide una página desde la home
   del proyecto, o un cambio en cualquier bloque de una; cuando se acepta el pedido, tu propio
   agente de IA lo escribe. Toda regla del producto vive en la documentación antes que en cualquier
   otro lugar.
2. **Apruébalo, bloque a bloque.** Una aprobación registra quién aprobó, cuándo y **qué texto
   exacto**. Cambia una letra y deja de valer, porque nadie aprobó el texto nuevo. Solo el ✓ del
   dueño se vuelve candado; un agente puede aplicar un cambio, y nunca aprobarlo.
3. **Construye a partir de lo aprobado.** Las páginas aprobadas — pantallas, modelo de datos, casos
   de uso, contratos — son lo que tu agente y tus ingenieros usan para construir, y el código queda
   en su repositorio para que cualquiera lo contraste con ellas.
4. **Sabe cuándo dejó de ser verdad.** Cuando una regla cambia, todo bloque que se apoyaba en ella
   se pone 🔴, en su propia página, sin que cambie una letra de él.

El agente es el que ya usas — Claude Code, Codex, Gemini — en tu máquina y con tu cuenta. El motor no
llama a ningún modelo ni guarda ninguna clave de API.

Holdrim es el motor, como Keycloak es el motor detrás de un inicio de sesión: una imagen Docker que
tu proyecto ejecuta y configura, mientras tu documentación sigue en su propio repositorio y se
monta en la imagen. Más de la visión, y lo que el agente hace y nunca hace, en
[`docs/VISION.md`](docs/VISION.md) (en inglés); lo que viene después, en [`ROADMAP.md`](ROADMAP.md).

## En dos minutos

```bash
git clone https://github.com/holdrim/holdrim-core
cd holdrim-core
export HOLDRIM_OWNER=you@example.org
docker compose run --rm --no-deps -u "$(id -u)" -v "$PWD:/out" holdrim /usr/local/bin/node engine/cli/holdrim.ts key new /out/holdrim-signing.key
HOLDRIM_SIGNING_KEY="$(cat holdrim-signing.key)" docker compose up
```

La cuarta línea se ejecuta una sola vez. Crea la clave con la que el servidor firma cada evento, en
`holdrim-signing.key`, que solo tú puedes leer: guárdala, y mantenla fuera del repositorio y fuera del
volumen de datos — quien tiene la clave puede firmar un bloqueo. Con Node en la máquina,
`node engine/cli/holdrim.ts key new holdrim-signing.key` hace lo mismo. Sin la clave el servicio se
niega a arrancar: un ✓ solo es bloqueo cuando este servidor lo firmó ([`SECURITY.md`](SECURITY.md),
en inglés).

Abre `http://localhost:8080`. La contraseña de primer acceso **nunca** va al log: está en un
archivo en el volumen de datos, que solo el usuario del propio servicio puede leer, y el log dice
dónde. Léela con `docker compose exec holdrim /bin/cat /data/first-access-password`. El primer
inicio de sesión obliga a cambiarla, y el archivo se borra cuando lo haces. No existe
`admin/admin`: una herramienta interna sigue en marcha durante años.

Llegas a la home del proyecto, `/engine/home`: cada página con su semáforo, y cada pedido que
alguien sigue esperando. Las páginas son las de `examples/hello-world` — dos, que explican en su
propio texto todo lo que una página necesita para funcionar aquí.

¿Sin Docker? `bash engine/run-local.sh` sirve las mismas dos páginas en `http://localhost:8095`,
como parte del propio proyecto de este repositorio (los archivos en `examples/hello-world/pages/`,
servidos en esa misma ruta), directo, sin inicio de sesión, y guarda los eventos en memoria —
detenerlo los borra, así que trabajar en el motor no toca las aprobaciones reales de nadie.

## El semáforo

Cada bloque tiene un estado, y el estado se calcula — nadie lo declara.

| | Estado | Significado | Qué hacer |
|---|---|---|---|
| ⚪ | sin validar | nadie lo ha mirado todavía | leer y aprobar, o pedir un cambio |
| 🟢 | validado | aprobado por el dueño, y nada cambió desde entonces | nada |
| 🟡 | desactualizado | el texto de **este** bloque cambió después del ✓ | volver a aprobar el texto nuevo |
| 🔴 | sospechoso | el texto es el mismo, pero algo de lo que **depende** cambió | comprobar si sigue valiendo |

El rojo es lo que separa esto de un control de versiones con una insignia. Atrapa el caso que nadie
nota al leer la página — porque **en la página, nada cambió**.

```
  "El plazo de respuesta es de 24 horas."    ← alguien edita esto…
  "Como el plazo es corto, la alerta
   salta el mismo día."                      ← …y esto se pone rojo, intacto
```

**El rojo es una pregunta, no un error.** El motor no sabe si el bloque quedó mal; sabe que quedó
sospechoso. Tratarlo como error haría que la gente apagara la comprobación con el primer falso
positivo, y entonces todo el candado pierde sentido.

## El resto, en inglés

Ver el rojo en el ejemplo de la caja registradora, usar Holdrim en tu propia documentación, lo que
una página necesita, dónde viven los datos, la configuración: todo está en el
[`README.md`](README.md#see-it-turn-red), a partir de "See it turn red".
