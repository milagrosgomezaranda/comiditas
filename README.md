# Comiditas privada: cuenta personal + sincronización

Interfaz estática publicada en GitHub Pages; autenticación, base de datos y fotos privadas en Supabase. No usa IA, tokens de IA ni claves secretas de servidor. Los planes gratuitos tienen límites y condiciones que pueden cambiar.

## A. Crear el backend privado
1. Entrá a https://supabase.com/ y creá un proyecto.
2. En **SQL Editor → New query**, copiá y ejecutá todo `supabase-setup.sql`.
3. En **Authentication → URL Configuration**, poné como Site URL la dirección de GitHub Pages, por ejemplo `https://TU-USUARIO.github.io/comiditas/`, y agregala también en Redirect URLs.
4. En **Project Settings → API** (o Connect), copiá la Project URL y la clave publicable/anon. Nunca uses una `service_role` ni una clave secreta en la web.

## B. Conectar y crear TU cuenta
1. Abrí `config.js` y reemplazá los dos valores `PEGAR_...` con la URL y la clave publicable/anon de Supabase. Dejá `ALLOW_SIGNUP: true` solo para el alta inicial.
2. Subí los archivos de esta carpeta a la raíz de tu repositorio `comiditas`, reemplazando los existentes. Incluí `config.js` y `supabase-setup.sql`.
3. Esperá que GitHub Pages termine de publicar y abrí la web.
4. Elegí **Crear cuenta**, registrate con tu correo y contraseña y confirmá el correo si Supabase lo solicita. Después iniciá sesión.

## C. Cerrar el registro para que sea solo tu cuenta
Esto es obligatorio; ocultar el botón de registro por sí solo NO es seguridad del servidor.
1. En Supabase, entrá a **Authentication → Settings** (en algunas interfaces, Authentication → Providers → Email).
2. Desactivá **Allow new users to sign up / Enable signups** y guardá. Así se bloquean nuevas altas en el backend.
3. En el archivo `config.js`, cambiá `ALLOW_SIGNUP: true` a `ALLOW_SIGNUP: false` y volvé a subir ese archivo a GitHub.
4. Probá cerrar sesión y volver a entrar con tu cuenta. No compartas la contraseña.

## Privacidad
- Las tablas tienen Row Level Security (RLS): cada cuenta solo puede leer y modificar sus propias filas.
- El bucket `meal-photos` es privado; las fotos se muestran con URLs firmadas temporales, no URLs públicas.
- La URL y la clave publicable/anon son aptas para el cliente. La seguridad real depende de las políticas SQL y del bucket privado. Nunca publiques contraseñas ni claves `service_role`.
- El repositorio de GitHub puede ser público, por lo que el código será visible. Eso NO publica las fotos ni los registros protegidos por Supabase.
- La privacidad técnica no concede derechos para reutilizar imágenes ajenas.

## Límites y datos existentes
- La app sincroniza entre dispositivos al iniciar sesión con la misma cuenta.
- Fotos y registros guardados en la versión anterior local no se migran automáticamente. Conservá la versión anterior hasta confirmar que la nube funciona y volvé a cargar o migrar manualmente las imágenes necesarias.
- El almacenamiento y la base de datos gratuitos tienen cuotas; las imágenes grandes consumen espacio.
