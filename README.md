# Project Genesis Clone

Lovable, vamos a clonar mi aplicación en este nuevo proyecto utilizando el archivo que te adjunto.

Toda la estructura obligatoria de vuestra plataforma (incluyendo el Shim de TanStack Start en src/routes/*, src/router.tsx, YA está incluida dentro del propio archivo. No tienes que inventar ni configurar ninguna ruta nueva.

⚠️ INSTRUCCIONES DE VOLCADO ESTRICTO (PENA DE CONFIGURACIÓN ROTA):

Extracción Literal 1:1: Desempaqueta y vuelca la totalidad de los archivos del Repomix respetando estrictamente su contenido y rutas (src/, package.json, tailwind.config.ts, src/index.css, etc.). No alteres lógica, no vacíes funciones ni renombres variables.

Instalación de Dependencias: Instala todas las dependencias reflejadas en el package.json adjunto (especialmente react-router-dom y las necesarias para el enrutamiento).

Credenciales de Supabase: Asegúrate de que el archivo src/integrations/supabase/client.ts utilice estas credenciales exactas únicamente como cliente frontend para invocar mis Edge Functions externas (supabase.functions.invoke()):

VITE_SUPABASE_URL = [https://sgonrrtqdcwyajsmufhs.supabase.co](https://sgonrrtqdcwyajsmufhs.supabase.co)

VITE_SUPABASE_ANON_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNnb25ycnRxZGN3eWFqc211ZmhzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMjMwMDgsImV4cCI6MjA5NDY5OTAwOH0.hNP086crbhu5UNjFwWI9eclKOobocu_QFz7hfwTnjNA

Realiza todo el proceso en un único turno. Adjunto el archivo XML a continuación para que comiences el volcado completo.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://trucvalencia.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/b324dd3a-1711-45fe-802f-22e48ab7baaf).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
