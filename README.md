# chochop ✂

Trocea cualquier audio en samples listos para el **Bastl Kastle 2 Wave Bard**.

Es una página web estática: se abre en el navegador y todo el audio se procesa en local, sin subir nada a ningún sitio.

## Qué hace

- Abre WAV, MP3, AIFF, OGG, FLAC o M4A (lo que decodifique tu navegador).
- Muestra la onda con zoom y una vista general para moverte.
- Crea cortes arrastrando sobre la onda y ajústalos moviendo sus bordes.
- Trocea automáticamente **por golpes** (con sensibilidad) o **en partes iguales**. Si hay un corte seleccionado, trocea solo dentro de él.
- Ajustes por corte: nombre de 8 caracteres, mono/estéreo, velocidad (×1, ×0,75, ×0,5, ×0,25, estilo cinta), fade in/out, normalizar e invertir.
- Te deja escuchar cada corte ya procesado.
- Un medidor indica cuánta memoria del Wave Bard ocupas (≈ 89 s en mono / 44 s en estéreo a 44,1 kHz).
- Exporta un ZIP con WAV de 16 bits a 44,1 kHz, en carpetas de 8 (`banco1`, `banco2`…) con nombres válidos de 8 caracteres.

## Atajos

| Tecla | Acción |
| --- | --- |
| Arrastrar | Crear corte |
| Alt + arrastrar | Crear corte encima de otro |
| Espacio | Escuchar el corte seleccionado (o el original desde el cursor) |
| Supr / Retroceso | Borrar el corte seleccionado |
| ← → | Corte anterior / siguiente |
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

- `index.html`, `style.css`: interfaz.
- `app.js`: editor, reproducción, render con `OfflineAudioContext` y exportación.
- `dsp.js`: funciones puras (detección de golpes, WAV, ZIP, nombres, presupuesto de memoria), sin dependencias.
