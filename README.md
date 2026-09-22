# Fear & Greed France V3

Moteur de calcul automatique et stockage des données du Fear & Greed France.

- `scripts/update.js` calcule l'indice sans dépendance npm.
- `.github/workflows/update.yml` lance la mise à jour à 18 h 40 heure de Paris, du lundi au vendredi, et manuellement.
- `data/fear-greed.json` : dernier score.
- `data/history.json` : historique quotidien.
- `data/market.json` : actifs de référence.
- `index.html` : page OVH lisant les JSON GitHub.

URL prévue :
`https://raw.githubusercontent.com/4ronan/fear-greed-france-data/main/data/fear-greed.json`

Yahoo Chart est un endpoint non officiel ; GDELT reste facultatif.
