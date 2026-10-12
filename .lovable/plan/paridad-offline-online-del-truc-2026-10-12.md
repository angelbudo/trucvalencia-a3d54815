# Paridad offline/online del Truc

## Objetivo
Hacer que la partida online use exactamente el mismo tablero y reglas visibles que la partida local, preservar las cartas reales durante la sincronización, mantener la regla conservadora del envido y dejar el chat de texto libre de mensajes automáticos.

## Cambios

1. **Un único tablero visual**
   - Mantener `TrucBoard` como única implementación de mesa para ambos modos.
   - Extraer la preparación común de propiedades visuales para que local y online alimenten el tablero con el mismo contrato de nombres, avatares, mensajes, cartas, animaciones y transiciones.
   - Corregir cualquier desplazamiento dependiente del modo; las burbujas se anclarán únicamente a la posición relativa del asiento dentro de `TrucBoard`.
   - Conservar solo como extensiones online los datos que no existen localmente: presencia, perfiles, moderación y sincronización del reloj.

2. **Contrato canónico de cartas**
   - Definir normalización/validación pura para cartas y estados recibidos del servicio online, preservando todas las propiedades recibidas y reconstruyendo únicamente valores derivados ausentes desde `rank` y `suit`.
   - Aplicar esa normalización tanto al estado completo como a `getMyHand`, cartas jugadas y cartas tapadas; los placeholders privados seguirán siendo reversos sin inventar un As de Oros.
   - Unificar el cálculo de envido en las cartas originales de la ronda (mano restante + cartas jugadas válidas), con el mismo tratamiento para cartas tapadas en local y online.
   - Añadir pruebas de regresión para As de Oros, carta tapada, mano recuperada y JSON online.

3. **Regla conservadora compartida**
   - Consolidar la comprobación “conservador, tercer jugador de la primera baza, 30 o menos” en una función TypeScript pura compartida por las rutas de decisión.
   - Bloquear envido y subida salvo orden explícita del compañero; con 31 o más se conserva el flujo normal.
   - Cubrir con pruebas las posiciones reales mediante `currentTrick.cards.length`.
   - Preparar la misma fuente para el módulo desplegable del bot online. El directorio `supabase/functions` no está disponible en este proyecto, por lo que el código backend se entregará como módulo listo para copiar/desplegar sin duplicar manualmente la regla.

4. **Chat online solo manual**
   - Marcar y aceptar únicamente filas de `room_text_chat` que representen texto escrito por una persona.
   - Excluir al cargar y en tiempo real cualquier aviso de sistema, desarrollo de partida, cartas o cantes.
   - Mantener las frases tácticas en sus bocadillos temporales del tablero (`room_chat`), separadas del historial de texto manual.

5. **Verificación**
   - Ejecutar comprobación de tipos y tests selectivos del motor/cartas/chat.
   - Verificar en el navegador una partida local y una online: misma geometría del tablero, animación de carta, posición de burbujas y chat manual limpio.
   - Confirmar que la preview termina sin errores de compilación ni errores de ejecución.

## Detalles técnicos
- No se crearán rutas nuevas ni se cambiarán dependencias.
- La privacidad online se mantiene: las manos rivales continúan enmascaradas.
- Los datos específicos de red se adaptan antes de llegar al tablero; el componente visual no tendrá ramas distintas para local y online.
- Se documentará en `AGENTS.md` la fuente compartida de verdad para cartas y decisiones del bot.
