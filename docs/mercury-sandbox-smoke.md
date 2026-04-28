# Mercury sandbox smoke test

Smoke test reproducible para validar Mercury dentro del sandbox con `glm-5.1`, sin tocar la lógica del agente.

## Qué automatiza

- carga manualmente `sandbox/mercury-home/.env`
- exporta `MERCURY_HOME`
- fija el `cwd` al workspace del sandbox
- arranca Mercury en foreground con PTY usando `node dist/index.js start --foreground`
- selecciona `Ask Me` enviando `\r`
- manda `Di solo OK y nada más.`
- verifica que la respuesta útil del asistente sea únicamente `OK`
- guarda transcript raw y transcript limpio sin ANSI

## Requisitos

- `dist/index.js` debe existir en el repo (`npm run build` si hace falta)
- `python3` con `pexpect` disponible
- sandbox existente en:
  - `MERCURY_SANDBOX_HOME=/home/raul/dev/mercury-test/sandbox/mercury-home`
  - `MERCURY_SANDBOX_WORKSPACE=/home/raul/dev/mercury-test/sandbox/workspace`

## Uso

Desde el repo:

```bash
./scripts/run_mercury_sandbox_smoke.sh
```

Opcionalmente puedes sobreescribir rutas o prompt:

```bash
MERCURY_SANDBOX_HOME=/ruta/mercury-home \
MERCURY_SANDBOX_WORKSPACE=/ruta/workspace \
MERCURY_SMOKE_PROMPT='Di solo OK y nada más.' \
./scripts/run_mercury_sandbox_smoke.sh
```

## Salida

Los transcripts se guardan en `tmp/mercury-smoke/`:

- `*.log`: salida raw de terminal
- `*.clean.txt`: salida limpiada, sin secuencias ANSI

El script falla si:

- no encuentra `.env`
- no encuentra `dist/index.js`
- el arranque no muestra `glm-5.1`
- no logra pasar el menú de permisos
- la respuesta del asistente no es exactamente `OK`
