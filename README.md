# TyO Assist — Puente de IA v29 (gratis con Cloudflare Workers AI)

Este puente conecta la app con IA **gratuita** de Cloudflare. No necesitas clave de OpenAI ni de Google, y **la app no cambia**: solo le pones la URL del puente y tu token en ⚙️ Ajustes.

- **Gratis cada día:** 10,000 «neuronas» diarias en el plan gratuito, sin tarjeta. Si se acaban, la IA se pausa hasta las 18:00 (hora del centro de México). En el plan gratuito no hay cobros.
- **Sin clave que se pueda filtrar:** el Worker usa la IA de Cloudflare directamente con un enlace llamado `AI`.
- **Privacidad:** Cloudflare declara que no entrena modelos con lo que envías y que no lo conserva después de procesarlo ([política de datos de Workers AI](https://developers.cloudflare.com/workers-ai/platform/data-usage/)). Este puente tampoco registra el contenido. Aun así, la regla sigue: nada que identifique al paciente.
- **Para que no falle:** si el modelo principal está saturado o responde mal, el puente prueba uno de respaldo. Nunca entrega una nota cortada como si estuviera completa.

| Uso | Modelo principal | Respaldo |
|---|---|---|
| Notas y texto | Gemma 4 26B (`@cf/google/gemma-4-26b-a4b-it`) | Llama 4 Scout (`@cf/meta/llama-4-scout-17b-16e-instruct`) |
| Fotos (laboratorio, Rx) | Gemma 4 26B | Llama 4 Scout |
| Audio (dictado) | Whisper large v3 turbo, en español | Whisper |

---

## Paso 1. Crea tu token

El token es una contraseña entre la app y el puente. Debe tener **al menos 16 caracteres**. En el iPhone puedes generar una contraseña fuerte con la app Contraseñas. Guárdalo: lo pondrás en Cloudflare y en la app. **No lo compartas por chat.**

## Paso 2A. Instalar desde el navegador (sin computadora)

1. Entra a [dash.cloudflare.com](https://dash.cloudflare.com) con la misma cuenta donde publicas la app.
2. Ve a **Workers & Pages → Create → Create Worker**. Ponle de nombre `tyo-assist-puente` y toca **Deploy**.
3. Toca **Edit code**, borra todo el código de ejemplo y pega el contenido completo de `index.js`. Toca **Deploy**.
4. En el Worker, ve a **Settings → Bindings → Add → Workers AI**. Nombre de la variable: `AI` (en mayúsculas). Guarda.
5. En **Settings → Variables and Secrets**, agrega:
   - `APP_ACCESS_TOKEN`, tipo **Secret**, con tu token del paso 1.
   - `ALLOWED_ORIGINS`, tipo **Text**, con la dirección de tu app sin «/» final. Ejemplo: `https://tyoassistx.edgargm331.workers.dev`. Si publicas en varios sitios, sepáralos con coma.
6. Guarda y vuelve a desplegar si te lo pide. Copia la URL del Worker (termina en `.workers.dev`).

## Paso 2B. Instalar con computadora (opcional)

```bash
npm install
npx wrangler login
npx wrangler secret put APP_ACCESS_TOKEN   # pega tu token cuando lo pida
npx wrangler deploy
npm test                                    # 27 pruebas automáticas
```

`wrangler.toml` ya trae el enlace `AI`, los modelos y `ALLOWED_ORIGINS`. Cambia `ALLOWED_ORIGINS` si tu app vive en otra dirección.

## Paso 2C. Con GitHub y despliegue automático de Cloudflare

Esta versión no usa carpetas: todos los archivos van en la raíz del repositorio, porque GitHub en el iPhone no sube carpetas.

1. En el iPhone abre el zip en la app Archivos (se descomprime solo).
2. En tu repositorio de GitHub toca **Add file → Upload files** y elige los 5 archivos: `index.js`, `wrangler.toml`, `package.json`, `puente.test.js` y `README.md`. Los que ya existan con el mismo nombre se reemplazan.
3. Toca **Commit changes**. Cloudflare vuelve a desplegar solo; en el registro de compilación debe aparecer «Success» al final.
4. El enlace `AI` se crea solo desde `wrangler.toml`. El token **no**: agrégalo una vez en el panel de Cloudflare, en el Worker → **Settings → Variables and Secrets**, como `APP_ACCESS_TOKEN` de tipo **Secret**. Se conserva entre despliegues.
5. Si tu app no está en `https://tyoassistx.edgargm331.workers.dev`, edita esa línea de `wrangler.toml` en GitHub con la dirección correcta, o déjala vacía (`ALLOWED_ORIGINS = ""`).

## Paso 3. Conecta la app

1. En la app abre **⚙️ Ajustes → Conexión de IA**.
2. Modo: **Puente Backend seguro**.
3. URL del Puente: la URL de tu Worker, por ejemplo `https://tyo-assist-puente.TU-SUBDOMINIO.workers.dev`.
4. Token de acceso personal: tu token.
5. **Guardar** y luego **🔌 Probar conexión**. Debe decir: «✅ Puente Backend listo… con token activo».

El selector «Modelo Gemini» ya no hace nada: el modelo lo decide el puente. Se quitará en la v30.

## Paso 4. Prueba de 5 minutos con un paciente ficticio

- [ ] **Nota con IA:** escribe un caso ficticio y toca el botón de formato con IA. Las secciones sin datos deben salir como [NO REFERIDO], sin datos inventados.
- [ ] **Audio IA:** graba 10–20 segundos de un dictado ficticio. El texto debe aparecer en el dictado.
- [ ] **Foto de laboratorio:** usa una foto recortada, sin datos personales. Revisa que los valores coincidan con la foto.
- [ ] **Token equivocado:** cambia una letra del token y toca «Probar conexión». Debe decir «Token incorrecto o faltante». Después regresa el token correcto.

Si algo falla, anota el mensaje exacto: todos los errores del puente están en español y dicen qué hacer.

---

## ¿Cuánto alcanza el plan gratuito?

Cálculo aproximado con los precios publicados ([precios de Workers AI](https://developers.cloudflare.com/workers-ai/platform/pricing/)): una nota consume entre 50 y 100 neuronas con Gemma 4, según lo largo del dictado, y un minuto de audio unas 47. Con 10,000 diarias alcanza para unas 100 notas al día, o una mezcla de notas, audios y fotos. Las fotos gastan más que el texto y varían según la imagen. Puedes ver tu consumo en el panel de Cloudflare: **AI → Workers AI**.

## Cambiar de modelo

Edita las variables `MODEL_TEXT`, `MODEL_TEXT_BACKUP`, `MODEL_AUDIO` o `MODEL_AUDIO_BACKUP` (en el panel: Settings → Variables; con computadora: `wrangler.toml`). No hace falta tocar el código ni la app. Alternativas gratuitas para texto: `@cf/openai/gpt-oss-120b` y `@cf/mistralai/mistral-small-3.1-24b-instruct`. Evita los modelos que Cloudflare marca como de pago (por ejemplo DeepSeek V4, GLM 5.x y Kimi K2.6).

## Problemas frecuentes

| Mensaje | Qué hacer |
|---|---|
| «Token incorrecto o faltante» | El token de la app y el de Cloudflare deben ser idénticos. |
| «Falta configurar el secreto APP_ACCESS_TOKEN» | Agrégalo como Secret en el Worker (mínimo 16 caracteres). |
| La app dice que falta `GEMINI_API_KEY` | Es un texto viejo de la app: en realidad falta el enlace `AI` (paso 2A.4). Se corrige en la v30. |
| «Falta el enlace de Workers AI llamado AI» | Agrega el enlace Workers AI con el nombre `AI`. |
| «Origen no autorizado» | Agrega la dirección exacta de tu app en `ALLOWED_ORIGINS`, sin «/» final. |
| «Se agotó la cuota gratuita de IA de hoy» | Espera a las 18:00 (hora del centro de México). Lo que funciona sin internet sigue igual. |
| «La IA gratuita no pudo completar la solicitud» | Intenta de nuevo. Si se repite, cambia `MODEL_TEXT` por otra alternativa gratuita. |
| «No se pudo transcribir el audio» | Intenta de nuevo o usa el dictado del teléfono. |
| «El archivo es demasiado grande» o error 1102 con fotos | Recorta la foto o haz una captura de pantalla más pequeña. La v30 comprimirá las fotos en la app. |
| «Formato de imagen no compatible» | Usa JPG, PNG o WebP. |

Para ver errores en vivo con computadora: `npx wrangler tail`. Solo verás qué modelo falló y por qué, nunca el contenido clínico.

## Qué cambió respecto al puente anterior (starter)

- Usa Workers AI gratis en lugar de OpenAI de pago.
- Habla el formato que ya usa la app: «Probar conexión», notas, fotos y audio funcionan sin modificar la app.
- Token obligatorio. Sin token configurado, el puente se niega a responder.
- Modelos de respaldo, detección de respuestas cortadas y aviso claro cuando se acaba la cuota.
- Respeta el esquema NOM-004 que manda la app y completa claves faltantes con valores vacíos, nunca con datos inventados.
- Un solo archivo sin dependencias, listo para pegar en el panel de Cloudflare.

La salida de IA es un borrador: siempre la revisa el médico antes de usarla.
