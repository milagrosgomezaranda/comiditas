# Comiditas

PWA estática, sin API de IA, tokens ni servicios pagos. La colección se guarda en IndexedDB en el dispositivo/navegador.

## Funciones
- Agregar comidas con foto de galería o cámara.
- Seleccionar varias imágenes; se crea una tarjeta por foto.
- Título, ingredientes buscables y categorías: Desayuno / Merienda, Almuerzo / Cena, Snacks / Postres.
- Marcar “También para Millá ♡”; la comida aparece en ambas colecciones sin duplicarla.
- Recetas con ingredientes y preparación.
- Editar y eliminar comidas/recetas.
- Diseño adaptable a móvil y modo instalable PWA.

## Privacidad y límites
No hay servidor ni cuenta. Fotos y textos se guardan localmente en el navegador. No se sincronizan entre dispositivos y se pueden perder si se borran los datos del navegador. Para evitar pérdida, usá la función de exportación/copia de seguridad cuando se agregue; esta versión inicial no incluye exportación todavía. Las fotos grandes pueden consumir el almacenamiento del navegador. No guardes información sensible.

## Publicar gratis con GitHub Pages
1. Creá un repositorio nuevo en GitHub llamado `comiditas`.
2. Subí todos los archivos de esta carpeta a la raíz del repositorio.
3. En GitHub, abrí **Settings → Pages**.
4. En **Build and deployment**, elegí **Deploy from a branch**, branch `main`, carpeta `/ (root)` y guardá.
5. Esperá a que GitHub publique el sitio y abrí la URL que te muestra Pages.
6. En iPhone, abrilo en Safari → botón Compartir → **Añadir a pantalla de inicio**.

## Notas
- Para cámara/galería y almacenamiento local se requiere abrir desde un contexto seguro (GitHub Pages usa HTTPS).
- No necesita variables de entorno, claves API, tokens ni backend.
- La fuente de Google es opcional; si no hay internet, el sistema usa una fuente local.
