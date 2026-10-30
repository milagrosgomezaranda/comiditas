# Comiditas privada

Aplicación estática publicada en GitHub Pages. Supabase maneja autenticación, base de datos, fotos privadas y el pequeño helper de acceso. No hay claves `service_role` en el frontend.

## Estado de esta versión

Se conserva el proyecto existente y se agregan:

- login de un solo campo de contraseña;
- sesión persistente;
- recuperación de contraseña por correo;
- comidas simples sin ingredientes obligatorios;
- recetas con foto, ingredientes, preparación, tiempo, porciones y categoría opcionales;
- Favoritas;
- sección Millá ♡;
- fotos ampliables con navegación;
- carga desde galería o cámara;
- edición y eliminación;
- service worker actualizado.

## Seguridad del login simplificado

El correo de la cuenta NO se guarda en `config.js` ni en el repositorio público. Se guarda como secreto de una Supabase Edge Function llamada `auth-helper`.

La función recibe solamente la contraseña y autentica contra Supabase Auth. El navegador recibe la sesión normal de Supabase y la persiste localmente.

`ALLOW_SIGNUP` permanece en `false` y el registro público debe seguir desactivado en Supabase Authentication.

## Cambio de base de datos

NO vuelvas a ejecutar `supabase-setup.sql`.

Esta versión incluye `supabase-migration-v2.sql`, una migración aditiva que solamente agrega columnas para favoritas y datos de recetas. No desactiva RLS, no elimina políticas y no recrea tablas.

## Función auth-helper

Archivo:

`supabase/functions/auth-helper/index.ts`

Necesita un único secreto:

`COMIDITAS_LOGIN_EMAIL=<correo de la cuenta ya creada>`

El correo queda en Supabase, no en GitHub.

La recuperación de contraseña redirige a:

`https://milagrosgomezaranda.github.io/comiditas/`

## Privacidad

- `meals` y `recipes` siguen protegidas por RLS.
- `meal-photos` sigue siendo privado.
- Las imágenes se leen mediante URLs firmadas temporales.
- La clave publicable de Supabase puede estar en el frontend.
- Nunca publiques una `service_role` ni una contraseña.

## Validación realizada sobre el ZIP

Se verificó localmente:

- sintaxis JavaScript de `app.js`;
- sintaxis JavaScript de `sw.js`;
- todas las referencias a IDs del DOM usadas por `app.js` existen en `index.html`;
- no se agregó ninguna `service_role` ni correo/contraseña al frontend;
- el proyecto conserva la URL y la clave publicable existentes.

No se pudo ejecutar una prueba real contra el proyecto Supabase desde este entorno porque la red del contenedor no resuelve el host externo. Por eso no se afirma que login, CRUD o Storage estén validados en vivo todavía.
