# Estado de validación

## Confirmado por inspección del proyecto

- `config.js` tiene una única URL de Supabase y una clave publicable.
- `ALLOW_SIGNUP` está en `false`.
- `supabase-setup.sql` define RLS para `meals` y `recipes` por `auth.uid() = user_id`.
- El bucket `meal-photos` está definido como privado.
- Las políticas de Storage restringen acceso a la carpeta cuyo primer segmento es el UID autenticado.
- El código usa URLs firmadas para mostrar fotos privadas.

## Validado localmente

- `node --check app.js`: OK.
- `node --check sw.js`: OK.
- Referencias DOM desde `app.js` hacia `index.html`: OK, sin IDs faltantes.

## Pendiente de prueba real

- despliegue de `auth-helper`;
- login con contraseña real;
- recuperación de contraseña por correo;
- SELECT/INSERT/UPDATE/DELETE con sesión autenticada;
- subida, lectura firmada y eliminación de fotos;
- sincronización real entre celular y computadora.

No se considera ninguna de esas pruebas aprobada hasta ejecutarla contra Supabase.
