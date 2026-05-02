# ⚡ Thor V2 - Sécurité & Rug-Guard

## 1. Rug-Guard (Anti-Rug)
*   **Liquidity Drop Protection** : Si la liquidité chute de plus de 40% par rapport à l'entrée, le bot vend tout via un bundle Jito (priorité absolue).
*   **RugCheck Integration** : Analyse le score de risque via l'API RugCheck.xyz.
*   **LP Burn Analysis** : Vérifie que >95% des jetons de liquidité sont brûlés ou verrouillés.

## 2. Protection des Fonds
*   **Daily Loss Circuit Breaker** : Calcul glissant du PnL réalisé sur 24h. Si Perte > 5 SOL (configurable), arrêt des achats.
*   **Jito Bundles** : Utilisation de Jito pour les ventes d'urgence afin d'éviter d'être "front-run" ou de voir sa transaction échouer lors d'un crash de token.

## 3. Analyse des Baleines (Whale Watcher)
*   **Monitoring Top Holders** : Surveille les 10 plus gros portefeuilles d'un jeton détenu.
*   **Panic Sell Condition** : Si 3 baleines vendent plus de 30% de leur bag en moins de 15 minutes, le bot sort automatiquement du trade.
