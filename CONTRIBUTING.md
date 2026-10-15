# Colaborar en chop chop

¡Gracias por querer mejorar chop chop! Ideas, fallos, traducciones y código son bienvenidos.

## Cómo

- **Ideas y fallos:** abre un *issue* en GitHub contando qué esperabas y qué pasó (navegador, sistema y, si puedes, el tipo de audio).
- **Código o traducciones:** haz un *fork*, crea una rama y abre un *pull request*. Mejor cambios pequeños y con un objetivo claro.
- **Probarlo en local:** no hay build ni dependencias.

  ```sh
  python3 -m http.server
  # abre http://localhost:8000
  ```

## Reglas de la casa

- **Privacidad ante todo:** nada de analítica, cookies, servicios externos ni peticiones de red. Todo tiene que seguir ejecutándose en el navegador. La política de seguridad (`vercel.json`) bloquea cualquier conexión saliente y no se relaja.
- **Sin dependencias ni paso de build:** HTML, CSS y JavaScript tal cual.
- **Textos en los tres idiomas:** si añades texto visible, ponlo en `i18n.js` en castellano, galego e inglés (si no sabes alguno, dilo en el PR y lo completamos).

## Licencia y autoría

chop chop es de **StreetShark123**, que lo mantiene y decide qué cambios se incorporan.

Al enviar una contribución aceptas que se publique bajo la [licencia MIT](LICENSE) del proyecto. Puedes añadir tu nombre en el PR para que conste en el historial.

El nombre **chop chop** y su logo identifican el proyecto original. Puedes hacer *forks* y versiones propias con total libertad según la licencia MIT, pero, por favor, usa otro nombre para no confundirlas con el original.
