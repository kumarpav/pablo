# Pablo — Multiplayer Card Game

Real-time multiplayer Pablo built with Node.js + Socket.io.

## Deploy to Railway (5 min)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) and sign in with GitHub
3. Click **New Project → Deploy from GitHub repo**
4. Select your repo — Railway auto-detects Node.js and deploys
5. Go to **Settings → Networking → Generate Domain**
6. Share that URL with friends and play!

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## How to play

- One player creates a lobby and shares the 5-letter room code
- Others enter the code to join (2–6 players)
- Host clicks Start Game
- Each player peeks at their cards 1 & 4 for 3 seconds — memorize them!
- On your turn: click the deck to draw, then swap with a hand card or discard
- Press **1–4** at any time to snap a matching card onto the discard pile
- Call **Pablo** when you think you have the lowest hand
- Lowest total score wins the round — first to hit the score limit loses

## Card values
- A = 1, 2–10 = face value, J/Q = 0, K = 13
- 7/8 = peek one of your own cards
- 9/10 = spy an opponent's card
- J/Q = blind swap with an opponent
