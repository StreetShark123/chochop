# chochop ✂

Trocea cualquier audio en samples listos para el **Bastl Kastle 2 Wave Bard**.

Es una página web estática: se abre en el navegador y todo el audio se procesa en local, sin subir nada a ningún sitio.

## Qué hace

**Dig & chop**: cargas un audio, sacas trozos y los afinas.

- **Carga** WAV, MP3, AIFF, OGG, FLAC o M4A, o **graba** una pestaña del navegador o el micro (Chrome/Edge de escritorio).
- **Dig**: «saca 8 trozos de 2 s» al azar (empezando en golpes), repartidos por todo el audio o seguidos desde el cursor. Marca con ★ los que te gusten y vuelve a cavar: solo cambian los demás.
- **Chop**: arrastra el centro de un trozo para moverlo y sus bordes para ajustarlo. Doble clic añade uno; arrastrar en vacío crea uno a mano.
- Ajustes por trozo: nombre de 8 caracteres, mono/estéreo, velocidad (×1, ×0,75, ×0,5, ×0,25, estilo cinta), fades, normalizar y al revés.
- **Escucha** cada trozo, o todos seguidos o en orden aleatorio y en bucle, como los tocaría el Bard.
- Un medidor indica cuánta memoria del Wave Bard ocupas (≈ 89 s en mono / 44 s en estéreo a 44,1 kHz).
- **Descarga** un ZIP con el nombre del pack que elijas: WAV de 16 bits a 44,1 kHz, en carpetas de 8 (`banco1`, `banco2`…) con nombres válidos de 8 caracteres. El nombre del pack también da nombre a los sonidos, salvo los que renombres a mano.
- En castellano, galego e English.

## Atajos

| Tecla | Acción |
| --- | --- |
| D | Dig |
| K | ★ al trozo seleccionado |
| Doble clic | Añadir un trozo del largo elegido |
| Arrastrar | Crear trozo (Alt: encima de otro) |
| Espacio | Escuchar / parar |
| Supr / Retroceso | Quitar el trozo seleccionado |
| ← → | Trozo anterior / siguiente |
| Esc | Deseleccionar |
| Rueda | Zoom · Mayús + rueda: desplazar |

## Cargar en el Wave Bard

1. Exporta el ZIP y descomprímelo.
2. Abre la [web app de Bastl](https://apps.bastl-instruments.com/wave-bard-sample-loader/) y arrastra los WAV de cada carpeta a un banco.
3. Pulsa «Generate firmware file» y copia el `.uf2` al Wave Bard en modo boot (SHIFT pulsado al encenderlo, con USB).

Consejo: para que las escalas del Bard cuadren, los samples melódicos deberían estar afinados en Do.

## Usarlo en local

```sh
python3 -m http.server
# abre http://localhost:8000
```

Al usar módulos ES no funciona abriendo `index.html` con doble clic: necesita un servidor, o GitHub Pages.

## Estructura

- `index.html`, `style.css`: interfaz. `i18n.js`: textos en es / gl / en.
- `favicon.svg`, `icon-*.png`, `og.png`, `site.webmanifest`: iconos e imagen para compartir.
- `app.js`: editor, dig, grabación, reproducción, render con `OfflineAudioContext` y exportación.
- `dsp.js`: funciones puras (detección de golpes, dig, WAV, ZIP, nombres, presupuesto de memoria), sin dependencias.
