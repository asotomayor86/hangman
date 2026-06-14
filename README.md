# El Ahorcado — integrado con el Hub

Juego del ahorcado para dos jugadores (un dispositivo, por turnos), integrado con
el hub `one-page-to-rule-them-all`: las cuentas, la sala y el ranking viven en el
hub. El juego solo se ocupa de jugar y devolver el resultado.

## Cómo entrar

El hub crea la sala y abre el juego en `https://tu-juego.vercel.app/?sala=CÓDIGO`.
Sin código de sala el juego muestra error y enlace al hub.

## Flujo de una partida

Por ronda, los dos jugadores se autentican uno tras otro (login dual):

1. Elegir quién pone la palabra (y el tiempo: 1, 2 o 3 minutos).
2. Login del que pone la palabra. Se valida que es uno de los jugadores de la sala.
3. Escribir la palabra (campo oculto + verificación en Wiktionary).
4. Hand-off: el que ha puesto la palabra cierra sesión.
5. Login del que adivina. Se valida igual.
6. Adivinar la palabra con cuenta atrás.
7. Resultado y envío al hub (servidor a servidor).
8. Otra partida → vuelta al paso 1.

### Puntuación

Cara al hub se manda `win`/`loss` por jugador. La pantalla muestra además una
puntuación local de la sesión (no persistente, se reinicia al recargar):

| Resultado | Adivinador | El que pone |
|---|---|---|
| Adivina la palabra | +1 (`win`) | −1 (`loss`) |
| Sin vidas (no la adivina) | 0 (`loss`) | +1 (`win`) |
| Se acaba el tiempo | −1 (`loss`) | +1 (`win`) |

## Despliegue en Vercel

1. Subir este repo a GitHub.
2. Importarlo en Vercel.
3. Definir las variables de entorno (`Settings → Environment Variables`):

   ```
   HUB_URL=https://one-page-to-rule-them-all.vercel.app
   HUB_RESULT_SECRET=…          (lo da el admin del hub)
   AUTH_SIGNING_SECRET=…        (>= 32 caracteres, propio del juego)
   ```

4. Desplegar. La función `api/access.js` fija la cookie tras el login, y
   `api/result.js` reenvía el resultado al hub firmado con `HUB_RESULT_SECRET`.

## Registrar el juego en el hub

Antes de poder crear salas, el juego tiene que existir en la tabla `games` del
hub:

- `slug`: p. ej. `ahorcado`
- `name`: `Ahorcado`
- `url`: la URL pública de este juego en Vercel
- `players_min: 2`, `players_max: 2`

Y los usuarios que vayan a jugar deben tener acceso al juego (`user_games`).

## Desarrollo local

```bash
npm i -g vercel
vercel dev
```

`vercel dev` levanta el front estático y las funciones de `api/` en
`http://localhost:3000`. Necesita un `.env.local` con las variables de arriba.
Para probar el flujo de sala, crea una sala en el hub real y entra en
`http://localhost:3000/?sala=CÓDIGO`.

## Estructura

```
hangman/
├── index.html              # juego completo (HTML/CSS/JS vanilla)
├── api/
│   ├── _lib/
│   │   ├── auth.js         # cookie HMAC firmada
│   │   └── hub.js          # cliente del hub (servidor a servidor)
│   ├── access.js           # POST: fija sesión / DELETE: la cierra
│   └── result.js           # POST: reenvía el resultado al hub
├── package.json
├── vercel.json
├── .env.example
└── README.md
```
